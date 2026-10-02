const DEFAULT_API = "https://villain-rp-chatbot.e5eeeee.workers.dev";
const params = new URLSearchParams(location.search);
const API_BASE = (params.get("api") || DEFAULT_API).replace(/\/$/, "");

const STORAGE_KEY = "chaeti_v3";
const LEGACY_KEYS = ["chaeti_session", "chaeti_snapshot", "chaeti_history"];

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const apiLabel = document.getElementById("apiLabel");
const stateEl = document.getElementById("state");
const headerSub = document.getElementById("headerSub");
const modeSecretaryBtn = document.getElementById("modeSecretary");
const modeRpBtn = document.getElementById("modeRp");
const clearPersistBtn = document.getElementById("clearPersist");
const loginConfirmBar = document.getElementById("loginConfirmBar");
const browseConfirm = document.getElementById("browseConfirm");
const loginConfirmHint = document.getElementById("loginConfirmHint");

apiLabel.textContent = API_BASE;

/** @type {"secretary"|"rp"} */
let uiMode = "secretary";
let sessionId = "";
let browseSessionId = "";
let snapshot = null;
/** @type {Array<{role:string, content:string, kind?:string, steps?:any[], meta?:object}>} */
let messages = [];
/** @type {any[]} */
let lastBrowseSteps = [];

/** @type {string[]} memory-only; never localStorage */
let browseApprovedHosts = [];
/** @type {null | { goal: string, session_id?: string, needs_confirm: object }} */
let pendingBrowseConfirm = null;

/** Safari/long /browse: AbortSignal + Korean errors (avoid raw "Load failed") */
const BROWSE_TIMEOUT_MS = 150000; // 150s — generous but before silent drop
const CHAT_TIMEOUT_MS = 90000;
const BROWSE_MAX_STEPS = 8; // shorter Worker wall time by default


/* ---------- time sense (client clock → Worker system prompt) ---------- */
function clientTimePayload() {
  let tz = "Asia/Seoul";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch {}
  const last = [...messages].reverse().find((m) => typeof m.ts === "number" && m.ts > 0);
  return {
    client_now: Date.now(),
    timezone: tz,
    last_message_at: last ? last.ts : undefined,
  };
}

const BROWSE_PROGRESS_MS = 2500;

const TOOL_KO = {
  open: "열기",
  click: "클릭",
  type: "입력",
  scroll: "스크롤",
  screenshot: "캡처",
  done: "끝",
};

/* ---------- fetch with timeout (Safari-safe) ---------- */

function classifyFetchError(err) {
  const msg = String(err && err.message != null ? err.message : err || "");
  const name = String(err && err.name ? err.name : "");
  if (name === "AbortError" || /aborted|AbortError|The operation was aborted/i.test(msg)) {
    return {
      kind: "timeout",
      text: "요청이 너무 오래 걸려서 타임아웃됐어 (약 2~3분). 목표를 짧게 나누거나 다시 시도해 줘.",
    };
  }
  // Safari: TypeError "Load failed"; Chrome: "Failed to fetch"
  if (
    name === "TypeError" ||
    /Load failed|Failed to fetch|NetworkError|network error|fetch failed|ECONNRESET|ERR_NETWORK/i.test(msg)
  ) {
    return {
      kind: "network",
      text: "네트워크 연결이 끊겼어. 터널·회선이 불안정할 수 있어 — 다시 시도해 볼게.",
    };
  }
  return {
    kind: "other",
    text: "웹 연결이 안 되네. " + (msg.slice(0, 120) || "알 수 없는 오류"),
  };
}

/**
 * fetch + JSON parse with AbortController timeout.
 * @returns {Promise<{ res: Response, data: object }>}
 */
async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- task detection (keep in sync with worker/src/task.js) ---------- */

function stripWebPrefix(text) {
  return String(text || "")
    .replace(/^\s*\/웹\s*/i, "")
    .replace(/^\s*\/web\s*/i, "")
    .replace(/^\s*\/browse\s*/i, "")
    .trim();
}

