const DEFAULT_API = "https://villain-rp-chatbot.e5eeeee.workers.dev";
const params = new URLSearchParams(location.search);
const API_BASE = (params.get("api") || DEFAULT_API).replace(/\/$/, "");

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const apiLabel = document.getElementById("apiLabel");
apiLabel.textContent = API_BASE;

const history = [];

function addBubble(text, role) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

addBubble("뭐. 내키면 들어주지. PDF 얘기면… 그건 좀 다르지.", "bot");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  addBubble(message, "user");
  history.push({ role: "user", content: message });
  const btn = form.querySelector("button");
  btn.disabled = true;
  const pending = addBubble("… 생각 중. 좀 기다려.", "bot");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), 120000);
  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    const reply =
      data.reply || data.error || "응답이 비었네. 시시해.";
    pending.textContent = reply;
    if (!res.ok) pending.classList.add("err");
    history.push({ role: "assistant", content: reply });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    let hint = msg;
    if (/load failed|failed to fetch|networkerror|abort/i.test(msg)) {
      hint =
        "브라우저 연결이 끊겼어 (Load failed). Worker·Kaggle/ngrok이 살아 있는지, VPN/광고차단이 workers.dev를 막지 않는지 보라구.";
    }
    pending.textContent = "연결이 안 되네. " + hint;
    pending.classList.add("err");
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    input.focus();
  }
});
