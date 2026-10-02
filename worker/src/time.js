/**
 * Time awareness helpers for 채티 RP prompts.
 * Prefer client timezone + client_now; fall back to Asia/Seoul / server clock.
 */

export function resolveTimeContext(body = {}, botLastAt = 0) {
  const tzRaw = (body.timezone || body.tz || "Asia/Seoul").toString().trim();
  const tz = tzRaw.slice(0, 64) || "Asia/Seoul";
  const clientNow = Number(body.client_now ?? body.clientNow);
  const now = Number.isFinite(clientNow) && clientNow > 0 ? clientNow : Date.now();
  const lastBody = Number(body.last_message_at ?? body.lastMessageAt);
  const lastBot = Number(botLastAt);
  const lastAt = Math.max(
    Number.isFinite(lastBody) && lastBody > 0 ? lastBody : 0,
    Number.isFinite(lastBot) && lastBot > 0 ? lastBot : 0
  );
  const gapMs = lastAt > 0 ? Math.max(0, now - lastAt) : 0;
  return {
    tz,
    now,
    lastAt,
    gapMs,
    serverNow: Date.now(),
  };
}

export function hourInTz(ms, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const h = parts.find((p) => p.type === "hour");
    const n = Number(h?.value);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return new Date(ms).getUTCHours();
  }
}

export function partOfDay(ms, tz) {
  const hour = hourInTz(ms, tz);
  if (hour >= 5 && hour < 11) return "아침";
  if (hour >= 11 && hour < 17) return "낮";
  if (hour >= 17 && hour < 22) return "저녁";
  return "밤/심야";
}

export function formatKoreanTime(ms, tz) {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function describeGap(gapMs) {
  if (!gapMs || gapMs < 2 * 60 * 1000) return "방금 이어서(거의 공백 없음)";
  const min = Math.floor(gapMs / 60000);
  if (min < 60) return `약 ${min}분 만에 다시 옴`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `약 ${hr}시간 만에 다시 옴`;
  const d = Math.floor(hr / 24);
  if (d === 1) return "약 하루 만에 다시 옴(조금 오랜만)";
  if (d < 14) return `약 ${d}일 만에 다시 옴(오랜만)`;
  const w = Math.floor(d / 7);
  return `약 ${w}주 이상 만에 다시 옴(아주 오랜만)`;
}

/** Soft-boost chat/ask → late when the real gap is long. */
export function maybeBoostLateIntent(intent, gapMs) {
  if (gapMs >= 6 * 60 * 60 * 1000 && (intent === "chat" || intent === "ask")) {
    return "late";
  }
  return intent;
}

/**
 * Block injected into system prompt each turn.
 */
export function formatTimePromptBlock(ctx) {
  if (!ctx || !ctx.now) return "";
  const when = formatKoreanTime(ctx.now, ctx.tz);
  const pod = partOfDay(ctx.now, ctx.tz);
  const gap = describeGap(ctx.gapMs);
  const lastLine =
    ctx.lastAt > 0
      ? `이전 메시지: ${formatKoreanTime(ctx.lastAt, ctx.tz)} · ${gap}`
      : "이전 메시지: (이 세션에서 첫 말, 또는 시각 정보 없음)";
  return `【시간 감각】
지금(유저 기준 ${ctx.tz}): ${when} · 시간대=${pod}
${lastLine}
가이드: 간격·시간대를 말투·감정에만 자연스럽게 녹여라(예: 오랜만, 밤늦게, 아침에 또). 시계 숫자·타임존 문자열을 그대로 읽지 마라. 매 턴 시간 멘트 강요 금지. 집착 톤은 유지.`;
}