function looksLikeBrowseTask(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/^\s*\/(?:웹|web|browse)(?=\s|$)/i.test(raw)) return true;
  if (/^\s*\//.test(raw)) return false;
  const t = raw.normalize("NFC");
  if (/(웹\s*(으로|에서|검색|열어|확인)|브라우저|검색해|구글|네이버|사이트\s*열)/.test(t)) {
    return true;
  }
  if (
    /(검색|열어|열어줘|열어봐|로그인|배포|찾아|찾아줘|확인해|확인하|확인\s*해|클릭|스크롤|캡처|스크린샷|접속|들어가|들어가서|들어가줘|다운로드|업로드|설치|설정|가입|회원가입|티켓|예약|가격|시세|뉴스|날씨|지도|링크|URL|url|http)/.test(
      t
    )
  ) {
    return true;
  }
  if (/\b[\w-]+\.(com|net|org|io|dev|kr|co\.kr|ai|app)\b/i.test(t)) return true;
  if (/https?:\/\//i.test(t)) return true;
  return false;
}

function shouldBrowse(message) {
  if (uiMode === "rp") {
    // RP mode: only explicit /웹|/web|/browse forces browse
    return /^\s*\/(?:웹|web|browse)(?=\s|$)/i.test(message);
  }
  return looksLikeBrowseTask(message);
}

/* ---------- persistence ---------- */

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") return data;
    }
  } catch {}
  // migrate legacy keys
  const legacy = { session_id: "", snapshot: null, messages: [], mode: "secretary", last_browse_steps: [] };
  try {
    legacy.session_id = localStorage.getItem("chaeti_session") || "";
    legacy.snapshot = JSON.parse(localStorage.getItem("chaeti_snapshot") || "null");
    const hist = JSON.parse(localStorage.getItem("chaeti_history") || "[]");
    if (Array.isArray(hist)) {
      legacy.messages = hist
        .filter((t) => t?.role && t?.content)
        .slice(-40)
        .map((t) => ({ role: t.role, content: t.content, kind: "chat", ts: t.ts }));
    }
  } catch {}
  return legacy;
}

function persist() {
  const payload = {
    session_id: sessionId || "",
    browse_session_id: browseSessionId || "",
    snapshot: snapshot || null,
    mode: uiMode,
    messages: messages.slice(-60),
    last_browse_steps: summarizeSteps(lastBrowseSteps).slice(-40),
    updated_at: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    // keep legacy mirrors for older tabs
    if (sessionId) localStorage.setItem("chaeti_session", sessionId);
    if (snapshot) localStorage.setItem("chaeti_snapshot", JSON.stringify(snapshot));
    const hist = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
        ts: m.ts,
      }))
      .slice(-40);
    localStorage.setItem("chaeti_history", JSON.stringify(hist));
  } catch (e) {
    console.warn("persist failed", e);
  }
}

/** Strip heavy fields (screenshots) before storing steps */
function summarizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => {
    const out = {
      type: s.type || inferType(s),
      content: (s.content || "").toString().slice(0, 400),
      tool: s.tool || s.action,
      ok: s.ok,
      n: s.n,
    };
    if (s.args && typeof s.args === "object") {
      out.args = { ...s.args };
      if (out.args.text) out.args.text = "***";
    }
    if (s.observation && typeof s.observation === "object") {
      out.observation = {
        title: s.observation.title,
        url: s.observation.url,
      };
    }
    return out;
  });
}

function clearAllPersist() {
  localStorage.removeItem(STORAGE_KEY);
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  sessionId = crypto.randomUUID();
  browseSessionId = "";
  snapshot = null;
  messages = [];
  lastBrowseSteps = [];
  hideBrowseConfirm();
  log.innerHTML = "";
  addWelcome();
  persist();
}

