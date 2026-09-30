const DEFAULT_API = "https://villain-rp-chatbot.e5eeeee.workers.dev";
const params = new URLSearchParams(location.search);
const API_BASE = (params.get("api") || DEFAULT_API).replace(/\/$/, "");

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const apiLabel = document.getElementById("apiLabel");
const stateEl = document.getElementById("state");
apiLabel.textContent = API_BASE;

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
