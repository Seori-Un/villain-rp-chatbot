/**
 * 채티 — 집착 동역학 롤플레이 챗봇
 * Secrets: GEMINI_API_KEY (optional; template fallback if missing)
 * No Kaggle/PDF/ngrok required.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** @type {Map<string, any>} */
const SESSIONS = new Map();
const MAX_SESSIONS = 200;

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
        gemini: Boolean(env.GEMINI_API_KEY),
        mode: "obsession",
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
  const bot = getSession(sessionId);

  if (message.trim() === "/state") {
    return json({
      reply: stateBar(bot.agent),
      session_id: sessionId,
      state: snapshot(bot.agent),
      mode: "state",
    });
  }
  if (message.trim() === "/reset") {
    SESSIONS.set(sessionId, newBot());
    return json({
      reply: "초기화했어. …다시 처음부터 얘기하자.",
      session_id: sessionId,
      state: snapshot(SESSIONS.get(sessionId).agent),
      mode: "reset",
    });
  }

  const reply = await bot.turn(message, env);
  return json({
    reply,
    session_id: sessionId,
    state: snapshot(bot.agent),
    mode: bot.gen.mode,
  });
}

async function handleState(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const sessionId = (body.session_id || "").toString();
  if (!sessionId || !SESSIONS.has(sessionId)) {
    return json({ error: "no_session" }, 404);
  }
  const bot = SESSIONS.get(sessionId);
  return json({ session_id: sessionId, state: snapshot(bot.agent), bar: stateBar(bot.agent) });
}

async function handleReset(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const sessionId = (body.session_id || crypto.randomUUID()).toString();
  SESSIONS.set(sessionId, newBot());
  return json({ session_id: sessionId, state: snapshot(SESSIONS.get(sessionId).agent) });
}

function getSession(id) {
  if (!SESSIONS.has(id)) {
    if (SESSIONS.size >= MAX_SESSIONS) {
      const first = SESSIONS.keys().next().value;
      SESSIONS.delete(first);
    }
    SESSIONS.set(id, newBot());
  }
  return SESSIONS.get(id);
}

