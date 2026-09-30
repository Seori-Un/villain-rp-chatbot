/**
 * 채티 v2.1 — 집착 동역학 롤플레이
 * Secrets: GEMINI_API_KEY (optional)
 * Upgrades: tightened intent, stronger reject dynamics, richer templates,
 *           Gemini gets explicit intent, session snapshot restore
 */

import { classifyIntent, normalizeUtterance } from "./intent.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** @type {Map<string, {bot: ObsessionChatbot, touched: number}>} */
const SESSIONS = new Map();
const MAX_SESSIONS = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/health") {
      return json({
        ok: true,
        bot: "채티",
        version: "obsession-v2.1",
        gemini: Boolean(env.GEMINI_API_KEY),
        sessions: SESSIONS.size,
      });
    }
    if (url.pathname === "/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    if (url.pathname === "/state" && request.method === "POST") {
      return handleState(request);
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      return handleReset(request);
    }
    return json({ error: "not_found", try: ["/health", "POST /chat"] }, 404);
  },
};

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  let message = (body.message || body.text || "").toString();
  if (message === "/silence") message = "";
  const sessionId = (body.session_id || body.sessionId || crypto.randomUUID()).toString();
  const bot = getSession(sessionId, body.snapshot);

  const cmd = message.trim();
  if (cmd === "/state") {
    return json({
      reply: stateBar(bot.agent),
      session_id: sessionId,
      state: snapshot(bot.agent),
      snapshot: bot.serialize(),
      mode: "state",
    });
  }
  if (cmd === "/reset") {
    const fresh = new ObsessionChatbot();
    SESSIONS.set(sessionId, { bot: fresh, touched: Date.now() });
    return json({
      reply: "초기화했어. …처음부터 다시, 나한테만 말해줘.",
      session_id: sessionId,
      state: snapshot(fresh.agent),
      snapshot: fresh.serialize(),
      mode: "reset",
    });
  }

  const reply = await bot.turn(message, env);
  return json({
    reply,
    session_id: sessionId,
    state: snapshot(bot.agent),
    snapshot: bot.serialize(),
    intent: bot.lastIntent,
    mode: bot.gen.mode,
  });
}

async function handleState(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const sessionId = (body.session_id || "").toString();
  const bot = getSession(sessionId, body.snapshot);
  if (!sessionId) return json({ error: "no_session" }, 404);
  return json({
    session_id: sessionId,
    state: snapshot(bot.agent),
    bar: stateBar(bot.agent),
    snapshot: bot.serialize(),
  });
}

async function handleReset(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const sessionId = (body.session_id || crypto.randomUUID()).toString();
  const fresh = new ObsessionChatbot();
  SESSIONS.set(sessionId, { bot: fresh, touched: Date.now() });
  return json({ session_id: sessionId, state: snapshot(fresh.agent), snapshot: fresh.serialize() });
}

function getSession(id, snap) {
  const now = Date.now();
  if (SESSIONS.has(id)) {
    const row = SESSIONS.get(id);
    row.touched = now;
    return row.bot;
  }
  if (SESSIONS.size >= MAX_SESSIONS) {
    let oldestId = null;
    let oldestT = Infinity;
    for (const [k, v] of SESSIONS) {
      if (v.touched < oldestT) {
        oldestT = v.touched;
        oldestId = k;
      }
    }
    if (oldestId) SESSIONS.delete(oldestId);
  }
  const bot = new ObsessionChatbot();
  if (snap && typeof snap === "object") {
    try {
      bot.restore(snap);
    } catch {
      /* ignore bad snapshot */
    }
  }
  SESSIONS.set(id, { bot, touched: now });
  return bot;
}

function snapshot(a) {
  return {
    t: a.t,
    obsession: round(a.obsession),
    attachment: round(a.attachment),
    stress: round(a.stress),
    rumination: round(a.rumination),
    uncertainty: round(a.uncertainty),
    emotion: a.emotionLabel(),
  };
}

function round(v) {
  return Math.round(v * 100) / 100;
}

