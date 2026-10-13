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

  const headers = runnerHeaders(env);

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

export function runnerHeaders(env) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    // ngrok free tier shows an HTML interstitial unless this header is present → Worker would get non-JSON
    "ngrok-skip-browser-warning": "true",
    "User-Agent": "chaeti-worker/1.0",
  };
  if (env.BROWSER_API_KEY) headers.Authorization = "Bearer " + String(env.BROWSER_API_KEY).trim();
  return headers;
}

/**
 * GET /browse/ping — one call that tells you exactly why the runner is unreachable.
 * Reports: resolved URL, HTTP status, content-type, first bytes, timing, and a plain-Korean diagnosis.
 */
export async function pingRunner(env) {
  const base = String(env.BROWSER_API_URL || "").trim().replace(/\/$/, "");
  const out = { url: base ? base.replace(/\/\/([^@/]+)@/, "//***@") : "", ok: false };
  if (!base) return { ...out, diagnosis: "BROWSER_API_URL 시크릿이 비어 있어. `wrangler secret put BROWSER_API_URL`로 터널 주소(https://…)를 넣어." };
  if (!/^https?:\/\//i.test(base)) return { ...out, diagnosis: "BROWSER_API_URL에 https:// 가 빠졌어." };
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(base + "/health", { headers: runnerHeaders(env), signal: controller.signal });
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    out.status = res.status;
    out.content_type = ct;
    out.ms = Date.now() - t0;
    out.body_head = text.slice(0, 200);
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (res.status === 401) out.diagnosis = "러너가 401 — BROWSER_API_KEY가 러너 .env의 키와 달라. 둘을 같게 맞춰.";
    else if (res.status === 404 && /ngrok|ERR_NGROK/i.test(text)) out.diagnosis = "ngrok 터널이 꺼져 있어(ERR_NGROK_3200 류). 러너 PC에서 `ngrok http 8788`이 살아 있는지, 주소가 바뀌지 않았는지 확인.";
    else if (res.status === 530 || res.status === 502 || res.status === 503 || res.status === 504) out.diagnosis = `터널은 살아 있는데 뒤의 러너가 응답을 안 해(${res.status}). 러너 프로세스(npm start)가 죽었거나 포트(8788)가 달라.`;
    else if (/<html/i.test(text) && !data) out.diagnosis = "JSON 대신 HTML이 왔어 — 터널의 안내/경고 페이지(ngrok 무료 interstitial, Cloudflare Access 로그인 등). 이번 버전은 ngrok 경고 헤더를 보내니, 아직 HTML이면 터널 쪽 인증 페이지야.";
    else if (data && data.service === "chaeti-browser-runner") {
      out.ok = true;
      out.runner = data;
      out.diagnosis = "정상. 러너 연결됨.";
    } else if (res.ok) out.diagnosis = "뭔가 응답은 오는데 채티 러너가 아니야. 주소가 다른 서비스를 가리키고 있어.";
    else out.diagnosis = `HTTP ${res.status}. 본문 앞부분을 봐.`;
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    out.ms = Date.now() - t0;
    out.error = msg.slice(0, 200);
    if (/abort/i.test(msg)) out.diagnosis = "15초 안에 응답 없음 — 러너 PC가 잠들었거나 터널이 끊겼거나 네트워크가 막혔어.";
    else if (/ENOTFOUND|getaddrinfo|resolve|DNS/i.test(msg)) out.diagnosis = "주소를 못 찾아(DNS). 터널을 다시 켜면 주소가 바뀌는 경우(trycloudflare, ngrok 무료)가 많아 — 새 주소를 시크릿에 다시 넣어.";
    else if (/ECONNREFUSED|connection refused/i.test(msg)) out.diagnosis = "연결 거부 — 터널 뒤 러너가 안 떠 있어.";
    else if (/certificate|SSL|TLS/i.test(msg)) out.diagnosis = "TLS 오류 — http 주소를 https로 적었거나 자체 서명 인증서야.";
    else out.diagnosis = "연결 실패: " + msg.slice(0, 120);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/** Trim observation for LLM context (drop huge screenshots). */
export function compactObservation(result) {
  if (!result) return { ok: false };
  const shot = result.screenshot_b64 || result.screenshot;
  const elements = Array.isArray(result.elements)
    ? result.elements.slice(0, 45).map((e) => {
        const o = { ref: e.ref, role: e.role, name: e.name };
        if (e.href) o.href = e.href;
        if (e.value) o.value = e.value;
        if (e.inview === false) o.below = true;
        return o;
      })
    : undefined;
  const out = {
    ok: result.ok !== false,
    url: result.url,
    title: result.title,
    text: String(result.text || result.snippet || "").slice(0, 2200),
    elements,
    scroll: result.scroll,
    hits: result.hits,
    error: result.error || result.message,
    screenshot_note: shot ? "(스크린샷 첨부됨 — 보이는 그대로 판단해)" : undefined,
  };
  // kept out of JSON.stringify (non-enumerable) — llm.js attaches it as an image block for vision planners
  if (shot && typeof shot === "string" && shot.length < 1500000) {
    Object.defineProperty(out, "_image", { value: { b64: shot, mime: result.screenshot_mime || "image/png" }, enumerable: false });
  }
  return out;
}
