/**
 * POST /browse handler — optional sibling to RP /chat.
 * Backward compatible: without BROWSER_API_URL returns clear error; /chat untouched.
 */

import { isBrowserConfigured } from "./safety.js";
import { runBrowserAgent } from "./agent.js";

export async function handleBrowse(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }

  const goal = (body.goal || body.message || body.text || "").toString();
  const session_id = (body.session_id || body.sessionId || "").toString() || undefined;
  const max_steps = body.max_steps ?? body.maxSteps ?? 8;
  const confirm = body.confirm && typeof body.confirm === "object" ? body.confirm : {};

  if (!isBrowserConfigured(env)) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "browser_not_configured",
        reply:
          "브라우저가 아직 연결되지 않았어. 1/2 단계: browser-runner를 켜거나 Browserbase URL을 준비하고, 2/2 단계: Worker secret BROWSER_API_URL (+ BROWSER_API_KEY)를 넣어줘. 자세한 내용: docs/browser-agent.md",
        hint: "Set BROWSER_API_URL to your Playwright runner (ngrok) or cloud browser gateway. Chat (/chat) still works.",
        browser: "missing",
        docs: "docs/browser-agent.md",
      },
    };
  }

  if (!env.GROQ_API_KEY) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "no_llm",
        reply: "GROQ_API_KEY가 없어 브라우저 에이전트 루프를 돌릴 수 없어.",
        browser: "configured",
      },
    };
  }

  const result = await runBrowserAgent({
    goal,
    env,
    session_id,
    max_steps,
    confirm,
  });

  const status = result.ok ? 200 : result.error === "denied_illegal" ? 403 : result.needs_confirm ? 200 : 422;
  return { status, body: result };
}

export function browserHealth(env) {
  return {
    browse: true,
    browser_api: isBrowserConfigured(env),
  };
}
