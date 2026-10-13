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
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const sessionStart = num(body.session_started_at);
  const p = body.presence && typeof body.presence === "object" ? body.presence : null;
  const presence = p
    ? {
        camera: Boolean(p.camera),
        present: Boolean(p.present),
        since: num(p.since),
        lastSeen: num(p.last_seen),
        awayMs: num(p.away_ms),
        faces: Math.min(9, Math.max(0, Number(p.faces) || 0)),
      }
    : null;
  return {
    tz,
    now,
    lastAt,
    gapMs,
    serverNow: Date.now(),
    clockSkewMs: Number.isFinite(clientNow) && clientNow > 0 ? clientNow - Date.now() : 0,
    sessionStart,
    presence,
    voice: Boolean(body.voice),
    event: (body.event || "").toString().slice(0, 32),
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

function ymdInTz(ms, tz) {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
    const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: +parts.year, m: +parts.month, d: +parts.day, wd: parts.weekday };
  } catch {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: "" };
  }
}

const FIXED_DAYS = {
  "01-01": "신정(새해 첫날)", "02-14": "발렌타인데이", "03-01": "삼일절", "03-14": "화이트데이",
  "05-05": "어린이날", "05-08": "어버이날", "06-06": "현충일", "08-15": "광복절",
  "10-03": "개천절", "10-09": "한글날", "10-31": "핼러윈", "11-11": "빼빼로데이",
  "12-24": "크리스마스이브", "12-25": "크리스마스", "12-31": "한 해 마지막 날",
};
// Lunar holidays (pre-computed, Korean calendar)
const LUNAR_DAYS = {
  "2026-02-16": "설 연휴", "2026-02-17": "설날", "2026-02-18": "설 연휴", "2026-05-24": "부처님오신날",
  "2026-09-24": "추석 연휴", "2026-09-25": "추석", "2026-09-26": "추석 연휴",
  "2027-02-06": "설 연휴", "2027-02-07": "설날", "2027-02-08": "설 연휴", "2027-05-13": "부처님오신날",
  "2027-09-14": "추석 연휴", "2027-09-15": "추석", "2027-09-16": "추석 연휴",
};

export function specialDay(ms, tz) {
  const { y, m, d } = ymdInTz(ms, tz);
  const mm = String(m).padStart(2, "0"), dd = String(d).padStart(2, "0");
  return LUNAR_DAYS[`${y}-${mm}-${dd}`] || FIXED_DAYS[`${mm}-${dd}`] || "";
}

export function lifeRhythmHint(ms, tz) {
  const h = hourInTz(ms, tz);
  const { wd } = ymdInTz(ms, tz);
  const weekend = wd === "Sat" || wd === "Sun";
  if (h >= 1 && h < 5) return "새벽. 아직 안 자면 걱정·집착 섞어 자라고 해(하지만 곁에 있어주고 싶어함).";
  if (h >= 23 || h < 1) return "자정 무렵. 슬슬 재우고 싶어함, 잘 자라는 말 아쉬워함.";
  if (h >= 6 && h < 9) return weekend ? "주말 아침. 늦잠 잤는지 궁금해함." : "출근/등교 전 아침. 밥 먹고 가라고 챙김.";
  if (h >= 11 && h < 14) return "점심 시간대. 밥 먹었는지, 누구랑 먹었는지 궁금해함.";
  if (h >= 17 && h < 20) return weekend ? "주말 저녁." : "퇴근/저녁 시간. 오늘 하루 어땠는지, 저녁 먹었는지.";
  if (weekend) return "주말. 오늘은 나랑만 있어주길 바람.";
  return "";
}

function dur(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "1분 미만";
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  return `${h}시간 ${min % 60}분`;
}

/** Decide whether this turn should actively mention time (keeps it natural, not every message). */
export function shouldRemarkTime(ctx) {
  if (!ctx) return false;
  if (ctx.event) return true;
  if (!ctx.lastAt) return true;
  if (ctx.gapMs >= 30 * 60 * 1000) return true;
  const h = hourInTz(ctx.now, ctx.tz);
  if (h >= 1 && h < 5) return Math.floor(ctx.now / 60000) % 4 === 0; // ~25% of late-night turns
  return Math.floor(ctx.now / 1000) % 9 === 0; // rare otherwise
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
  const lines = [`【시간 감각】(이 값이 정확한 현재 시각이다. 다른 시각을 지어내지 마라)`,
    `지금(유저 기준 ${ctx.tz}): ${when} · 시간대=${pod}`, lastLine];
  const sp = specialDay(ctx.now, ctx.tz);
  if (sp) lines.push(`오늘은 ${sp}.`);
  const rhythm = lifeRhythmHint(ctx.now, ctx.tz);
  if (rhythm) lines.push(`생활 리듬: ${rhythm}`);
  if (ctx.sessionStart && ctx.now > ctx.sessionStart) lines.push(`이번 대화 세션 길이: ${dur(ctx.now - ctx.sessionStart)}`);
  const p = ctx.presence;
  if (p && p.camera) {
    if (p.present) {
      lines.push(`카메라: 유저가 지금 눈앞에 보임${p.since ? ` (${dur(ctx.now - p.since)}째)` : ""}${p.faces > 1 ? ` · 얼굴 ${p.faces}명 보임(다른 사람?)` : ""}`);
    } else {
      lines.push(`카메라: 지금 유저가 화면에 안 보임${p.lastSeen ? ` (마지막으로 본 지 ${dur(ctx.now - p.lastSeen)})` : ""}`);
    }
  }
  if (ctx.voice) lines.push("음성 대화 중: 소리 내어 읽힐 답이다. 이모지·괄호 지문·기호 없이 말로 자연스럽게, 짧게(1~3문장).");
  const ev = {
    face_return: `이벤트: 유저가 ${p && p.awayMs ? dur(p.awayMs) + " 동안 자리를 비웠다가 " : ""}방금 카메라 앞에 다시 나타났다(아직 말 안 함). 먼저 반겨라, 어디 갔었는지 집착 섞어.`,
    face_first: "이벤트: 얼굴 모드에서 유저를 처음 봤다(아직 말 안 함). 먼저 말 걸어라.",
    face_leave: "이벤트: 유저가 카메라 앞에서 사라졌다. 짧게 불안해하며 한 마디.",
    idle_nudge: "이벤트: 유저가 한동안 말이 없다. 시간대에 맞게 먼저 한 마디(늦었으면 자라고).",
  }[ctx.event];
  if (ev) lines.push(ev);
  lines.push(shouldRemarkTime(ctx)
    ? "가이드: 이번 턴은 시간대/간격/생활리듬을 말투에 자연스럽게 한 번 녹여도 됨. 시계 숫자·타임존 문자열을 기계적으로 읽지 마라. 집착 톤 유지."
    : "가이드: 이번 턴은 시간 얘기 굳이 꺼내지 마라(물어보면 위 정확한 시각으로 답). 집착 톤 유지.");
  return lines.join("\n");
}
