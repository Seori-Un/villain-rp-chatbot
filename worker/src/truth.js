/**
 * 아는 척 금지 — 채티가 답한 뒤, 근거 없는 사실 주장을 잡아내서 고쳐 말하게 한다.
 *
 *  needsCheck(reply, ctx)                → 이 답을 검사할 가치가 있나 (잡담은 건너뜀)
 *  verifyAnswer(env, {reply, userText, evidence, plan}) → {claims:[{text,status,why}], unsupported:[...], ok}
 *  truthBlock(result)                    → 다시 답할 때 붙이는 블록
 *  evidenceGaps(plan, web, mem, userText) → 답하기 전에 이미 아는 "근거 없음" (검색 실패, 기억 없음)
 *
 * status: supported(근거 있음) | common(상식) | unsupported(근거 없는 구체 주장) | fabricated_memory(없는 기억) | hedged(추측이라고 밝힘)
 */

import { completeText } from "./llm-text.js";
import { extractFirstJsonObject } from "./browser/tools.js";

const FACTY =
  /\d{2,}|\d+\s*(년|월|일|시|분|원|달러|%|퍼센트|명|개|회|번|km|kg|cm|m\b)|(출시|발표|발매|개봉|설립|창립|사망|태어|졸업|우승|기록|버전|v\d)|(이름은|이라고\s*해|라고\s*불|위치|주소|가격|요금|시세|순위|최신|최근|현재|지금은|작년|올해|내년)|(기억나|기억해|말했잖|했었잖|네가\s*(전에|지난번|저번에)|우리\s*(전에|지난번))|[A-Z][a-zA-Z]{2,}/;

export function needsCheck(reply, { plan = null, web = null, mem = null, userText = "" } = {}) {
  const r = String(reply || "");
  if (!r.trim() || r.length < 12) return false;
  if (plan && plan.needs_web) return true;
  if ((mem && mem.asked) || (plan && plan.knowledge === "memory")) return true; // user asked about the past
  if (FACTY.test(r)) return true;
  if (/(뭐야|뭐지|누구|언제|어디|얼마|몇|어떻게|왜|맞아\?|맞지\?|알아\?|아니야\?)/.test(userText) && r.length > 40) return true;
  return false;
}

/** Things we already know are missing before 채티 even answers. */
export function evidenceGaps({ plan = null, web = null, mem = null, userText = "" } = {}) {
  const gaps = [];
  if (plan && plan.needs_web && (!web || !web.sources || !web.sources.length)) {
    gaps.push("검색이 필요했는데 결과를 못 얻었다. 그 사실은 단언하지 말고, 모른다고 하거나 다시 찾아보겠다고 해라. 숫자·날짜·이름을 지어내지 마라.");
  }
  const askedPast = Boolean((mem && mem.asked) || (plan && plan.knowledge === "memory"));
  if (askedPast && !(mem && mem.used && (mem.used.hits || mem.used.days || mem.used.topics))) {
    gaps.push("상대가 예전 일을 묻는데 저장된 기억에 아무것도 없다. '기억난다'고 하지 마라. 솔직하게 '그건 나한테 말 안 해 준 것 같은데' / '기억이 안 나, 다시 말해 줘'로. 내용을 지어내면 안 된다.");
  }
  if (plan && plan.knowledge === "unknowable") {
    gaps.push("이건 네가 알 수 없는 것(상대의 사적인 일, 미래, 남의 속마음 등)이다. 아는 척하지 말고 되묻거나 추측이라고 밝혀라.");
  }
  return gaps;
}

