import { checkGoal, checkAction, isBrowserConfigured } from "../src/browser/safety.js";
import { parseReactAction, BROWSER_TOOLS } from "../src/browser/tools.js";

const fails = [];
function assert(cond, msg) {
  if (!cond) fails.push(msg);
}

assert(checkGoal("열어줘").ok, "normal goal");
assert(checkGoal("아동 성착취").code === "denied_illegal", "csam deny");
assert(checkAction({ action: "open", args: { url: "https://paypal.com/x" } }).code === "blocked_payment", "paypal");
assert(checkAction({ action: "type", args: { selector: "#password", text: "a", is_password: true } }).code === "needs_confirm_password", "pwd gate");
assert(parseReactAction('{"action":"done","args":{"summary":"ok"}}')?.action === "done", "react parse");
assert(BROWSER_TOOLS.length === 6, "six tools");
assert(!isBrowserConfigured({}), "unconfigured");

if (fails.length) {
  console.error("FAIL", fails);
  process.exit(1);
}
console.log("browser-safety-check OK");