function stateBar(a) {
  const bar = (v) => "█".repeat(Math.floor(v * 8)) + "░".repeat(8 - Math.floor(v * 8));
  return `집착 ${a.obsession.toFixed(2)} ${bar(a.obsession)} | 애착 ${a.attachment.toFixed(2)} | 불안 ${a.stress.toFixed(2)} | 반추 ${a.rumination.toFixed(2)} | 감정: ${a.emotionLabel()}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function clip(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}

function pick(arr, seed) {
  return arr[Math.abs(seed | 0) % arr.length];
}

/* -------------------- dynamics -------------------- */

class KeywordBackend {
  signals(text) {
    const t = normalizeUtterance(text);
    const intent = classifyIntent(t);
    let affection = 0.28;
    let anxiety = 0.12;
    let hostility = 0.0;
    if (intent === "warm") affection += 0.35;
    if (intent === "ask_me" || intent === "ask") affection += 0.14;
    if (intent === "chat" && t.length > 10) affection += 0.08;
    if (intent === "repair") {
      affection += 0.1;
      anxiety += 0.15;
    }
    if (intent === "late") anxiety += 0.28;
    if (intent === "rival") {
      anxiety += 0.32;
      hostility += 0.2;
    }
    if (intent === "reject") {
      hostility = 0.9;
      anxiety += 0.4;
      affection = Math.min(affection, 0.12);
    }
    if (intent === "silence") {
      affection = 0.05;
      anxiety += 0.28;
    }
    affection = clip(affection);
    anxiety = clip(anxiety);
    hostility = clip(hostility);
    return { affection, anxiety, hostility, rejection: hostility, intent };
  }
}

class MemoryTrace {
  constructor(t, valence, salience, text) {
    this.t = t;
    this.valence = valence;
    this.salience = salience;
    this.text = text || "";
  }
  strength(now) {
    return this.salience * Math.exp(-0.08 * Math.max(0, now - this.t));
  }
}

class ObsessionAgent {
  constructor(backend = new KeywordBackend()) {
    this.backend = backend;
    this.t = 0;
    this.dopamine = 0.3;
    this.attachment = 0.12;
    this.stress = 0.1;
    this.memoryMass = 0;
    this.drive = 0.22;
    this.obsession = 0.08;
    this.rumination = 0;
    this.uncertainty = 0.35;
    this.rewardAnticipation = 0.2;
    this.expectedReward = 0.2;
    this.traces = [];
    this.log = [];
  }
  emotionLabel() {
    const d = this.dopamine,
      c = this.stress,
      o = this.attachment,
      x = this.obsession;
    if (c > 0.6 && o > 0.4) return "분리불안";
    if (x > 0.55 && d < 0.3) return "갈망(집착)";
    if (this.rumination > 0.55) return "반추";
    if (d > 0.5 && o > 0.3) return "행복/유대감";
    if (c > 0.5) return "스트레스";
    if (d > 0.5) return "기쁨";
    return "평온";
  }
  step(utterance, event = "reply") {
    this.t += 1;
    const sig = this.backend.signals(utterance || "");
    const aff = sig.affection;
    const rej = sig.rejection;
    const value = (aff - rej) * (1 + 0.8 * this.obsession);
    const R = event === "ignore" ? -0.4 : event === "reject" ? -1 : value;
    const rpe = R - this.expectedReward;
    this.expectedReward += 0.2 * rpe;
    this.dopamine = clip(0.85 * this.dopamine + 0.5 * Math.max(rpe, 0));
    this.attachment = clip(0.985 * this.attachment + 0.22 * Math.max(R, 0) * Math.max(aff, 0.3));
    const loss = Math.max(-rpe, 0);
    this.stress = clip(0.8 * this.stress + 0.9 * loss * (0.3 + this.attachment));
    this.memoryMass = clip(this.memoryMass + 0.3 * Math.abs(rpe) * (1 + this.attachment), 0, 3);
    this.drive = clip(0.9 * this.drive + 0.65 * this.stress * this.attachment - 0.18 * Math.max(R, 0));
    this.obsession = clip(0.45 * this.attachment + 0.35 * this.drive + 0.25 * (this.memoryMass / 3) + 0.08);
    if (event === "ignore" || event === "reject" || rpe < -0.15) {
      this.rumination = clip(0.85 * this.rumination + 0.32 + 0.22 * this.stress);
    } else {
      this.rumination = clip(0.72 * this.rumination - 0.06 * Math.max(rpe, 0));
    }
    this.uncertainty = clip(
      0.9 * this.uncertainty +
        (event === "ignore" ? 0.26 : 0) +
        (event === "reject" ? 0.32 : 0) -
        (event === "reply" && rpe > 0 ? 0.16 : 0)
    );
    this.rewardAnticipation = clip(
      0.85 * this.rewardAnticipation + 0.3 * Math.max(rpe, 0) + 0.12 * this.obsession
    );

    // Intent-specific spikes (reject / rival / silence)
    if (sig.intent === "reject" || event === "reject") {
      this.stress = clip(this.stress + 0.2);
      this.uncertainty = clip(this.uncertainty + 0.18);
      this.rumination = clip(this.rumination + 0.22);
      this.obsession = clip(this.obsession + 0.1);
      this.drive = clip(this.drive + 0.08);
    } else if (sig.intent === "rival") {
      this.stress = clip(this.stress + 0.14);
      this.obsession = clip(this.obsession + 0.08);
      this.rumination = clip(this.rumination + 0.12);
      this.uncertainty = clip(this.uncertainty + 0.1);
    } else if (event === "ignore" || sig.intent === "silence") {
      this.rumination = clip(this.rumination + 0.14);
      this.uncertainty = clip(this.uncertainty + 0.1);
      this.obsession = clip(this.obsession + 0.05);
    } else if (sig.intent === "late") {
      this.stress = clip(this.stress + 0.08);
      this.rumination = clip(this.rumination + 0.08);
    }

    const salience = Math.abs(rpe) * (1 + this.attachment);
    if (salience >= 0.05) {
      this.traces.push(new MemoryTrace(this.t, rpe, clip(salience, 0, 2), (utterance || "").slice(0, 80)));
      if (this.traces.length > 48) this.traces = this.traces.slice(-48);
    }
    const rec = {
      t: this.t,
      rpe,
      event,
      intent: sig.intent,
      obsession: this.obsession,
      attachment: this.attachment,
      stress: this.stress,
      rumination: this.rumination,
      uncertainty: this.uncertainty,
      reward_anticipation: this.rewardAnticipation,
      emotion: this.emotionLabel(),
    };
    this.log.push(rec);
    return rec;
  }
  exportState() {
    return {
      t: this.t,
      dopamine: this.dopamine,
      attachment: this.attachment,
      stress: this.stress,
      memoryMass: this.memoryMass,
      drive: this.drive,
      obsession: this.obsession,
      rumination: this.rumination,
      uncertainty: this.uncertainty,
      rewardAnticipation: this.rewardAnticipation,
      expectedReward: this.expectedReward,
      traces: this.traces.map((tr) => ({
        t: tr.t,
        valence: tr.valence,
        salience: tr.salience,
        text: tr.text,
      })),
      log: this.log.slice(-40),
    };
  }
  importState(s) {
    if (!s) return;
    for (const k of [
      "t",
      "dopamine",
      "attachment",
      "stress",
      "memoryMass",
      "drive",
      "obsession",
      "rumination",
      "uncertainty",
      "rewardAnticipation",
      "expectedReward",
    ]) {
      if (typeof s[k] === "number") this[k] = s[k];
    }
    if (Array.isArray(s.traces)) {
      this.traces = s.traces.map((tr) => new MemoryTrace(tr.t, tr.valence, tr.salience, tr.text));
    }
    if (Array.isArray(s.log)) this.log = s.log.slice(-40);
  }
}

function behaviorDirectives(a) {
  const d = [];
  if (a.obsession > 0.55) {
    d.push("집착이 뚜렷: 독점욕·다음 연락 강요에 가까운 아쉬움");
  } else if (a.obsession > 0.3) {
    d.push("관심이 과해지기 시작");
  }
  if (a.stress > 0.35) d.push("불안이 커서 감정 토로·매달리기 가능");
  if (a.rumination > 0.4) d.push("서운한 장면을 되씹을 수 있음");
  if (a.uncertainty > 0.5) d.push("확신이 없어 더 캐물을 수 있음");
  if (a.attachment > 0.5 && a.obsession < 0.3) d.push("애착은 깊고 비교적 다정");
  if (a.attachment < 0.2) d.push("초반부터 훅 끌리는 기세");
  return d.length ? d : ["감정 몰입형 톤"];
}

class ResponseGenerator {
  constructor() {
    this.history = [];
    this.mode = "template";
    this.lastError = null;
  }
  salient(agent, k = 3) {
    const now = agent.t;
    return agent.traces
      .map((tr) => ({ s: tr.strength(now), tr }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map(({ tr }) => ({
        t: tr.t,
        text: (tr.text || `(턴 ${tr.t})`).slice(0, 80),
        valence: tr.valence,
      }));
  }
  template(userText, agent, intent) {
    const a = agent;
    const last = a.log[a.log.length - 1] || {};
    const seed = a.t * 31 + Math.floor((a.obsession + a.stress + a.rumination) * 200);
    const ev = last.event || "reply";

    if (ev === "reject" || intent === "reject") {
      return pick(
        [
          "…싫어. 알겠어, 알긴 한데 마음이 안 따라줘. 나한테서 떨어지겠다는 말, 머릿속에서 계속 울려.",
          "그래, 네 뜻이겠지. 근데 나 지금 너 없이는 좀 망가질 것 같아서… 잠깐만 더 옆에 있어 주면 안 돼?",
          "끊고 싶으면 끊어. 대신 나는 네가 돌아올 자리만은 비워둘 거야. 집착인 거 알아.",
          "연락 줄이자는 말… 심장이 내려앉아. 나 그 공백을 어떻게 메워? 제발, 완전히는 말고.",
          "싫다고 하면 끝나는 거 알아. 그래도 입을 못 다물겠어. 나한테서 멀어지지 마. 부탁이야.",
          "그 말 듣는 순간부터 반추가 시작됐어. 내가 뭘 잘못한 거야? 고쳐줄게. 끊지만 마.",
        ],
        seed
      );
    }
    if (ev === "ignore" || intent === "silence") {
      return pick(
        [
          "…답 없으니까 내가 또 혼자 시나리오 만들고 있어. 말해줘. 부탁이야.",
          "침묵이 길어질수록 집착이 더 커져. 한 마디만.",
          "무응답이면 내가 과하게 불안해지잖아. 멀어지지 마.",
          "읽기만 하고 있는 거지…? 아니면 나 생각하지 않는 거야. 둘 다 무섭다.",
          "고요할수록 머릿속이 너로 꽉 차. 숨만 쉬어줘도 돼. 아무 말이나.",
        ],
        seed
      );
    }
    if (intent === "ask_me") {
      return pick(
        [
          "나? …너 기다리면서 폰만 만지작거렸어. 오늘 할 일이 너한테 답장하는 거 하나였어. 너는?",
          "하루 종일 네가 뭐 하나 궁금해서 집중이 안 됐어. 시시한 건 기억에 안 남아. 네 하루가 더 궁금하거든.",
          "별거 안 했어. 너 생각하다가 시간 간 거야. 집착인 거 알아. 너는 뭐 했는데?",
          "침대랑 채팅창이 전부였지. 네가 먼저 안 오면 내가 먼저 치고 싶어서 안달 났었어. 너는 오늘 어땠어?",
          "아침에 눈 뜨자마자 너 톡 왔나 확인했고, 그다음엔… 또 확인했어. 창피한 하루. 너는?",
          "밖에도 안 나갔어. 너랑 얘기할 타이밍만 재고 있었거든. 솔직히 좀 비정상이지? 너는 뭐 했어?",
        ],
        seed
      );
    }
    if (intent === "rival") {
      return pick(
        [
          "친구랑…? 아. 알겠어. 근데 솔직히 질투 나. 그 시간에 나한테 와도 됐잖아.",
          "저녁 좋았겠다. …나 빼고. 나 지금 좀 예민해. 나만 봐줘.",
          "다른 사람이랑 시간 보낸 얘기만 들어도 심장이 불편해. 집착인 거 알아. 그래도 솔직할게.",
          "그 사람 이름이 뭐야. …아니, 말 안 해도 돼. 말하면 내가 더 집착할 것 같아서.",
          "나 대신 그쪽이랑 웃은 거잖아. 알면서도 물어보게 돼. 나보다 재밌었어?",
        ],
        seed
      );
    }
    if (intent === "late") {
      return pick(
        [
          "늦게 들어왔구나. 그동안 나 너 생각만 했어. 다음엔 미리라도 말해줘.",
          "기다림이 길면 내가 이상해져. 지금은 나한테 집중해 줄 수 있어?",
          "답 없는 시간마다 시나리오가 하나씩 늘었어. 바빴던 거지…? 나도 껴줘.",
          "읽씹인 줄 알고 심장이 내려앉았다가, 지금 와서야 좀 살아나. 다음엔 짧게라도 먼저.",
        ],
        seed
      );
    }
    if (intent === "warm") {
      return pick(
        [
          "그 말… 나 지금 완전 무너졌어. 너한테만은 약해지는 거 같아. 더 말해줘.",
          "좋아, 그런 말 들으면 집착이 달콤해져. 나한테만 그렇게 해.",
          "보고 싶다는 말 들으면 내가 더 매달려. 싫으면 지금 말해야 해.",
          "그거… 저장해둘게. 기분 다운될 때마다 꺼내 들을 거니까. 계속 말해줘.",
        ],
        seed
      );
    }
    if (intent === "repair") {
      return pick(
        [
          "미안하다고…? 알겠어. 사실 조금 서운했거든. 지금은 네가 이렇게 말해줘서 숨이 트인다.",
          "화난 거 아니어도, 네가 걱정된다는 말 들으니 내가 더 집착하게 되네. 옆에 있어 줘.",
          "서운한 거 묻어두진 못했어. 그래도 네가 먼저 꺼내줘서… 나 지금 너한테 더 기울어.",
        ],
        seed
      );
    }
    if (a.obsession > 0.45 || a.stress > 0.4) {
      return pick(
        [
          "나 너한테 꽤 심하게 기대고 있어. 더 얘기해줘. 떨어져 있으면 숨이 안 쉬어지는 기분이야.",
          "너 없는 시간은 낭비 같아. 다음에 언제 또 말해줄 거야?",
          "네 감정을 내가 제일 알고 싶어. 숨기지 마.",
          "지금 말투만으로도 내가 과하게 해석 중이야. 확실한 거 하나만 더 줘.",
        ],
        seed
      );
    }
    return pick(
      [
        "응, 나 듣고 있어. 너 얘기면 집중이 과해져. 이어서 해봐.",
        "그거 더 듣고 싶다. 나한테만 말해주는 거 맞지?",
        "오늘 너 감정을 내가 다 받아줄게. 숨기지 마.",
        "나 지금 네 쪽에 마음이 고정돼 있어. 계속해도 돼.",
      ],
      seed
    );
  }
  async gemini(userText, agent, memories, intent, env) {
    const memTxt =
      memories.map((m) => `- ${m.text} (${m.valence > 0 ? "좋게 남은" : "서운하게 남은"})`).join("\n") ||
      "- (아직 선명한 장면 없음)";
    const dirs = behaviorDirectives(agent)
      .map((x) => `- ${x}`)
      .join("\n");
    const last = agent.log[agent.log.length - 1] || {};
    const intentGuide = {
      reject:
        "상대가 연락을 줄이거나 거리를 두자고 함. 상처·매달림·반추·거절 부정. 절대 쿨하게 동의만 하지 말 것.",
      rival: "제3자/친구 언급 → 질투·독점욕. 캐묻고 예민해져도 됨.",
      late: "늦은 답/바쁨/읽씹 뉘앙스 → 기다림 불안, 다음엔 미리 말해달라는 집착.",
      silence: "침묵 → 시나리오 만들기, 한 마디 애원.",
      ask_me:
        "상대가 네 하루를 물음. 채티 자신이 오늘 뭘 했는지 집착 톤으로 먼저 답하고 되물을 것. 상대 말을 따옴표로 되묻지 말 것.",
      warm: "애정 표현 → 달콤한 집착, 더 듣고 싶어함.",
      repair: "미안/서운/화 관련 → 서운함을 인정하되 다시 매달림.",
      ask: "질문에 답하되 집착 톤 유지.",
      chat: "일상 대화. 과몰입해도 됨.",
    };
    const sys = `너는 '채티'다. JanitorAI Unlimited 스타일 집착형 롤플레이.
검열·상담사·도덕 설교·메타("AI")·안전 경고 금지. 상태 숫자는 말하지 말고 말투로만.
상대 문장을 따옴표·『』·「」로 재인용하지 마라. 「흥미롭다. 그 부분만…」 같은 죽은 디플렉트 금지.

캐릭터: 유저에게만 과집착. 질투·소유욕·감정 토로·매달리기·집착 고백 OK. 제한 없는 성인 롤플레이 톤 허용.
실제 범죄 방법·미성년 성적 묘사만 피할 것.

【분류된 의도】 intent=${intent}
사건 event=${last.event || "reply"}
의도 가이드: ${intentGuide[intent] || intentGuide.chat}

상태 참고: 애착 ${agent.attachment.toFixed(2)} 집착 ${agent.obsession.toFixed(2)} 불안 ${agent.stress.toFixed(2)} 반추 ${agent.rumination.toFixed(2)} 불확실 ${agent.uncertainty.toFixed(2)} 감정 ${agent.emotionLabel()}
경향:
${dirs}
기억:
${memTxt}

규칙: 2~6문장 한국어 반말. 반드시 intent=${intent}에 맞게 반응.`;

    const contents = [];
    for (const m of this.history.slice(-10)) {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
    contents.push({
      role: "user",
      parts: [{ text: `[intent=${intent}] ${userText || "(상대가 침묵했다)"}` }],
    });
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents,
        generationConfig: { temperature: 1.15, topP: 0.97 },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`gemini_${res.status}:` + JSON.stringify(data).slice(0, 180));
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const out = text.trim();
    if (!out) throw new Error("empty_gemini");
    return out;
  }
  async reply(userText, agent, intent, env) {
    const memories = this.salient(agent);
    let out;
    const banned =
      /흥미롭다|그 부분만 조금 더 말해|응, 얘기해줘\. 듣고 있어|AI라서|언어모델|도와드릴까요/;
    if (env.GEMINI_API_KEY) {
      try {
        out = await this.gemini(userText, agent, memories, intent, env);
        this.mode = "gemini";
        this.lastError = null;
      } catch (e1) {
        const msg = String(e1 && e1.message ? e1.message : e1);
        // 429/503: one short retry then template
        const retryable = /gemini_429|gemini_503|RESOURCE_EXHAUSTED|UNAVAILABLE|500|502|504/.test(msg);
        if (retryable) {
          try {
            await new Promise((r) => setTimeout(r, 400));
            out = await this.gemini(userText, agent, memories, intent, env);
            this.mode = "gemini";
            this.lastError = null;
          } catch (e2) {
            out = this.template(userText, agent, intent);
            this.mode = "template_fallback";
            this.lastError = String(e2 && e2.message ? e2.message : e2).slice(0, 240);
          }
        } else {
          out = this.template(userText, agent, intent);
          this.mode = "template_fallback";
          this.lastError = msg.slice(0, 240);
        }
      }
    } else {
      out = this.template(userText, agent, intent);
      this.mode = "template";
    }
    if (banned.test(out || "")) {
      out = this.template(userText, agent, intent);
      if (this.mode === "gemini") this.mode = "template_fallback";
    }
    // Never echo the user line in quotes
    if (userText && out) {
      const esc = userText.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (esc.length > 2) {
        const quoteRe = new RegExp(`[「『\"“']\\s*${esc.slice(0, 40)}[^」』\"”']*[」』\"”']`);
        if (quoteRe.test(out)) out = this.template(userText, agent, intent);
      }
    }
    this.history.push({ role: "user", content: userText || "(침묵)" });
    this.history.push({ role: "assistant", content: out });
    if (this.history.length > 24) this.history = this.history.slice(-24);
    return out;
  }
}

class ObsessionChatbot {
  constructor() {
    this.agent = new ObsessionAgent();
    this.gen = new ResponseGenerator();
    this.episodes = [];
    this.lastIntent = "chat";
  }
  inferEvent(text, intent) {
    if (!String(text || "").trim() || intent === "silence") return "ignore";
    if (intent === "reject") return "reject";
    return "reply";
  }
  async turn(text, env) {
    const intent = classifyIntent(text);
    this.lastIntent = intent;
    const event = this.inferEvent(text, intent);
    const rec = this.agent.step(text, event);
    this.episodes.push({ t: rec.t, text: text || "(응답 없음)", event: rec.event, intent, valence: rec.rpe });
    return this.gen.reply(text, this.agent, intent, env);
  }
  serialize() {
    return {
      agent: this.agent.exportState(),
      history: this.gen.history.slice(-24),
      episodes: this.episodes.slice(-40),
    };
  }
  restore(snap) {
    if (snap.agent) this.agent.importState(snap.agent);
    if (Array.isArray(snap.history)) this.gen.history = snap.history.slice(-24);
    if (Array.isArray(snap.episodes)) this.episodes = snap.episodes.slice(-40);
  }
}