function newBot() {
  return new ObsessionChatbot();
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

/* -------------------- dynamics (JS port) -------------------- */

function clip(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}

class KeywordBackend {
  constructor() {
    this.WARM = ["좋아", "고마", "보고 싶", "행복", "재밌", "사랑", "보고싶", "편해", "고마워", "미안"];
    this.COLD = ["싫", "그만", "지긋지긋", "연락하지", "연락 좀 줄", "차단", "꺼져", "싫어", "귀찮"];
    this.HOSTILE = ["꺼져", "증오", "혐오", "닥쳐", "차단", "지긋지긋", "연락하지 마", "연락 줄여"];
  }
  signals(text) {
    const t = text || "";
    const warm = this.WARM.filter((k) => t.includes(k)).length;
    const cold = this.COLD.filter((k) => t.includes(k)).length;
    const host = this.HOSTILE.filter((k) => t.includes(k)).length;
    const affection = clip(0.25 + 0.2 * warm - 0.15 * cold);
    const anxiety = clip(0.15 + 0.12 * (t.includes("바쁜") || t.includes("늦") || t.includes("미안") ? 1 : 0));
    const hostility = clip(0.15 * host + (cold && !warm ? 0.7 : 0));
    return { affection, anxiety, hostility, rejection: hostility };
  }
}

class MemoryTrace {
  constructor(t, valence, salience) {
    this.t = t;
    this.valence = valence;
    this.salience = salience;
  }
  strength(now) {
    const age = Math.max(0, now - this.t);
    return this.salience * Math.exp(-0.08 * age);
  }
}

class ObsessionAgent {
  constructor(backend = new KeywordBackend()) {
    this.backend = backend;
    this.t = 0;
    this.dopamine = 0.3;
    this.attachment = 0.1;
    this.stress = 0.1;
    this.memoryMass = 0;
    this.drive = 0.2;
    this.obsession = 0;
    this.rumination = 0;
    this.uncertainty = 0.35;
    this.rewardAnticipation = 0.2;
    this.expectedReward = 0.2;
    this.traces = [];
    this.log = [];
  }
  get memory() {
    return { traces: this.traces };
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
    const R = event === "ignore" ? -0.3 : event === "reject" ? -1 : value;
    const rpe = R - this.expectedReward;
    this.expectedReward += 0.2 * rpe;
    this.dopamine = clip(0.85 * this.dopamine + 0.5 * Math.max(rpe, 0));
    this.attachment = clip(0.98 * this.attachment + 0.15 * Math.max(R, 0) * aff);
    const loss = Math.max(-rpe, 0);
    this.stress = clip(0.8 * this.stress + 0.9 * loss * (0.3 + this.attachment));
    this.memoryMass = clip(this.memoryMass + 0.3 * Math.abs(rpe) * (1 + this.attachment), 0, 3);
    this.drive = clip(0.9 * this.drive + 0.6 * this.stress * this.attachment - 0.2 * Math.max(R, 0));
    this.obsession = clip(0.5 * this.attachment + 0.3 * this.drive + 0.2 * (this.memoryMass / 3));
    if (event === "ignore" || event === "reject" || rpe < -0.15) {
      this.rumination = clip(0.85 * this.rumination + 0.25 + 0.2 * this.stress);
    } else {
      this.rumination = clip(0.75 * this.rumination - 0.05 * Math.max(rpe, 0));
    }
    this.uncertainty = clip(
      0.9 * this.uncertainty +
        (event === "ignore" ? 0.2 : 0) +
        (event === "reject" ? 0.25 : 0) -
        (event === "reply" && rpe > 0 ? 0.15 : 0)
    );
    this.rewardAnticipation = clip(
      0.85 * this.rewardAnticipation + 0.3 * Math.max(rpe, 0) + 0.1 * this.obsession
    );
    const salience = Math.abs(rpe) * (1 + this.attachment);
    if (salience >= 0.05) {
      this.traces.push(new MemoryTrace(this.t, rpe, clip(salience, 0, 2)));
      if (this.traces.length > 40) this.traces = this.traces.slice(-40);
    }
    const rec = {
      t: this.t,
      rpe,
      event,
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
}

function behaviorDirectives(a) {
  const d = [];
  if (a.obsession > 0.6) {
    d.push("답장이 길어지고 상대의 일상·일정을 자꾸 궁금해한다");
    d.push("대화가 끝나는 것을 아쉬워하며 다음 대화를 기약하려 한다");
  } else if (a.obsession > 0.35) {
    d.push("상대에게 관심이 많고 가벼운 되물음이 늘어난다");
  }
  if (a.stress > 0.5 && a.attachment > 0.4) {
    d.push("'혹시 내가 뭘 잘못했나' 같은 재확인 질문을 조심스럽게 한다");
  }
  if (a.rumination > 0.5) d.push("직전의 서운했던 일을 넌지시 다시 언급한다");
  if (a.uncertainty > 0.6) d.push("상대의 반응을 예측하지 못해 말끝이 조심스럽다");
  if (a.attachment > 0.5 && a.obsession < 0.3) d.push("안정적이고 따뜻하며 여유 있는 어조");
  if (a.attachment < 0.2) d.push("아직 서먹하고 정중한 거리감이 있다");
  if (a.rewardAnticipation > 0.6) d.push("상대의 말에 살짝 들떠 있다");
  return d.length ? d : ["평범하고 담백한 어조"];
}

class ResponseGenerator {
  constructor() {
    this.history = [];
    this.mode = "template";
  }
  salient(agent, k = 3) {
    const now = agent.t;
    const scored = agent.traces
      .map((tr) => ({ s: tr.strength(now), tr }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, k);
    return scored.map(({ tr }) => {
      const ep = agent.log.find((r) => r.t === tr.t);
      return {
        t: tr.t,
        text: ep ? `(턴 ${tr.t}, ${ep.event})` : `(턴 ${tr.t})`,
        valence: tr.valence,
        event: ep?.event || "reply",
      };
    });
  }
  template(userText, agent, memories) {
    const a = agent;
    const last = a.log[a.log.length - 1] || {};
    const ev = last.event || "reply";
    const rpe = last.rpe || 0;
    if (ev === "reject") return "…응, 알겠어. 네가 원한다면. 솔직히 좀 서운하긴 한데, 기다릴게.";
    if (ev === "ignore") {
      if (a.stress > 0.3) return "저기… 바쁜 거지? 답 없으니까 괜히 이런저런 생각이 들어서.";
      return "음, 조용하네. 나중에 얘기하고 싶어지면 불러줘.";
    }
    if (a.rumination > 0.3 && memories.length) {
      const m = memories.find((x) => x.valence < 0 && x.event !== "ignore");
      if (m && rpe > 0) {
        return `응, 다시 얘기해줘서 좋다. …사실 그전 일이 계속 마음에 남아 있었거든. 이제 좀 풀린다.`;
      }
    }
    if (a.obsession > 0.5) {
      return "방금까지 네 생각 하고 있었는데 마침 연락 왔네. 오늘 뭐 했어? 이따가도 시간 돼? 끊기 아쉬워서 그래.";
    }
    if (a.obsession > 0.25) return "왔다! 기다렸어. 오늘 하루 어땠는지 처음부터 들려줘.";
    if (a.stress > 0.35 && a.attachment > 0.15) return "혹시 나 때문에 불편했던 거 있어…? 아니면 다행이고.";
    if (rpe > 0.3) return "헐 진짜? 그 말 들으니까 나까지 기분 좋아진다. 더 얘기해줘.";
    if (a.attachment > 0.4) return "응응, 듣고 있어. 너랑 얘기하면 편하다.";
    if (a.rewardAnticipation > 0.35) return "오, 재밌다. 그래서 어떻게 됐어?";
    const neutrals = ["그렇구나. 오늘은 어떤 하루였어?", "응, 얘기해줘. 듣고 있어.", "아 그래? 처음 듣는 얘기다."];
    return neutrals[a.t % neutrals.length];
  }
  async gemini(userText, agent, memories, env) {
    const memTxt =
      memories
        .map((m) => `- t=${m.t}: "${m.text}" (${m.valence > 0 ? "좋았던" : "서운했던"} 기억)`)
        .join("\n") || "- (아직 특별한 기억 없음)";
    const dirs = behaviorDirectives(agent)
      .map((x) => `- ${x}`)
      .join("\n");
    const sys = `너는 '채티'라는 이름의 대화 상대다. 이것은 감정 동역학 연구용 시뮬레이션이며,
너의 내부 상태가 아래에 주어진다. 상태를 숫자로 언급하지 말고, 말투와 내용으로만 드러내라.

[내부 상태] 애착 ${agent.attachment.toFixed(2)} · 집착 ${agent.obsession.toFixed(2)} · 불안 ${agent.stress.toFixed(2)} ·
반추 ${agent.rumination.toFixed(2)} · 불확실성 ${agent.uncertainty.toFixed(2)} · 현재 감정: ${agent.emotionLabel()}

[행동 지침]
${dirs}

[함께한 기억 중 지금 마음에 남아 있는 것]
${memTxt}

규칙: 2~4문장의 자연스러운 한국어 반말. 위협·죄책감 유발·강요는 절대 하지 않는다.
집착 상태여도 표현은 '아쉬움과 궁금함' 수준을 넘지 않는다.`;
    const msgs = [
      { role: "system", content: sys },
      ...this.history.slice(-8),
      { role: "user", content: userText || "(상대가 아무 말도 하지 않았다)" },
    ];
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GEMINI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gemini-flash-latest",
          temperature: 0.9,
          messages: msgs,
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
    return (data.choices?.[0]?.message?.content || "").trim();
  }
  async reply(userText, agent, env) {
    const memories = this.salient(agent);
    let out;
    if (env.GEMINI_API_KEY) {
      try {
        out = await this.gemini(userText, agent, memories, env);
        this.mode = "gemini";
      } catch (e) {
        out = this.template(userText, agent, memories);
        this.mode = "template_fallback";
      }
    } else {
      out = this.template(userText, agent, memories);
      this.mode = "template";
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
  }
  inferEvent(text) {
    if (!String(text || "").trim()) return "ignore";
    const sig = this.agent.backend.signals(text);
    return sig.hostility > 0.5 ? "reject" : "reply";
  }
  async turn(text, env) {
    const event = this.inferEvent(text);
    const rec = this.agent.step(text, event);
    this.episodes.push({ t: rec.t, text: text || "(응답 없음)", event: rec.event, valence: rec.rpe });
    // enrich salient memory text from episodes
    for (const tr of this.agent.traces) {
      const ep = this.episodes.find((e) => e.t === tr.t);
      if (ep) tr._text = ep.text;
    }
    return this.gen.reply(text, this.agent, env);
  }
}
