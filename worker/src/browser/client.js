/**
 * Stub / real HTTPS client for the browser runner (or Browserbase-compatible gateway).
 * Contract: POST {BROWSER_API_URL}/act  with Bearer BROWSER_API_KEY
 */

/**
 * @param {object} env
 * @param {{ action: string, args?: object, session_id?: string }} payload
 */
export async function browserAct(env, payload) {
  const base = String(env.BROWSER_API_URL || "").replace(/\/$/, "");
  if (!base) {
    return {
      ok: false,
      error: "browser_not_configured",
      message: "BROWSER_API_URL 이 없어. browser-runner 또는 Browserbase를 연결해줘.",
    };
  }

  const body = {
    action: payload.action,
    session_id: payload.session_id || "default",
    ...(payload.args || {}),
  };

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (env.BROWSER_API_KEY) {
    headers.Authorization = "Bearer " + env.BROWSER_API_KEY;
  }

  const controller = new AbortController();
  // trycloudflare / ngrok tunnels can be slow; still return JSON on failure
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const res = await fetch(base + "/act", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = { error: "browser_non_json", message: "러너가 JSON이 아닌 응답을 보냈어" };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: "browser_http_" + res.status,
        message:
          data.message ||
          data.error ||
          (typeof data === "object" ? JSON.stringify(data).slice(0, 200) : String(data).slice(0, 200)),
        data,
      };
    }
    return { ok: true, ...data };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const aborted = /abort/i.test(msg);
    const tunnel =
      /Load failed|Failed to fetch|network|ECONNRESET|tunnel|cloudflare|ngrok|ENOTFOUND|ECONNREFUSED/i.test(
        msg
      );
    return {
      ok: false,
      error: aborted ? "browser_timeout" : tunnel ? "browser_tunnel_failed" : "browser_fetch_failed",
      message: aborted
        ? "브라우저 러너 응답 시간 초과 (터널이 느릴 수 있어)"
        : tunnel
          ? "브라우저 러너(터널) 연결 실패 — trycloudflare/ngrok이 끊겼을 수 있어: " + msg.slice(0, 160)
          : msg.slice(0, 240),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Trim observation for LLM context (drop huge screenshots). */
export function compactObservation(result) {
  if (!result) return { ok: false };
  const shot = result.screenshot_b64 || result.screenshot;
  return {
    ok: result.ok !== false,
    url: result.url,
    title: result.title,
    text: String(result.text || result.snippet || "").slice(0, 2500),
    error: result.error || result.message,
    screenshot_bytes: shot ? String(shot).length : 0,
    screenshot_note: shot ? "(screenshot captured; omitted from LLM context)" : undefined,
  };
}
