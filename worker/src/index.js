/**
 * Bridge: chat frontend → this Worker → Kaggle/ngrok Gradio (or future /chat).
 * Secrets: KAGGLE_API_BASE (https://....ngrok-free.app), optional SYSTEM_PROMPT override.
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

  // Prefer a future REST /chat; fall back to Gradio queue API shape.
  const payloads = [
    { url: `${base}/chat`, body: { message, history, system } },
    {
      url: `${base}/api/predict`,
      body: { data: [message, history] },
    },
  ];

  let lastErr = null;
  for (const p of payloads) {
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p.body),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        lastErr = { status: res.status, data };
        continue;
      }
      const reply =
        data.reply ||
        data.response ||
        (Array.isArray(data.data) ? String(data.data[0] ?? "") : "") ||
        text;
      return json({ reply, mode: "upstream", upstream: p.url });
    } catch (e) {
      lastErr = { message: String(e) };
    }
  }
  return json({ error: "upstream_failed", detail: lastErr }, 502);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