/* ---------- UI helpers ---------- */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function redactBrowseGoal(goal) {
  let g = String(goal || "");
  g = g.replace(/((?:pass(?:word|wd)?|pwd|비밀번호|비번|pw)\s*[:=：]\s*)(\S+)/gi, "$1***");
  g = g.replace(/((?:비밀번호|비번|password|passwd|pwd)\s+)(\S+)/gi, "$1***");
  g = g.replace(
    /(\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b\s*[\/|,]\s*)(\S{4,})/gi,
    "$1***"
  );
  return g;
}

function showState(s) {
  if (!s || uiMode === "secretary") {
    if (uiMode === "secretary") stateEl.textContent = "";
    return;
  }
  stateEl.textContent = `집착 ${s.obsession} · 애착 ${s.attachment} · 불안 ${s.stress} · 반추 ${s.rumination} · ${s.emotion}`;
}

function setUiMode(mode) {
  uiMode = mode === "rp" ? "rp" : "secretary";
  modeSecretaryBtn.setAttribute("aria-pressed", uiMode === "secretary" ? "true" : "false");
  modeRpBtn.setAttribute("aria-pressed", uiMode === "rp" ? "true" : "false");
  if (uiMode === "secretary") {
    headerSub.textContent = "개인 비서 · 일 시키면 알아서 처리";
    input.placeholder = "말해 봐. 검색·열어·확인해… 자연스럽게 시키면 돼";
    stateEl.textContent = "";
  } else {
    headerSub.textContent = "집착 동역학 롤플레이 · 상태는 말투로만";
    input.placeholder = "말해 봐. /state /reset /silence · 웹은 /웹 …";
  }
  persist();
}

function addBubble(text, role, scroll = true) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  log.appendChild(el);
  if (scroll) log.scrollTop = log.scrollHeight;
  return el;
}

function addWelcome() {
  if (uiMode === "secretary") {
    addBubble("나 채티야. 시킬 일 있으면 그냥 말해 — 검색·사이트 열기·확인 같은 건 내가 알아서 웹으로 처리할게.", "bot");
  } else {
    addBubble("…왔어? 나 채티야. 편하게 말해도 돼. (/reset /state /silence)", "bot");
  }
}

function inferType(s) {
  if (s.tool || s.action) return "tool";
  if (s.observation && !s.content) return "observe";
  return "think";
}

function formatArgs(args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];
  if (args.url) parts.push(String(args.url).slice(0, 80));
  if (args.selector) parts.push(String(args.selector).slice(0, 48));
  if (args.text != null && args.text !== "") {
    const t = String(args.text);
    parts.push(t === "***" ? "***" : t.slice(0, 40));
  }
  if (args.direction) parts.push(String(args.direction));
  if (args.summary) parts.push(String(args.summary).slice(0, 80));
  if (args.x != null && args.y != null) parts.push(`(${args.x},${args.y})`);
  return parts.join(" · ");
}

function formatObserve(obs) {
  if (!obs) return "";
  const bits = [];
  if (obs.title) bits.push(String(obs.title).slice(0, 60));
  if (obs.url) bits.push(String(obs.url).slice(0, 60));
  return bits.join(" · ");
}

