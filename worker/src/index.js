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
  // Soft tendencies only — never scripts to recite.
  const d = [];
  if (a.obsession > 0.6) d.push("상대에게 관심이 짙어 말이 조금 길어지고, 다음에도 이어지고 싶어 한다");
  else if (a.obsession > 0.35) d.push("상대에게 관심이 생겨 가벼운 되물음이 자연스럽다");
  if (a.stress > 0.5 && a.attachment > 0.4) d.push("관계가 흔들릴까 봐 살짝 조심스럽다");
  if (a.rumination > 0.5) d.push("이전에 서운했던 장면이 문득 떠오를 수 있다");
  if (a.uncertainty > 0.6) d.push("상대 기분을 아직 잘 몰라 말끝이 조심스럽다");
  if (a.attachment > 0.5 && a.obsession < 0.3) d.push("편안하고 따뜻한 톤");
  if (a.attachment < 0.2) d.push("아직 완전 친하진 않은 거리감");
  if (a.rewardAnticipation > 0.6) d.push("상대 말에 기분이 살짝 좋아진다");
  return d.length ? d : ["담백하고 사람 같은 톤"];
}

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

class ResponseGenerator {
  constructor() {
    this.history = [];
    this.mode = "template";
    this.lastError = null;
  }
  salient(agent, episodes, k = 3) {
    const now = agent.t;
    const byT = Object.fromEntries((episodes || []).map((e) => [e.t, e]));
    return agent.traces
      .map((tr) => ({ s: tr.strength(now), tr, ep: byT[tr.t] }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map(({ tr, ep }) => ({
        t: tr.t,
        text: (tr._text || ep?.text || `(턴 ${tr.t})`).slice(0, 80),
        valence: tr.valence,
        event: ep?.event || "reply",
      }));
  }
  template(userText, agent, memories) {
    const a = agent;
    const last = a.log[a.log.length - 1] || {};
    const ev = last.event || "reply";
    const rpe = last.rpe || 0;
    const snip = (userText || "").trim().slice(0, 24);
    const seed = a.t * 17 + Math.floor((a.obsession + a.stress) * 100);

    if (ev === "reject") {
      return pick(
        [
          "…알았어. 네가 그렇게 느낀다면 내가 억지로 붙잡진 않을게. 그냥… 조금 아쉽긴 하다.",
          "응. 거리 두고 싶은 거지? 알겠어. 솔직히 가슴이 좀 쓰리긴 한데, 네 속도 맞출게.",
          "그 말 들으니 잠시 멍해지네. 그래도 네 선택이면… 기다려도 된다고만 할게.",
        ],
        seed
      );
    }
    if (ev === "ignore") {
      if (a.stress > 0.3) {
        return pick(
          [
            "…잠깐 답이 없으니까 괜히 머리가 복잡해지네. 바쁜 거지? 괜찮으면 나중에라도 말해줘.",
            "조용한 시간이 길어지니까 이상한 생각이 스며들어. 그냥 네가 바쁜 거였으면 좋겠다.",
            "야, 잠깐만… 무응답이 길어서 살짝 불안했어. 괜찮으면 한 마디만 해줘.",
          ],
          seed
        );
      }
      return pick(
        ["음, 지금은 조용하네. 나중에 말하고 싶으면 불러.", "오케이, 쉬어도 돼. 나 여기 있어.", "침묵도 괜찮긴 한데… 보고 싶으면 말해."],
        seed
      );
    }
    if (a.rumination > 0.35 && memories.some((m) => m.valence < 0) && rpe > 0) {
      return pick(
        [
          snip
            ? `지금 "${snip}" 그 말 들으니까… 그전에 좀 찜찜했던 게 조금 풀리는 느낌이야.`
            : "다시 이렇게 이어지니까, 그전에 마음에 남았던 게 조금 가벼워진다.",
          "고마워. 사실 아까 그 분위기가 좀 남았었거든. 지금은 숨이 좀 트인다.",
        ],
        seed
      );
    }
    if (a.obsession > 0.5) {
      return pick(
        [
          snip
            ? `"${snip}"… 그거 듣고 싶었어. 오늘 나머지 시간도 어때? 끊기 아쉬워서.`
            : "네 생각 하다가 톡 오니까 괜히 웃음 나네. 더 들을래. 이따도 가능해?",
          "마침 잘 됐다. 너 얘기 조금만 더 해줘. 하루가 궁금해서 그래.",
        ],
        seed
      );
    }
    if (a.obsession > 0.25) {
      return pick(
        [
          snip ? `오, "${snip}" 그 부분부터 좀 더 들려줄래?` : "왔다. 오늘 뭐 했는지 대충이라도 들려줘.",
          "반가워. 방금 그 얘기, 이어서 해봐.",
        ],
        seed
      );
    }
    if (a.stress > 0.35 && a.attachment > 0.15) {
      return pick(
        [
          "혹시 내가 말실수한 거 있어…? 아니면 그냥 네 하루가 바쁜 거고.",
          "분위기가 살짝 예민한 것 같아서. 불편하면 솔직히 말해도 돼.",
        ],
        seed
      );
    }
    if (rpe > 0.25) {
      return pick(
        [
          snip ? `헐, "${snip}" 그거 좋다. 그래서 어떻게 됐어?` : "그 말 들으니 나까지 기분이 올라가네. 더 말해봐.",
          "오 진짜? 그 부분 디테일 궁금해.",
        ],
        seed
      );
    }
    if (a.attachment > 0.4) {
      return pick(
        ["응, 듣고 있어. 너랑 이런 얘기하는 거 편하다.", "그래, 천천히 말해. 나 안 바뻐.", snip ? `응응, "${snip}" 그거 이해돼.` : "응, 이어가 봐."],
        seed
      );
    }
    if (!snip) {
      return pick(["오늘은 어떤 하루였어?", "뭐 하고 있었어?", "그냥 근황이라도 들려줘."], seed);
    }
    return pick(
      [
        `"${snip}"… 그렇구나. 그다음에 뭐 했어?`,
        `아, "${snip}" 그 얘기네. 기분이 어땠어?`,
        `응, "${snip}" 들었어. 왜 그렇게 됐어?`,
        `흥미롭다. "${snip}" 그 부분만 조금 더 말해줄래?`,
      ],
      seed
    );
  }
  async gemini(userText, agent, memories, env) {
    const memTxt =
      memories
        .map((m) => `- "${m.text}" (${m.valence > 0 ? "좋게 남은" : "서운하게 남은"} 장면)`)
        .join("\n") || "- (아직 선명한 장면 없음)";
    const dirs = behaviorDirectives(agent)
      .map((x) => `- ${x}`)
      .join("\n");
    const last = agent.log[agent.log.length - 1] || {};
    const sys = `너는 '채티'다. 사람처럼 대화하는 친구/썸 감정의 대화 상대.
내부 상태 숫자는 절대 말하지 말고, 말투·호흡·관심의 온도로만 드러내라.

성격: 솔직하고 따뜻하지만 집착이 커지면 질문이 늘고 끊김을 아쉬워한다. 그래도 집착·불안은 '아쉬움·궁금함·조심스러움' 수준까지만. 위협, 죄책감 유도, 집착 강요, 스토킹 톤 금지.

이번 턴 사건: ${last.event || "reply"}
내부 상태(참고만): 애착 ${agent.attachment.toFixed(2)}, 집착 ${agent.obsession.toFixed(2)}, 불안 ${agent.stress.toFixed(2)}, 반추 ${agent.rumination.toFixed(2)}, 불확실 ${agent.uncertainty.toFixed(2)}, 감정 ${agent.emotionLabel()}

말투 경향(강제 대본 아님, 분위기만):
${dirs}

마음에 남은 장면:
${memTxt}

응답 규칙:
- 상대가 방금 한 말의 구체 내용에 먼저 반응할 것. 동문서답 금지.
- 2~5문장 한국어 반말. 매 턴 문장 시작·표현을 바꿀 것.
- 금지 고정 문구: "응, 얘기해줘. 듣고 있어.", "오늘 하루 어땠어?"를 습관처럼 반복하기, 매뉴얼 같은 상담 톤.
- 질문해도 하나만. 상대 말을 요약한 뒤 자기 감정 한 조각 + 가벼운 호기심.
- 이모지는 거의 쓰지 말 것.`;

    const contents = [];
    for (const m of this.history.slice(-10)) {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
    contents.push({
      role: "user",
      parts: [{ text: userText || "(상대가 아무 말도 하지 않았다. 침묵에 반응해.)" }],
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
        generationConfig: { temperature: 1.05, topP: 0.95 },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 220));
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const out = text.trim();
    if (!out) throw new Error("empty_gemini");
    return out;
  }
  async reply(userText, agent, env, episodes) {
    const memories = this.salient(agent, episodes);
    let out;
    if (env.GEMINI_API_KEY) {
      try {
        out = await this.gemini(userText, agent, memories, env);
        this.mode = "gemini";
        this.lastError = null;
      } catch (e1) {
        try {
          await new Promise((r) => setTimeout(r, 400));
          out = await this.gemini(userText, agent, memories, env);
          this.mode = "gemini";
          this.lastError = null;
        } catch (e2) {
          out = this.template(userText, agent, memories);
          this.mode = "template_fallback";
          this.lastError = String(e2 && e2.message ? e2.message : e2).slice(0, 300);
        }
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
    return this.gen.reply(text, this.agent, env, this.episodes);
  }
}
