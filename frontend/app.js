const DEFAULT_API = "https://villain-rp-chatbot.e5eeeee.workers.dev";
const params = new URLSearchParams(location.search);
const API_BASE = (params.get("api") || DEFAULT_API).replace(/\/$/, "");

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const apiLabel = document.getElementById("apiLabel");
const stateEl = document.getElementById("state");
apiLabel.textContent = API_BASE;

const browseToggle = document.getElementById("browseToggle");
const browsePanel = document.getElementById("browsePanel");
const browseGoal = document.getElementById("browseGoal");
const browseRun = document.getElementById("browseRun");
const browseStatus = document.getElementById("browseStatus");
const browseSteps = document.getElementById("browseSteps");
const browseThinking = document.getElementById("browseThinking");
const browseThinkMeta = document.getElementById("browseThinkMeta");
const browseShotWrap = document.getElementById("browseShotWrap");
const browseShot = document.getElementById("browseShot");

let sessionId = localStorage.getItem("chaeti_session") || "";
let snapshot = null;
try {
  snapshot = JSON.parse(localStorage.getItem("chaeti_snapshot") || "null");
} catch {
  snapshot = null;
}
const history = [];
try {
  const saved = JSON.parse(localStorage.getItem("chaeti_history") || "[]");
  if (Array.isArray(saved)) {
    for (const turn of saved.slice(-30)) {
      if (turn?.role && turn?.content) {
        history.push(turn);
        addBubble(turn.content, turn.role === "user" ? "user" : "bot", false);
      }
    }
  }
} catch {}

function addBubble(text, role, scroll = true) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  log.appendChild(el);
  if (scroll) log.scrollTop = log.scrollHeight;
  return el;
}

function showState(s) {
  if (!s) return;
  stateEl.textContent = `집착 ${s.obsession} · 애착 ${s.attachment} · 불안 ${s.stress} · 반추 ${s.rumination} · ${s.emotion}`;
}

function persist() {
  if (sessionId) localStorage.setItem("chaeti_session", sessionId);
  if (snapshot) localStorage.setItem("chaeti_snapshot", JSON.stringify(snapshot));
  localStorage.setItem("chaeti_history", JSON.stringify(history.slice(-40)));
}

if (!history.length) {
  addBubble("…왔어? 나 채티야. 편하게 말해도 돼. (/reset /state /silence)", "bot");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  addBubble(message === "/silence" ? "(침묵)" : message, "user");
  if (!message.startsWith("/")) history.push({ role: "user", content: message });
  const btn = form.querySelector("button");
  btn.disabled = true;
  const pending = addBubble("…", "bot");
  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history,
        session_id: sessionId || undefined,
        snapshot: snapshot || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.session_id) sessionId = data.session_id;
    if (data.snapshot) snapshot = data.snapshot;
    const reply = data.reply || data.error || "응답이 비었네.";
    pending.textContent = reply;
    if (!res.ok) pending.classList.add("err");
    showState(data.state);
    if (message.trim() === "/reset") {
      history.length = 0;
      log.innerHTML = "";
      addBubble(reply, "bot");
    } else if (!message.startsWith("/")) {
      history.push({ role: "assistant", content: reply });
    }
    persist();
  } catch (err) {
    pending.textContent = "연결이 안 되네. " + String(err.message || err);
    pending.classList.add("err");
  } finally {
    btn.disabled = false;
    input.focus();
  }
});

/* ---------- browse panel (additive; RP chat untouched) ---------- */

const TOOL_KO = {
  open: "열기",
  click: "클릭",
  type: "입력",
  scroll: "스크롤",
  screenshot: "캡처",
  done: "끝",
};

function setBrowseStatus(kind, label) {
  browseStatus.className = "browse-status " + kind;
  browseStatus.textContent = label;
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

/** Render Claude-style timeline: think / tool / observe */
function renderSteps(steps, meta) {
  browseSteps.innerHTML = "";
  if (!Array.isArray(steps) || !steps.length) {
    browseThinkMeta.textContent = "";
    return;
  }
  const thinks = steps.filter((s) => (s.type || inferType(s)) === "think").length;
  const tools = steps.filter((s) => (s.type || inferType(s)) === "tool").length;
  const llmBit = meta?.llm ? ` · ${meta.llm}` : "";
  const modelBit = meta?.model ? `/${meta.model}` : "";
  browseThinkMeta.textContent = `${thinks}생각 · ${tools}도구${llmBit}${modelBit}`;

  for (const s of steps) {
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
      body =
        s.content ||
        formatArgs(s.args) ||
        s.message ||
        s.error ||
        "";
      const obs = s.observation;
      if (obs && (obs.title || obs.url) && !s.content) {
        body += ` → ${(obs.title || "").slice(0, 40)}${obs.url ? " · " + String(obs.url).slice(0, 48) : ""}`;
      }
    }
    li.innerHTML =
      `<span class="step-label">${escapeHtml(label)}</span>` + escapeHtml(body);
    browseSteps.appendChild(li);
  }
  browseSteps.scrollTop = browseSteps.scrollHeight;
  if (browseThinking) browseThinking.open = true;
}