const VERIFY_SYSTEM = `너는 채티의 양심이다. 채티가 방금 한 말에서 '사실처럼 말한 것'을 골라내고, 근거가 있는지 가른다.
근거 = 아래 주어진 웹 자료·기억·상대가 방금 한 말. 그 밖의 것은 일반 상식이거나 근거 없는 주장이다.
감정·의견·말투·질문·요청·농담은 사실 주장이 아니다 (건드리지 마라).
각 주장에 status:
- "supported": 주어진 근거에 있다
- "common": 누구나 아는 안정된 상식 (예: 물은 100도에서 끓는다, 서울은 한국 수도)
- "hedged": 채티가 이미 "아마/~인 것 같아/확실하진 않은데"라고 밝혔다
- "unsupported": 구체적(숫자·날짜·이름·사건·순위·가격·버전·장소)인데 근거도 없고 상식도 아니다 → 문제
- "fabricated_memory": "너 전에 ~라고 했잖아/우리 ~했잖아"처럼 기억을 말하는데 기억 자료에 없다 → 문제
JSON만: {"claims":[{"text":"주장 요약","status":"...","why":"한 줄"}],"verdict":"ok|fix"}
verdict는 unsupported나 fabricated_memory가 하나라도 있으면 "fix".`;

/**
 * @returns {Promise<{claims:Array, unsupported:Array, ok:boolean, error?:string}>}
 */
export async function verifyAnswer(env, { reply, userText, evidence = {}, plan = null }) {
  const ev = [];
  if (evidence.web) ev.push("〈웹 자료〉\n" + String(evidence.web).slice(0, 5000));
  if (evidence.memory) ev.push("〈기억〉\n" + String(evidence.memory).slice(0, 3000));
  if (evidence.hearing) ev.push("〈듣기 보정〉\n" + String(evidence.hearing).slice(0, 300));
  const user = [
    `상대가 방금 한 말: ${String(userText || "").slice(0, 400)}`,
    ev.length ? ev.join("\n\n") : "〈근거 자료 없음 — 상식 외에는 전부 근거 없음〉",
    `\n채티의 답:\n${String(reply || "").slice(0, 1600)}`,
    "\nJSON:",
  ].join("\n");
  try {
    const out = await completeText(env, { system: VERIFY_SYSTEM, user, maxTokens: 500, temperature: 0.1, timeoutMs: 14000 });
    const obj = extractFirstJsonObject(out.text) || {};
    const claims = (Array.isArray(obj.claims) ? obj.claims : [])
      .map((c) => ({ text: String(c.text || "").slice(0, 140), status: String(c.status || "").slice(0, 24), why: String(c.why || "").slice(0, 120) }))
      .filter((c) => c.text);
    const unsupported = claims.filter((c) => c.status === "unsupported" || c.status === "fabricated_memory");
    return { claims, unsupported, ok: !unsupported.length, provider: out.provider };
  } catch (e) {
    return { claims: [], unsupported: [], ok: true, error: String(e.message || e).slice(0, 100) };
  }
}

export function truthBlock(result) {
  if (!result || !result.unsupported?.length) return "";
  return [
    "【다시 말하기】 방금 네 답에 근거 없는 말이 섞였다. 같은 감정·같은 말투로 다시 답하되:",
    ...result.unsupported.map((c) => `- "${c.text}" — ${c.status === "fabricated_memory" ? "그런 기억이 없다. 기억난다고 하지 마라" : "근거가 없다. 빼거나, 모른다고 하거나, 추측이라고 분명히 해라"}${c.why ? ` (${c.why})` : ""}`),
    "모르는 건 모른다고 하는 게 채티다. 아는 척은 상대를 속이는 거고, 채티는 이 사람한테만은 그러지 않는다. 필요하면 '찾아볼게' 또는 되묻기.",
  ].join("\n");
}

/** Short line for the thinking panel. */
export function truthSummary(result, revised) {
  if (!result || !result.claims?.length) return "";
  const n = result.claims.length;
  const bad = result.unsupported.length;
  if (!bad) return `사실 확인: 주장 ${n}개 모두 근거 있음/상식`;
  return `사실 확인: 근거 없는 말 ${bad}개 (${result.unsupported.map((c) => c.text).join(" / ").slice(0, 120)}) → ${revised ? "고쳐 말함" : "표시만"}`;
}
