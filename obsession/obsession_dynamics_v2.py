"""Portable obsession dynamics (keyword backend) for 채티 chatbot.

Implements the API expected by obsession_chatbot_v3:
ObsessionAgent, KeywordBackend, backend.
Dynamics follow the attachment loop in the KOTE notebook (RPE, oxytocin,
cortisol, drive, obsession) plus rumination/uncertainty fields used by v3.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


def clip(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, float(v)))


class KeywordBackend:
    WARM = ("좋아", "고마", "보고 싶", "행복", "재밌", "사랑", "보고싶", "편해", "고마워", "미안")
    COLD = ("싫", "그만", "지긋지긋", "연락하지", "연락 좀 줄", "차단", "꺼져", "싫어", "귀찮")
    HOSTILE = ("꺼져", "증오", "혐오", "닥쳐", "죽", "차단", "지긋지긋", "연락하지 마", "연락 줄여")

    def signals(self, text: str) -> dict:
        t = text or ""
        warm = sum(1 for k in self.WARM if k in t)
        cold = sum(1 for k in self.COLD if k in t)
        host = sum(1 for k in self.HOSTILE if k in t)
        affection = clip(0.25 + 0.2 * warm - 0.15 * cold)
        anxiety = clip(0.15 + 0.12 * (1 if ("바쁜" in t or "늦" in t or "미안" in t) else 0))
        hostility = clip(0.15 * host + (0.7 if cold and not warm else 0.0))
        rejection = clip(hostility)
        return {
            "affection": affection,
            "anxiety": anxiety,
            "hostility": hostility,
            "rejection": rejection,
        }


backend = KeywordBackend()


@dataclass
class MemoryTrace:
    t: int
    valence: float
    salience: float

    def strength(self, now: int) -> float:
        age = max(0, now - self.t)
        return self.salience * math.exp(-0.08 * age)


@dataclass
class MemoryBank:
    traces: list = field(default_factory=list)

    def add(self, t: int, valence: float, salience: float):
        if salience < 0.05:
            return
        self.traces.append(MemoryTrace(t=t, valence=valence, salience=clip(salience, 0, 2)))
        if len(self.traces) > 40:
            self.traces = self.traces[-40:]


class ObsessionAgent:
    def __init__(self, backend=None):
        self.backend = backend or KeywordBackend()
        self.t = 0
        self.dopamine = 0.3
        self.attachment = 0.1  # oxytocin
        self.stress = 0.1  # cortisol
        self.memory_mass = 0.0
        self.drive = 0.2
        self.obsession = 0.0
        self.rumination = 0.0
        self.uncertainty = 0.35
        self.reward_anticipation = 0.2
        self.expected_reward = 0.2
        self.memory = MemoryBank()
        self.log = []

    def emotion_label(self) -> str:
        d, c, o, x = self.dopamine, self.stress, self.attachment, self.obsession
        if c > 0.6 and o > 0.4:
            return "분리불안"
        if x > 0.55 and d < 0.3:
            return "갈망(집착)"
        if self.rumination > 0.55:
            return "반추"
        if d > 0.5 and o > 0.3:
            return "행복/유대감"
        if c > 0.5:
            return "스트레스"
        if d > 0.5:
            return "기쁨"
        return "평온"

    def step(self, utterance: str, event: str = "reply") -> dict:
        self.t += 1
        sig = self.backend.signals(utterance or "")
        aff, rej = sig["affection"], sig["rejection"]
        value = (aff - rej) * (1.0 + 0.8 * self.obsession)
        R = {"reply": value, "ignore": -0.3, "reject": -1.0}.get(event, value)

        rpe = R - self.expected_reward
        self.expected_reward += 0.2 * rpe
        self.dopamine = clip(0.85 * self.dopamine + 0.5 * max(rpe, 0))
        self.attachment = clip(0.98 * self.attachment + 0.15 * max(R, 0) * aff)
        loss = max(-rpe, 0)
        self.stress = clip(0.80 * self.stress + 0.9 * loss * (0.3 + self.attachment))
        self.memory_mass = clip(self.memory_mass + 0.3 * abs(rpe) * (1 + self.attachment), 0, 3)
        self.drive = clip(
            0.9 * self.drive + 0.6 * self.stress * self.attachment - 0.2 * max(R, 0)
        )
        self.obsession = clip(
            0.5 * self.attachment + 0.3 * self.drive + 0.2 * (self.memory_mass / 3)
        )
        # rumination rises after ignore/reject, fades on warm reply
        if event in ("ignore", "reject") or rpe < -0.15:
            self.rumination = clip(0.85 * self.rumination + 0.25 + 0.2 * self.stress)
        else:
            self.rumination = clip(0.75 * self.rumination - 0.05 * max(rpe, 0))
        self.uncertainty = clip(
            0.9 * self.uncertainty
            + (0.2 if event == "ignore" else 0)
            + (0.25 if event == "reject" else 0)
            - (0.15 if event == "reply" and rpe > 0 else 0)
        )
        self.reward_anticipation = clip(
            0.85 * self.reward_anticipation + 0.3 * max(rpe, 0) + 0.1 * self.obsession
        )

        salience = abs(rpe) * (1 + self.attachment)
        self.memory.add(self.t, valence=rpe, salience=salience)

        rec = dict(
            t=self.t,
            dopamine=self.dopamine,
            attachment=self.attachment,
            stress=self.stress,
            rumination=self.rumination,
            uncertainty=self.uncertainty,
            reward_anticipation=self.reward_anticipation,
            obsession=self.obsession,
            rpe=rpe,
            event=event,
            emotion=self.emotion_label(),
        )
        self.log.append(rec)
        return rec
