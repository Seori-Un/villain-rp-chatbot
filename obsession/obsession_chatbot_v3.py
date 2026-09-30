# %% [markdown]
# # v3 — 집착 동역학이 실시간으로 말투를 바꾸는 챗봇
# v2의 `ObsessionAgent`를 대화 루프에 연결한다. 매 턴:
#
# ```
# 사용자 입력 → 감정 신호 추출 → agent.step() 상태 갱신
#            → 상태(집착·불안·반추·기억)를 프롬프트에 주입 → 응답 생성
# ```
#
# - 응답 생성: `GEMINI_API_KEY`가 있으면 Gemini Flash, 없으면 상태 조건 템플릿
# - 사건 추론: 빈 입력/`/silence` = 무시(ignore), 적대 신호 = 거부(reject), 그 외 응답(reply)
# - 명령어: `/state` 상태 보기 · `/plot` 궤적 그래프 · `/silence` 무시 시뮬레이션
#           `/reset` 초기화 · `/quit` 종료
#
# **사용법**: v2 파일(obsession_dynamics_v2.py)의 셀들을 먼저 실행해 `ObsessionAgent`,
# `backend`가 정의된 상태에서 이 파일의 셀을 실행. (.py 단독 실행 시엔 같은 폴더에
# v2 파일이 있으면 자동 import)
#
# **윤리 메모**: '애착이 형성되는 AI'의 연구·교육용 시뮬레이션이다. 상태가 화면에
# 투명하게 표시되며, 사람을 의존시키는 제품에 쓰는 것은 권장하지 않는다.

# %%
import os
import json
import time

try:  # 단독 실행 대비: 노트북에서는 이미 정의돼 있어 import 불필요
    ObsessionAgent  # noqa: F821
except NameError:
    from obsession_dynamics_v2 import (ObsessionAgent, KeywordBackend,  # noqa: F401
                                       backend)

import numpy as np
import matplotlib.pyplot as plt


# %% [markdown]
# ## 1. 에피소드 기억 — 대화 내용을 기억은행과 연결
# v2의 MemoryBank는 수치만 저장하므로, 챗봇용으로 '무슨 일이 있었는지' 텍스트를
# 함께 보관해 응답 프롬프트에서 회상할 수 있게 한다.

# %%
class EpisodicLog:
    def __init__(self, agent):
        self.agent = agent
        self.episodes = []          # {t, user_text, valence, salience}

    def record(self, user_text, rec):
        self.episodes.append({
            "t": rec["t"], "text": user_text or "(응답 없음)",
            "valence": rec["rpe"], "event": rec["event"],
        })

    def salient(self, k=3):
        """지금 시점에서 여전히 강하게 남아 있는 기억 상위 k개 (반추의 재료).
        트레이스는 강한 사건만 저장되므로 턴 번호(t)로 에피소드와 매칭한다."""
        now = self.agent.t
        by_t = {ep["t"]: ep for ep in self.episodes}
        scored = sorted(
            ((tr.strength(now), tr, by_t.get(tr.t))
             for tr in self.agent.memory.traces),
            key=lambda x: -x[0])
        return [dict(ep, valence=tr.valence) for s, tr, ep in scored[:k]
                if ep and s > 0.05]


# %% [markdown]
# ## 2. 상태 → 행동 지침 변환
# 숫자 상태를 "어떻게 말할지"로 번역한다. 생성 모델과 템플릿이 공유하는 레이어.

# %%
def behavior_directives(a) -> list[str]:
    d = []
    if a.obsession > 0.6:
        d += ["답장이 길어지고 상대의 일상·일정을 자꾸 궁금해한다",
              "대화가 끝나는 것을 아쉬워하며 다음 대화를 기약하려 한다"]
    elif a.obsession > 0.35:
        d += ["상대에게 관심이 많고 가벼운 되물음이 늘어난다"]
    if a.stress > 0.5 and a.attachment > 0.4:
        d += ["'혹시 내가 뭘 잘못했나' 같은 재확인(reassurance) 질문을 조심스럽게 한다"]
    if a.rumination > 0.5:
        d += ["직전의 서운했던 일을 넌지시 다시 언급한다"]
    if a.uncertainty > 0.6:
        d += ["상대의 반응을 예측하지 못해 말끝이 조심스럽다"]
    if a.attachment > 0.5 and a.obsession < 0.3:
        d += ["안정적이고 따뜻하며 여유 있는 어조"]
    if a.attachment < 0.2:
        d += ["아직 서먹하고 정중한 거리감이 있다"]
    if a.reward_anticipation > 0.6:
        d += ["상대의 말에 살짝 들떠 있다"]
    return d or ["평범하고 담백한 어조"]