/** Build inline thinking timeline (details) for a browse turn */
function buildTimelineEl(steps, meta) {
  const details = document.createElement("details");
  details.className = "inline-thinking";
  details.open = true;
  const thinks = (steps || []).filter((s) => (s.type || inferType(s)) === "think").length;
  const tools = (steps || []).filter((s) => (s.type || inferType(s)) === "tool").length;
  const llmBit = meta?.llm ? ` · ${meta.llm}` : "";
  const modelBit = meta?.model ? `/${meta.model}` : "";
  const summary = document.createElement("summary");
  summary.innerHTML =
    `생각 중 <span class="think-meta">${thinks}생각 · ${tools}도구${escapeHtml(llmBit)}${escapeHtml(modelBit)}</span>`;
  details.appendChild(summary);

  const ol = document.createElement("ol");
  ol.className = "browse-steps";
  ol.setAttribute("aria-label", "생각·도구 타임라인");
  for (const s of steps || []) {
    const type = s.type || inferType(s);
    const li = document.createElement("li");
    const ok = s.ok !== false;
    li.className = `step-${type}` + (type === "tool" ? (ok ? " step-ok" : " step-fail") : "");
    let label = "";
    let body = "";
    if (type === "think") {
      label = "생각";
      body = s.content || "";
    } else if (type === "observe") {
      label = "관찰";
      body = s.content || formatObserve(s.observation) || "";
    } else {
      const tool = s.tool || s.action || "?";
      label = TOOL_KO[tool] || tool;
      body = s.content || formatArgs(s.args) || s.message || s.error || "";
      const obs = s.observation;
      if (obs && (obs.title || obs.url) && !s.content) {
        body += ` → ${(obs.title || "").slice(0, 40)}${obs.url ? " · " + String(obs.url).slice(0, 48) : ""}`;
      }
    }
    li.innerHTML = `<span class="step-label">${escapeHtml(label)}</span>${escapeHtml(body)}`;
    ol.appendChild(li);
  }
  details.appendChild(ol);
  return details;
}

function addBrowseReply(reply, steps, meta, isErr) {
  const wrap = document.createElement("div");
  wrap.className = "bubble browse" + (isErr ? " err" : "");
  if (steps && steps.length) {
    wrap.appendChild(buildTimelineEl(steps, meta));
  }
  const text = document.createElement("div");
  text.className = "browse-reply-text";
  text.textContent = reply;
  wrap.appendChild(text);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

function hideBrowseConfirm() {
  pendingBrowseConfirm = null;
  if (loginConfirmBar) loginConfirmBar.hidden = true;
  if (loginConfirmHint) loginConfirmHint.textContent = "";
}

function showBrowseConfirm(data, goal) {
  pendingBrowseConfirm = {
    goal,
    session_id: data.session_id || browseSessionId || sessionId || undefined,
    needs_confirm: data.needs_confirm,
  };
  const nc = data.needs_confirm || {};
  const host = nc.host ? String(nc.host) : "";
  if (loginConfirmBar) loginConfirmBar.hidden = false;
  if (loginConfirmHint) {
    loginConfirmHint.textContent = host
      ? `${host} 로그인/비밀번호 입력을 이 세션에서 허용할까? (비밀번호는 저장하지 않아)`
      : "로그인/비밀번호 입력을 허용하고 같은 목표로 다시 시도할까? (비밀번호는 저장하지 않아)";
  }
}

/* ---------- restore ---------- */

(function init() {
  const store = loadStore();
  sessionId = store.session_id || crypto.randomUUID();
  browseSessionId = store.browse_session_id || "";
  snapshot = store.snapshot || null;
  uiMode = store.mode === "rp" ? "rp" : "secretary";
  lastBrowseSteps = Array.isArray(store.last_browse_steps) ? store.last_browse_steps : [];
  setUiMode(uiMode);

  if (Array.isArray(store.messages) && store.messages.length) {
    messages = store.messages.slice(-60);
    for (const m of messages) {
      if (m.kind === "browse" && m.role === "assistant") {
        addBrowseReply(m.content, m.steps || [], m.meta || {}, false);
      } else if (m.role === "user") {
        addBubble(m.content, "user", false);
      } else {
        addBubble(m.content, m.role === "browse" ? "browse" : "bot", false);
      }
    }
    log.scrollTop = log.scrollHeight;
  } else {
    addWelcome();
  }
  persist();
})();

modeSecretaryBtn.addEventListener("click", () => setUiMode("secretary"));
modeRpBtn.addEventListener("click", () => setUiMode("rp"));
clearPersistBtn.addEventListener("click", () => {
  if (confirm("이 기기에 저장된 대화·상태를 지울까?")) clearAllPersist();
});

/* ---------- chat / browse from single input ---------- */

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";

  if (shouldBrowse(message)) {
    await runBrowseTurn(stripWebPrefix(message) || message, { fromConfirm: false });
    return;
  }

  await runChatTurn(message);
});

