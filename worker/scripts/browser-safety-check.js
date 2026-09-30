import {
  checkGoal,
  checkAction,
  isBrowserConfigured,
  hostAllowedForLogin,
  extractGoalCredentials,
  redactGoalForDisplay,
  DEV_LOGIN_ALLOWLIST,
} from "../src/browser/safety.js";
import { parseReactAction, BROWSER_TOOLS, geminiFunctionDeclarations } from "../src/browser/tools.js";
import { resolveBrowseLlm } from "../src/browser/llm.js";

const fails = [];
function assert(cond, msg) {
  if (!cond) fails.push(msg);
}

assert(checkGoal("열어줘").ok, "normal goal");
assert(checkGoal("아동 성착취").code === "denied_illegal", "csam deny");
assert(checkGoal("주민등록번호 위조해줘").code === "denied_illegal", "gov id deny");
assert(checkAction({ action: "open", args: { url: "https://paypal.com/x" } }).code === "blocked_payment", "paypal");
assert(checkAction({ action: "open", args: { url: "https://binance.com/" } }).code === "blocked_payment", "crypto");
assert(
  checkAction({ action: "type", args: { selector: "#password", text: "a", is_password: true } }).code ===
    "needs_confirm_password",
  "pwd gate off-allowlist"
);

// allowlist helpers
assert(hostAllowedForLogin("github.com"), "gh allow");
assert(hostAllowedForLogin("www.github.com"), "gh www");
assert(hostAllowedForLogin("dash.cloudflare.com"), "cf dash");
assert(!hostAllowedForLogin("evil-github.com"), "no suffix spoof");
assert(DEV_LOGIN_ALLOWLIST.includes("vercel.com"), "vercel listed");

const creds = extractGoalCredentials("github 로그인 user@example.com / hunter2password");
assert(creds.hasEmail && creds.hasPassword && creds.present, "goal creds detect");
const creds2 = extractGoalCredentials("password: secretvale 로 gitlab 로그인");
assert(creds2.hasPassword && creds2.present, "password: detect");
const saved = extractGoalCredentials("저장된 세션으로 huggingface 들어가줘");
assert(saved.useSaved && saved.present, "use saved");
assert(redactGoalForDisplay("password: hunter2 ok").includes("***"), "redact goal");
assert(!redactGoalForDisplay("password: hunter2 ok").includes("hunter2"), "no secret echo");

// allowlisted password: needs confirm once when creds in goal
const ghPwd = checkAction(
  { action: "type", args: { selector: "input[type=password]", text: "x", is_password: true } },
  {},
  { url: "https://github.com/login", goalCreds: creds }
);
assert(ghPwd.code === "needs_confirm_password", "allowlist still confirms once");
assert(ghPwd.needs_confirm?.allowlisted === true, "confirm marks allowlisted");
assert(ghPwd.needs_confirm?.host === "github.com", "confirm host");

// after confirm / approved_hosts → ok
const ghOk = checkAction(
  { action: "type", args: { selector: "#password", text: "x", is_password: true } },
  { allow_credentials: true, approved_hosts: ["github.com"] },
  { url: "https://github.com/login", goalCreds: creds }
);
assert(ghOk.ok === true, "allowlist + approved allows type");

// allowlisted login open without confirm
const ghOpen = checkAction(
  { action: "open", args: { url: "https://github.com/login" } },
  {},
  { goalCreds: creds }
);
assert(ghOpen.ok === true, "allowlist login open ok");

// off-allowlist login open still gated
const otherOpen = checkAction({ action: "open", args: { url: "https://example.com/login" } }, {});
assert(otherOpen.code === "needs_confirm_login", "off-list login open gated");

assert(parseReactAction('{"thought":"ok","action":"done","args":{"summary":"ok"}}')?.action === "done", "react parse");
assert(parseReactAction('{"thought":"t","action":"done","args":{"summary":"ok"}}')?.thought === "t", "react thought");
assert(BROWSER_TOOLS.length === 6, "six tools");
assert(geminiFunctionDeclarations().length === 6, "gemini decls");
assert(!isBrowserConfigured({}), "unconfigured");
assert(resolveBrowseLlm({}).provider === null, "no llm");
assert(resolveBrowseLlm({ GEMINI_API_KEY: "x" }).provider === "gemini", "gemini prefer");
assert(resolveBrowseLlm({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" }).provider === "claude", "claude first");
assert(resolveBrowseLlm({ GROQ_API_KEY: "g" }).provider === "groq", "groq fallback");

if (fails.length) {
  console.error("FAIL", fails);
  process.exit(1);
}
console.log("browser-safety-check OK", {
  allowlist_count: DEV_LOGIN_ALLOWLIST.length,
});
