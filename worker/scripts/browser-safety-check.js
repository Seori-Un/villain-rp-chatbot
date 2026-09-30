import { checkGoal, checkAction, isBrowserConfigured } from "../src/browser/safety.js";
import { parseReactAction, BROWSER_TOOLS, geminiFunctionDeclarations } from "../src/browser/tools.js";
import { resolveBrowseLlm } from "../src/browser/llm.js";

const fails = [];
function assert(cond, msg) {
  if (!cond) fails.push(msg);
}

assert(checkGoal("열어줘").ok, "normal goal");
assert(checkGoal("아동 성착취").code === "denied_illegal", "csam deny");
assert(checkAction({ action: "open", args: { url: "https://paypal.com/x" } }).code === "blocked_payment", "paypal");
assert(checkAction({ action: "type", args: { selector: "#password", text: "a", is_password: true } }).code === "needs_confirm_password", "pwd gate");
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
console.log("browser-safety-check OK");
