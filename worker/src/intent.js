/**
 * Intent classifier for 채티 — keep in sync with scripts/intent-check.js expectations.
 * Order matters: reject > rival > late > ask_me > warm > repair > ask > chat
 */

export function normalizeUtterance(text) {
  return String(text || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyIntent(text) {
  const t = normalizeUtterance(text);
  if (!t) return "silence";

  // reject / distancing — contact reduction, breakup, block, go-away
  if (
    /(연락\s*(을\s*)?(좀\s*)?(줄이|줄여|그만|하지\s*마|하지마|끊|자제)|그만\s*(좀\s*)?연락|연락\s*(하지\s*)?마|차단|지긋지긋|꺼져|보지\s*말|헤어지|그만\s*하자|싫어\s*너|거리\s*(를\s*)?두|좀\s*떨어져|떨어져\s*있|관심\s*(을\s*)?(끄|꺼)|귀찮|그만\s*해|그만\s*좀|이제\s*그만)/.test(
      t
    )
  ) {
    return "reject";
  }

  // rival / third party
  if (
    /(친구|남친|여친|썸|다른\s*애|동료|그\s*애|딴\s*(사람|애)|다른\s*(사람|남자|여자)).{0,16}(밥|저녁|만났|만나|놀|카페|술|데이트|영화|통화)/.test(
      t
    ) ||
    /(밥|저녁|만났|만나|데이트|카페|술).{0,16}(친구|남친|여친|썸|다른|동료)/.test(t) ||
    /다른\s*(사람|애|남자|여자)\s*(이랑|하고|과|랑)/.test(t)
  ) {
    return "rival";
  }

  // late / unread / busy
  if (/(늦|읽씹|답\s*없|안\s*읽|바쁘|바빴|바빠|바쁜|연락\s*늦|답장\s*늦)/.test(t)) {
    return "late";
  }

  // ask about 채티 (must beat warm/ask)
  if (
    /(오늘|어제).{0,12}(뭐\s*했|어떻게\s*지냈|어땠|어때)|뭐\s*했어\??|뭐\s*했니|뭐해\??|뭐하니|어떻게\s*지냈|요즘\s*어때|너는\s*뭐|네\s*하루|니\s*하루|채티.{0,6}(뭐|어때|하루)/.test(
      t
    )
  ) {
    return "ask_me";
  }

  // warm affection — avoid bare 「좋아」 / 「좋은 …」
  if (
    /(사랑해|사랑한|사랑하|보고\s*싶|그리워|보고싶|편해|고마워|고맙|좋아해|좋아한|너\s*(를\s*)?좋아|네가\s*좋아|니가\s*좋아|난\s*.{0,8}좋아|내가\s*.{0,8}좋아|많이\s*좋아|소중해|아끼)/.test(
      t
    )
  ) {
    return "warm";
  }

  if (/(미안|서운|화났|짜증|걱정)/.test(t)) return "repair";

  if (/[?？]|뭐|어떻게|왜|어디|누구|언제|어때/.test(t)) return "ask";

  return "chat";
}
