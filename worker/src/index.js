/**
 * Bridge: chat frontend → this Worker → Kaggle/ngrok Gradio.
 * Secrets: KAGGLE_API_BASE (https://....ngrok-free.dev), optional SYSTEM_PROMPT override.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const DEFAULT_SYSTEM = `당신은 한국어로 말하는 빌런 롤플레이 캐릭터입니다. 천상천하·유아독존. PDF는 당신의 법.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, hasBase: Boolean(env.KAGGLE_API_BASE) });
    }
    if (url.pathname === "/chat" && request.method === "POST") {
      return handleChat(request, env);
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
  const message = (body.message || body.text || "").toString().trim();
  const history = Array.isArray(body.history) ? body.history : [];
  if (!message) return json({ error: "message_required" }, 400);

  const system = (env.SYSTEM_PROMPT || DEFAULT_SYSTEM).toString();
  const base = (env.KAGGLE_API_BASE || "").replace(/\/$/, "");
  if (!base) {
    return json({
      reply:
        "아직 KAGGLE_API_BASE가 없어. PDF 법전은 준비됐는데 서버 주소가 없네. 시시하지.",
      mode: "stub",
    });
  }

  const headers = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };

  // Optional: push system prompt once per request (best-effort).
  try {
    await gradioCall(base, "_change_system_prompt", [system], headers, 30_000);
  } catch {
    /* ignore */
  }

  const multimodal = { text: message, files: [] };
  // Gradio chatbot history: list of [user, assistant] pairs when possible
  const chatbot = normalizeHistory(history);

  try {
    const data = await gradioCall(
      base,
      "_get_respone",
      ["QA", multimodal, chatbot],
      headers,
      180_000
    );
    const reply = extractReply(data) || "";
    return json({
      reply: reply || "(빈 응답)",
      mode: "gradio",
      upstream: `${base}/call/_get_respone`,
    });
  } catch (e) {
    return json({ error: "upstream_failed", detail: String(e) }, 502);
  }
}

function normalizeHistory(history) {
  // Accept [{role,content}] or [[user,assistant],...]
  if (!history.length) return [];
  if (Array.isArray(history[0])) return history;
  const pairs = [];
  let user = null;
  for (const turn of history) {
    const role = (turn.role || "").toLowerCase();
    const content = turn.content ?? turn.text ?? "";
    if (role === "user") user = content;
    else if (role === "assistant" || role === "bot") {
      pairs.push([user, content]);
      user = null;
    }
  }
  return pairs;
}

function extractReply(data) {
  // Expected: [multimodal, chatbot, status]
  if (!Array.isArray(data)) return String(data ?? "");
  const chatbot = data[1];
  if (Array.isArray(chatbot) && chatbot.length) {
    const last = chatbot[chatbot.length - 1];
    if (Array.isArray(last) && last.length >= 2) {
      const bot = last[1];
      if (typeof bot === "string") return bot;
      if (bot && typeof bot === "object" && bot.text) return bot.text;
    }
  }
  return "";
}

async function gradioCall(base, apiName, data, headers, timeoutMs) {
  const join = await fetch(`${base}/call/${apiName}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
  });
  const joinText = await join.text();
  let joinJson;
  try {
    joinJson = JSON.parse(joinText);
  } catch {
    throw new Error(`join_not_json:${join.status}:${joinText.slice(0, 200)}`);
  }
  if (!join.ok || !joinJson.event_id) {
    throw new Error(`join_failed:${join.status}:${joinText.slice(0, 200)}`);
  }
  const eid = joinJson.event_id;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(`${base}/call/${apiName}/${eid}`, {
      headers: { ...headers, Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let lastData = null;
    for (const block of text.split("\n\n")) {
      const lines = block.split("\n");
      let event = "message";
      let payload = null;
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) payload = line.slice(5).trim();
      }
      if (payload) {
        try {
          lastData = JSON.parse(payload);
        } catch {
          lastData = payload;
        }
      }
      if (event === "complete" || event === "error") break;
    }
    if (lastData == null) throw new Error("empty_sse");
    return lastData;
  } finally {
    clearTimeout(t);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