function inferType(s) {
  if (s.tool || s.action) return "tool";
  if (s.observation && !s.content) return "observe";
  return "think";
}

function formatObserve(obs) {
  if (!obs) return "";
  const bits = [];
  if (obs.title) bits.push(String(obs.title).slice(0, 60));
  if (obs.url) bits.push(String(obs.url).slice(0, 60));
  return bits.join(" · ");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractScreenshot(data) {
  if (!data) return null;
  const candidates = [
    data.last_screenshot,
    data.screenshot_url,
    data.screenshot_b64,
    data.screenshot,
  ];
  if (Array.isArray(data.steps)) {
    for (let i = data.steps.length - 1; i >= 0; i--) {
      const o = data.steps[i]?.observation || {};
      candidates.push(o.screenshot_url, o.screenshot_b64, o.screenshot, o.image_url);
    }
  }
  for (const c of candidates) {
    if (!c || typeof c !== "string") continue;
    if (/^https?:\/\//i.test(c) || c.startsWith("data:image")) return c;
    if (/^[A-Za-z0-9+/=\s]+$/.test(c) && c.replace(/\s/g, "").length > 80) {
      return "data:image/png;base64," + c.replace(/\s/g, "");
    }
  }
  return null;
}

function showScreenshot(src) {
  if (!src) {
    browseShotWrap.hidden = true;
    browseShot.removeAttribute("src");
    return;
  }
  browseShot.src = src;
  browseShotWrap.hidden = false;
}

browseToggle.addEventListener("click", () => {
  const open = browsePanel.hidden;
  browsePanel.hidden = !open;
  browseToggle.setAttribute("aria-pressed", open ? "true" : "false");
  if (open) browseGoal.focus();
});

browseRun.addEventListener("click", runBrowse);
browseGoal.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    runBrowse();
  }
});

async function runBrowse() {
  const goal = browseGoal.value.trim();
  if (!goal) {
    browseGoal.focus();
    return;
  }
  browseRun.disabled = true;
  setBrowseStatus("running", "생각·탐색 중…");
  browseSteps.innerHTML = "";
  browseThinkMeta.textContent = "진행 중";
  if (browseThinking) browseThinking.open = true;
  showScreenshot(null);

  addBubble(`〔웹〕 ${goal}`, "user");
  const pending = addBubble("웹 심부름 가는 중… (생각 과정은 위 패널)", "browse");

  const t0 = performance.now();
  try {
    const res = await fetch(`${API_BASE}/browse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal,
        session_id: sessionId || undefined,
        max_steps: 12,
      }),
    });
    const data = await res.json().catch(() => ({}));
    const ms = Math.round(performance.now() - t0);
    if (data.session_id) {
      sessionId = data.session_id;
      persist();
    }
    renderSteps(data.steps, { llm: data.llm, model: data.model });
    showScreenshot(extractScreenshot(data));

    const reply =
      data.reply ||
      data.error ||
      (res.ok ? "끝났어." : "실패했어.");
    pending.textContent = reply + `\n(${ms}ms · ${data.llm || "?"}${data.model ? " / " + data.model : ""})`;
    if (!res.ok || data.ok === false) {
      pending.classList.add("err");
      setBrowseStatus("error", data.error === "browser_not_configured" ? "미연결" : "오류");
    } else if (data.needs_confirm) {
      setBrowseStatus("error", "확인 필요");
      pending.textContent =
        reply +
        (data.needs_confirm.reason
          ? `\n(확인: ${data.needs_confirm.reason})`
          : "\n(로그인/비밀번호 등 확인이 필요해)");
    } else {
      setBrowseStatus("done", `완료 ${Math.round(ms / 1000)}s`);
    }
  } catch (err) {
    pending.textContent = "웹 연결이 안 되네. " + String(err.message || err);
    pending.classList.add("err");
    setBrowseStatus("error", "오류");
  } finally {
    browseRun.disabled = false;
  }
}