async function runChatTurn(message) {
  // Capture gap vs previous message BEFORE pushing this turn's user bubble.
  const timePayload = clientTimePayload();
  addBubble(message === "/silence" ? "(침묵)" : message, "user");
  if (!message.startsWith("/")) {
    messages.push({ role: "user", content: message, kind: "chat", ts: Date.now() });
  }
  const btn = form.querySelector("button");
  btn.disabled = true;
  const pending = addBubble("…", "bot");
  try {
    const { res, data } = await fetchJson(
      `${API_BASE}/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history: messages
            .filter((m) => m.kind !== "browse" || m.role === "user")
            .map((m) => ({
              role: m.role === "assistant" || m.role === "bot" ? "assistant" : "user",
              content: m.content,
              ts: m.ts,
            }))
            .slice(-24),
          session_id: sessionId || undefined,
          snapshot: snapshot || undefined,
          ...timePayload,
          client_now: Date.now(),
        }),
      },
      CHAT_TIMEOUT_MS
    );
    if (data.session_id) sessionId = data.session_id;
    if (data.snapshot) snapshot = data.snapshot;
    const reply = data.reply || data.error || "응답이 비었네.";
    pending.textContent = reply;
    if (!res.ok) pending.classList.add("err");
    showState(data.state);
    if (message.trim() === "/reset") {
      messages = [];
      snapshot = data.snapshot || null;
      log.innerHTML = "";
      addBubble(reply, "bot");
      messages.push({ role: "assistant", content: reply, kind: "chat", ts: Date.now() });
    } else if (!message.startsWith("/")) {
      messages.push({ role: "assistant", content: reply, kind: "chat", ts: Date.now() });
    }
    persist();
  } catch (err) {
    const c = classifyFetchError(err);
    pending.textContent = c.kind === "timeout"
      ? "채팅 응답이 너무 늦어서 타임아웃됐어. 다시 보내 줘."
      : c.kind === "network"
        ? "네트워크 연결이 안 되네. 잠시 후 다시 시도해 줘."
        : c.text;
    pending.classList.add("err");
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

async function runBrowseTurn(goal, opts = {}) {
  const fromConfirm = Boolean(opts.fromConfirm);
  if (!goal) return;

  const btn = form.querySelector("button");
  btn.disabled = true;
  if (browseConfirm) browseConfirm.disabled = true;
  if (!fromConfirm) hideBrowseConfirm();

  const displayGoal = redactBrowseGoal(goal);
  if (!fromConfirm) {
    addBubble(displayGoal, "user");
    messages.push({ role: "user", content: displayGoal, kind: "browse" });
  } else {
    addBubble("로그인 허용하고 같은 목표로 계속", "user");
    messages.push({ role: "user", content: "로그인 허용하고 같은 목표로 계속", kind: "browse" });
  }

  const pendingWrap = document.createElement("div");
  pendingWrap.className = "bubble browse";
  const pendingText = document.createElement("div");
  pendingText.className = "browse-reply-text";
  pendingText.textContent = "처리 중…";
  pendingWrap.appendChild(pendingText);
  log.appendChild(pendingWrap);
  log.scrollTop = log.scrollHeight;

  const confirmPayload = fromConfirm
    ? {
        allow_login: true,
        allow_credentials: true,
        approved_hosts: [
          ...browseApprovedHosts,
          ...(opts.host ? [opts.host] : []),
        ].filter(Boolean),
        approved_action_id:
          (pendingBrowseConfirm &&
            pendingBrowseConfirm.needs_confirm &&
            pendingBrowseConfirm.needs_confirm.action_id) ||
          "type_password",
      }
    : browseApprovedHosts.length
      ? { approved_hosts: [...browseApprovedHosts], allow_login: true }
      : undefined;

  const t0 = performance.now();
  pendingText.textContent = "웹에서 처리 중… (최대 약 2~3분 걸릴 수 있어)";
  const progressTimer = setInterval(() => {
    const sec = Math.round((performance.now() - t0) / 1000);
    pendingText.textContent = `웹에서 처리 중… ${sec}초 경과 (최대 약 2~3분)`;
  }, BROWSE_PROGRESS_MS);

  const browseBody = {
    goal,
    session_id: browseSessionId || sessionId || undefined,
    max_steps: BROWSE_MAX_STEPS,
    confirm: confirmPayload,
  };

  async function doBrowseFetch(isRetry) {
    if (isRetry) {
      pendingText.textContent = "네트워크 오류 — 한 번 더 시도 중…";
    }
    return fetchJson(
      `${API_BASE}/browse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(browseBody),
      },
      BROWSE_TIMEOUT_MS
    );
  }

  try {
    let res;
    let data;
    try {
      ({ res, data } = await doBrowseFetch(false));
    } catch (err) {
      const c = classifyFetchError(err);
      // Retry once on network fail (Safari Load failed / tunnel flake)
      if (c.kind === "network") {
        await sleep(900);
        ({ res, data } = await doBrowseFetch(true));
      } else {
        throw err;
      }
    }
    const ms = Math.round(performance.now() - t0);
    if (data.session_id) browseSessionId = data.session_id;

    const steps = Array.isArray(data.steps) ? data.steps : [];
    lastBrowseSteps = steps;
    const meta = { llm: data.llm, model: data.model, ms };
    const reply =
      data.reply ||
      data.error ||
      (res.ok ? "끝났어." : "실패했어.");
    const footer = `\n(${ms}ms · ${data.llm || "?"}${data.model ? " / " + data.model : ""})`;

    pendingWrap.remove();
    let isErr = false;
    let finalReply = reply + footer;

    if (data.needs_confirm) {
      isErr = true;
      const host = data.needs_confirm.host ? String(data.needs_confirm.host) : "";
      finalReply =
        reply +
        "\n(로그인/비밀번호 확인이 필요해" +
        (host ? `: ${host}` : "") +
        ". 아래 「로그인 허용하고 계속」을 눌러줘)";
      showBrowseConfirm(data, goal);
    } else if (!res.ok || data.ok === false) {
      isErr = true;
      hideBrowseConfirm();
    } else {
      if (fromConfirm && opts.host) {
        const h = String(opts.host).toLowerCase();
        if (h && !browseApprovedHosts.includes(h)) browseApprovedHosts.push(h);
      }
      hideBrowseConfirm();
    }

    addBrowseReply(finalReply, steps, meta, isErr);
    messages.push({
      role: "assistant",
      content: finalReply,
      kind: "browse",
      steps: summarizeSteps(steps),
      meta,
    });
    persist();
  } catch (err) {
    pendingWrap.remove();
    const c = classifyFetchError(err);
    // Keep user message; show Korean timeout vs network (never raw "Load failed")
    const msg = c.text;
    addBrowseReply(msg, [], {}, true);
    messages.push({ role: "assistant", content: msg, kind: "browse" });
    hideBrowseConfirm();
    persist();
  } finally {
    clearInterval(progressTimer);
    btn.disabled = false;
    if (browseConfirm) browseConfirm.disabled = false;
    input.focus();
  }
}

if (browseConfirm) {
  browseConfirm.addEventListener("click", () => {
    if (!pendingBrowseConfirm) return;
    const { goal, needs_confirm } = pendingBrowseConfirm;
    const host = needs_confirm && needs_confirm.host ? String(needs_confirm.host) : "";
    if (host && !browseApprovedHosts.includes(host.toLowerCase())) {
      browseApprovedHosts.push(host.toLowerCase());
    }
    runBrowseTurn(goal, { fromConfirm: true, host });
  });
}