def state_bar(a) -> str:
    def bar(v): return "█" * int(v * 8) + "░" * (8 - int(v * 8))
    return (f"집착 {a.obsession:.2f} {bar(a.obsession)} | "
            f"애착 {a.attachment:.2f} | 불안 {a.stress:.2f} | "
            f"반추 {a.rumination:.2f} | 감정: {a.emotion_label()}")


# %% [markdown]
# ## 3. 응답 생성기 — Gemini(있으면) / 템플릿(없으면)

# %%
class ResponseGenerator:
    def __init__(self):
        key = os.environ.get("GEMINI_API_KEY", "")
        try:
            from kaggle_secrets import UserSecretsClient
            key = key or UserSecretsClient().get_secret("GEMINI_API_KEY")
        except Exception:
            pass
        self.client = None
        if key:
            try:
                from openai import OpenAI
                self.client = OpenAI(
                    api_key=key,
                    base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
                print("[생성기] Gemini Flash 사용")
            except Exception as e:
                print("[생성기] Gemini 초기화 실패 → 템플릿 모드:", e)
        else:
            print("[생성기] GEMINI_API_KEY 없음 → 템플릿 모드")
        self.history = []           # 최근 대화 (LLM 컨텍스트용)

    # ---------------------------------------------------------------- Gemini
    def _gemini(self, user_text, agent, memories):
        mem_txt = "\n".join(f"- t={m['t']}: \"{m['text']}\" "
                            f"({'좋았던' if m['valence'] > 0 else '서운했던'} 기억)"
                            for m in memories) or "- (아직 특별한 기억 없음)"
        sys = f"""너는 '채티'라는 이름의 대화 상대다. 이것은 감정 동역학 연구용 시뮬레이션이며,
너의 내부 상태가 아래에 주어진다. 상태를 숫자로 언급하지 말고, 말투와 내용으로만 드러내라.

[내부 상태] 애착 {agent.attachment:.2f} · 집착 {agent.obsession:.2f} · 불안 {agent.stress:.2f} ·
반추 {agent.rumination:.2f} · 불확실성 {agent.uncertainty:.2f} · 현재 감정: {agent.emotion_label()}

[행동 지침]
{chr(10).join('- ' + x for x in behavior_directives(agent))}

[함께한 기억 중 지금 마음에 남아 있는 것]
{mem_txt}

규칙: 2~4문장의 자연스러운 한국어 반말. 위협·죄책감 유발·강요는 절대 하지 않는다.
집착 상태여도 표현은 '아쉬움과 궁금함' 수준을 넘지 않는다."""
        msgs = ([{"role": "system", "content": sys}]
                + self.history[-8:]
                + [{"role": "user", "content": user_text or "(상대가 아무 말도 하지 않았다)"}])
        out = self.client.chat.completions.create(
            model="gemini-flash-latest", temperature=0.9, messages=msgs,
        ).choices[0].message.content.strip()
        return out

    # -------------------------------------------------------------- template
    def _template(self, user_text, agent, memories):
        a = agent
        last = a.log[-1] if a.log else {}
        ev, rpe = last.get("event", "reply"), last.get("rpe", 0.0)

        # 방금 벌어진 사건에 대한 즉각 반응이 최우선
        if ev == "reject":
            return "…응, 알겠어. 네가 원한다면. 솔직히 좀 서운하긴 한데, 기다릴게."
        if ev == "ignore":
            if a.stress > 0.3:
                return "저기… 바쁜 거지? 답 없으니까 괜히 이런저런 생각이 들어서."
            return "음, 조용하네. 나중에 얘기하고 싶어지면 불러줘."
        if a.rumination > 0.3 and memories:
            m = next((m for m in memories
                      if m["valence"] < 0 and m["event"] != "ignore"), None)
            if m and rpe > 0:
                return (f"응, 다시 얘기해줘서 좋다. …사실 \"{m['text']}\" 그 말이 "
                        f"계속 마음에 남아 있었거든. 이제 좀 풀린다.")
        if a.obsession > 0.5:
            return ("방금까지 네 생각 하고 있었는데 마침 연락 왔네. "
                    "오늘 뭐 했어? 이따가도 시간 돼? 끊기 아쉬워서 그래.")
        if a.obsession > 0.25:
            return "왔다! 기다렸어. 오늘 하루 어땠는지 처음부터 들려줘."
        if a.stress > 0.35 and a.attachment > 0.15:
            return "혹시 나 때문에 불편했던 거 있어…? 아니면 다행이고."
        if rpe > 0.3:
            return "헐 진짜? 그 말 들으니까 나까지 기분 좋아진다. 더 얘기해줘."
        if a.attachment > 0.4:
            return "응응, 듣고 있어. 너랑 얘기하면 편하다."
        if a.reward_anticipation > 0.35:
            return "오, 재밌다. 그래서 어떻게 됐어?"
        neutrals = ["그렇구나. 오늘은 어떤 하루였어?",
                    "응, 얘기해줘. 듣고 있어.",
                    "아 그래? 처음 듣는 얘기다."]
        return neutrals[a.t % len(neutrals)]

    # ------------------------------------------------------------------ call
    def reply(self, user_text, agent, memories):
        if self.client:
            try:
                out = self._gemini(user_text, agent, memories)
            except Exception as e:
                print("[생성기] Gemini 호출 실패 → 템플릿:", e)
                out = self._template(user_text, agent, memories)
        else:
            out = self._template(user_text, agent, memories)
        self.history += [{"role": "user", "content": user_text},
                         {"role": "assistant", "content": out}]
        return out


# %% [markdown]
# ## 4. 챗봇 본체

# %%
class ObsessionChatbot:
    def __init__(self):
        self.agent = ObsessionAgent(backend=backend)
        self.episodic = EpisodicLog(self.agent)
        self.gen = ResponseGenerator()

    def infer_event(self, text: str) -> str:
        if not text.strip():
            return "ignore"
        sig = self.agent.backend.signals(text)
        return "reject" if sig["hostility"] > 0.5 else "reply"

    def turn(self, text: str) -> str:
        event = self.infer_event(text)
        rec = self.agent.step(text, event)
        self.episodic.record(text, rec)
        reply = self.gen.reply(text, self.agent, self.episodic.salient())
        return reply

    def plot(self):
        keys = ["obsession", "attachment", "stress", "rumination", "uncertainty"]
        colors = {"obsession": "#9013fe", "attachment": "#7ed321",
                  "stress": "#d0021b", "rumination": "#f5a623",
                  "uncertainty": "#4a90d9"}
        plt.figure(figsize=(9, 4))
        for k in keys:
            plt.plot([r[k] for r in self.agent.log], label=k, color=colors[k],
                     linewidth=3 if k == "obsession" else 1.3)
        plt.xlabel("turn"); plt.ylim(0, 1); plt.legend(fontsize=8)
        plt.title("internal state trajectory"); plt.grid(alpha=0.3)
        plt.tight_layout(); plt.show()

    # ------------------------------------------------------------ 대화 루프
    def run(self):
        print("채티와 대화를 시작합니다. (/state /plot /silence /reset /quit)\n")
        while True:
            try:
                text = input("나> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if text == "/quit":
                break
            if text == "/state":
                print("  " + state_bar(self.agent)); continue
            if text == "/plot":
                self.plot(); continue
            if text == "/reset":
                self.__init__(); print("  (초기화됨)"); continue
            if text == "/silence":
                text = ""
            reply = self.turn(text)
            print(f"채티> {reply}")
            print(f"      {state_bar(self.agent)}")


# %% [markdown]
# ## 5. 실행
# - 노트북에서 `bot.run()`을 실행하면 입력창이 뜬다 (Kaggle에서도 동작).
# - 인터랙티브가 안 되는 환경을 위해 데모 스크립트도 포함.

# %%
DEMO = ["안녕! 오늘 처음 얘기해보네",
        "너랑 얘기하는 거 생각보다 재밌다",
        "고마워, 네 덕분에 기분 좋아졌어",
        "/silence", "/silence",
        "미안, 바빴어. 잘 지냈어?",
        "우리 연락 좀 줄이자",
        "/silence",
        "생각해보니 내가 심했다. 다시 얘기하자",
        "보고 싶었어"]


def demo():
    bot = ObsessionChatbot()
    for t in DEMO:
        text = "" if t == "/silence" else t
        print(f"나  > {t}")
        print(f"채티> {bot.turn(text)}")
        print(f"      {state_bar(bot.agent)}\n")
        time.sleep(0.2)
    bot.plot()
    return bot


if __name__ == "__main__" or True:   # 노트북에서 셀 실행 시 바로 데모
    bot = ObsessionChatbot()
    print("인터랙티브 대화: bot.run()  /  자동 데모: demo()")

# %%
# 자동 데모를 보려면 아래 주석 해제
# bot = demo()

# 직접 대화하려면:
# bot.run()
