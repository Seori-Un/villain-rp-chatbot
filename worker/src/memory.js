/**
 * 채티 장기 기억 — Cloudflare D1 (binding: env.DB, schema: migrations/0001_memory.sql)
 *
 *  저장   appendMessages()      every /chat & /browse turn (server-side, waitUntil)
 *  회상   recall()              before each reply: recent days + time-range + FTS excerpts + topics → 【기억】 block
 *  정리   digest()              conversation summaries → day summaries → topic clustering (LLM, bounded per run)
 *  조회   listTimeline / getConversation / listTopics / getTopic / searchMessages / deleteMemory
 *
 * Identity: user_id is a client-generated "기억 코드" (frontend localStorage; paste on another device to link).
 * No env.DB → every function is a no-op and chat works exactly as before.
 */

import { completeText } from "./llm-text.js";
import { extractFirstJsonObject } from "./browser/tools.js";

export function memoryEnabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === "function");
}

export function cleanUserId(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[a-z0-9_-]{6,64}$/.test(s) ? s : "";
}
export function cleanId(v) {
  const s = String(v || "").trim();
  return /^[a-zA-Z0-9_-]{4,64}$/.test(s) ? s : "";
}

export function dayOf(ts, tz = "Asia/Seoul") {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}
function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtTime(ts, tz) {
  try {
    return new Intl.DateTimeFormat("ko-KR", { timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}
function fmtDay(day) {
  const [y, m, d] = day.split("-");
  const wd = ["일", "월", "화", "수", "목", "금", "토"][new Date(day + "T00:00:00Z").getUTCDay()];
  return `${Number(m)}/${Number(d)}(${wd})`;
}

/* ---------------------------------------------------------------- store */

/**
 * @param {object} env
 * @param {{user_id:string, conv_id:string, mode?:string, tz?:string, messages:Array<{role:string,content:string,kind?:string,ts?:number,meta?:object}>}} p
 */
export async function appendMessages(env, p) {
  if (!memoryEnabled(env)) return { ok: false, error: "memory_disabled" };
  const user_id = cleanUserId(p.user_id);
  const conv_id = cleanId(p.conv_id);
  if (!user_id || !conv_id) return { ok: false, error: "bad_ids" };
  const tz = String(p.tz || "Asia/Seoul").slice(0, 64);
  const mode = p.mode === "secretary" ? "secretary" : "rp";
  const msgs = (p.messages || [])
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 8000),
      kind: String(m.kind || "chat").slice(0, 16),
      ts: Number(m.ts) > 0 ? Number(m.ts) : Date.now(),
      meta: m.meta ? JSON.stringify(m.meta).slice(0, 4000) : "",
    }))
    .filter((m) => m.content.trim());
  if (!msgs.length) return { ok: true, inserted: 0 };

  const now = Date.now();
  const firstUser = msgs.find((m) => m.role === "user");
  const title = firstUser ? firstUser.content.replace(/\s+/g, " ").slice(0, 60) : "";
  const stmts = [
    env.DB.prepare(
      `INSERT INTO conversations (id, user_id, title, mode, tz, started_at, updated_at, message_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
         title = CASE WHEN conversations.title = '' THEN excluded.title ELSE conversations.title END`
    ).bind(conv_id, user_id, title, mode, tz, msgs[0].ts),
    ...msgs.map((m) =>
      env.DB.prepare(
        `INSERT INTO messages (conv_id, user_id, role, content, kind, ts, day, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(conv_id, user_id, m.role, m.content, m.kind, m.ts, dayOf(m.ts, tz), m.meta)
    ),
    env.DB.prepare(`UPDATE conversations SET message_count = message_count + ?2, updated_at = ?3, topic_done = 0 WHERE id = ?1`).bind(
      conv_id,
      msgs.length,
      now
    ),
    ...[...new Set(msgs.map((m) => dayOf(m.ts, tz)))].map((day) =>
      env.DB.prepare(
        `INSERT INTO day_summaries (user_id, day, message_count, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, day) DO UPDATE SET message_count = day_summaries.message_count + excluded.message_count`
      ).bind(user_id, day, msgs.filter((m) => dayOf(m.ts, tz) === day).length, now)
    ),
  ];
  await env.DB.batch(stmts);
  return { ok: true, inserted: msgs.length };
}

/* ---------------------------------------------------------------- read */

export async function listTimeline(env, user_id, { days = 14, before = "" } = {}) {
  if (!memoryEnabled(env)) return { days: [] };
  const n = Math.max(1, Math.min(60, Number(days) || 14));
  const sql = before
    ? `SELECT * FROM day_summaries WHERE user_id = ?1 AND day < ?2 AND message_count > 0 ORDER BY day DESC LIMIT ?3`
    : `SELECT * FROM day_summaries WHERE user_id = ?1 AND message_count > 0 ORDER BY day DESC LIMIT ?2`;
  const stmt = before ? env.DB.prepare(sql).bind(user_id, before, n) : env.DB.prepare(sql).bind(user_id, n);
  const { results: dayRows } = await stmt.all();
  if (!dayRows.length) return { days: [] };
  const minDay = dayRows[dayRows.length - 1].day;
  const maxDay = dayRows[0].day;
  const { results: convRows } = await env.DB.prepare(
    `SELECT c.id, c.title, c.mode, c.summary, c.message_count, c.started_at, c.updated_at, c.tz,
            MIN(m.day) AS first_day, MAX(m.day) AS last_day
       FROM conversations c JOIN messages m ON m.conv_id = c.id
      WHERE c.user_id = ?1 AND m.day BETWEEN ?2 AND ?3
      GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 300`
  )
    .bind(user_id, minDay, maxDay)
    .all();
  const out = dayRows.map((d) => ({
    day: d.day,
    label: fmtDay(d.day),
    summary: d.summary || "",
    highlights: safeArr(d.highlights),
    message_count: d.message_count,
    pending: d.message_count > (d.summarized_count || 0),
    conversations: convRows
      .filter((c) => c.first_day <= d.day && c.last_day >= d.day)
      .map((c) => ({
        id: c.id,
        title: c.title || "(제목 없음)",
        mode: c.mode,
        summary: c.summary || "",
        message_count: c.message_count,
        started_at: c.started_at,
        updated_at: c.updated_at,
        time: fmtTime(c.started_at, c.tz || "Asia/Seoul"),
      })),
  }));
  return { days: out, next_before: minDay };
}

export async function getConversation(env, user_id, conv_id, { limit = 300 } = {}) {
  if (!memoryEnabled(env)) return null;
  const conv = await env.DB.prepare(`SELECT * FROM conversations WHERE id = ?1 AND user_id = ?2`).bind(conv_id, user_id).first();
  if (!conv) return null;
  const { results } = await env.DB.prepare(
    `SELECT id, role, content, kind, ts, meta FROM messages WHERE conv_id = ?1 AND user_id = ?2 ORDER BY ts ASC, id ASC LIMIT ?3`
  )
    .bind(conv_id, user_id, Math.min(1000, Number(limit) || 300))
    .all();
  const { results: topics } = await env.DB.prepare(
    `SELECT t.id, t.name FROM topic_links l JOIN topics t ON t.id = l.topic_id WHERE l.conv_id = ?1 AND l.user_id = ?2`
  )
    .bind(conv_id, user_id)
    .all();
  return {
    id: conv.id,
    title: conv.title,
    mode: conv.mode,
    summary: conv.summary,
    started_at: conv.started_at,
    updated_at: conv.updated_at,
    message_count: conv.message_count,
    topics,
    messages: results.map((m) => ({ ...m, meta: m.meta ? safeObj(m.meta) : null })),
  };
}

export async function listTopics(env, user_id) {
  if (!memoryEnabled(env)) return { topics: [] };
  const { results } = await env.DB.prepare(
    `SELECT id, name, summary, keywords, conv_count, updated_at FROM topics WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 100`
  )
    .bind(user_id)
    .all();
  return { topics: results };
}

export async function getTopic(env, user_id, topic_id) {
  if (!memoryEnabled(env)) return null;
  const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?1 AND user_id = ?2`).bind(topic_id, user_id).first();
  if (!topic) return null;
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.title, c.summary, c.started_at, c.tz, c.message_count, l.snippet
       FROM topic_links l JOIN conversations c ON c.id = l.conv_id
      WHERE l.topic_id = ?1 AND l.user_id = ?2 ORDER BY l.ts DESC LIMIT 100`
  )
    .bind(topic_id, user_id)
    .all();
  return {
    ...topic,
    conversations: results.map((c) => ({ ...c, time: fmtTime(c.started_at, c.tz || "Asia/Seoul") })),
  };
}

/** Build an FTS5 prefix query from free text (Korean particles stripped, stems prefix-matched). */
export function ftsQuery(text) {
  const PART = /(은|는|이|가|을|를|에서|에게|에|도|로|으로|의|랑|이랑|하고|까지|부터|만|뭐|요|야|지|니|냐)$/;
  const STOP = new Set(["그리고", "그런데", "하지만", "근데", "있어", "없어", "했어", "거야", "뭐야", "어때", "얘기", "이야기", "지난주", "지난달", "어제", "오늘", "그제", "저번", "지난", "우리", "그거", "그건", "말했", "했지", "했었", "했던"]);
  const toks = String(text || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => (t.length >= 3 ? t.replace(PART, "") : t))
    .filter((t) => t.length >= 2 && !STOP.has(t));
  const uniq = [...new Set(toks)].slice(0, 6);
  // prefix match per stem: 날씨* matches 날씨가/날씨는/날씨였어
  return uniq.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
}

export async function searchMessages(env, user_id, q, { limit = 8, exclude_conv = "" } = {}) {
  if (!memoryEnabled(env)) return { hits: [] };
  const fq = ftsQuery(q);
  if (!fq) return { hits: [], query: "" };
  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.conv_id, m.role, m.content, m.ts, m.day, c.title, c.tz, c.summary AS conv_summary
         FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN conversations c ON c.id = m.conv_id
        WHERE messages_fts MATCH ?1 AND m.user_id = ?2 AND m.conv_id != ?3
        ORDER BY rank LIMIT ?4`
    )
      .bind(fq, user_id, exclude_conv || "-", Math.min(30, Number(limit) || 8))
      .all();
    rows = results;
  } catch (e) {
    return { hits: [], query: fq, error: String(e.message || e).slice(0, 120) };
  }
  // pull the reply right after each hit for context
  const hits = [];
  for (const r of rows) {
    const next = await env.DB.prepare(
      `SELECT role, content FROM messages WHERE conv_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT 1`
    )
      .bind(r.conv_id, r.id)
      .first();
    hits.push({
      conv_id: r.conv_id,
      title: r.title,
      day: r.day,
      time: fmtTime(r.ts, r.tz || "Asia/Seoul"),
      role: r.role,
      content: r.content.slice(0, 400),
      next: next ? { role: next.role, content: String(next.content).slice(0, 300) } : null,
      conv_summary: r.conv_summary || "",
    });
  }
  return { hits, query: fq };
}

export async function deleteMemory(env, user_id, scope, id) {
  if (!memoryEnabled(env)) return { ok: false, error: "memory_disabled" };
  const u = user_id;
  if (scope === "all") {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM messages WHERE user_id = ?1`).bind(u),
      env.DB.prepare(`DELETE FROM conversations WHERE user_id = ?1`).bind(u),
      env.DB.prepare(`DELETE FROM day_summaries WHERE user_id = ?1`).bind(u),
      env.DB.prepare(`DELETE FROM topic_links WHERE user_id = ?1`).bind(u),
      env.DB.prepare(`DELETE FROM topics WHERE user_id = ?1`).bind(u),
    ]);
    return { ok: true };
  }
  if (scope === "conversation") {
    const cid = cleanId(id);
    if (!cid) return { ok: false, error: "bad_id" };
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM messages WHERE conv_id = ?1 AND user_id = ?2`).bind(cid, u),
      env.DB.prepare(`DELETE FROM topic_links WHERE conv_id = ?1 AND user_id = ?2`).bind(cid, u),
      env.DB.prepare(`DELETE FROM conversations WHERE id = ?1 AND user_id = ?2`).bind(cid, u),
      env.DB.prepare(`UPDATE topics SET conv_count = (SELECT COUNT(*) FROM topic_links WHERE topic_id = topics.id) WHERE user_id = ?1`).bind(u),
      env.DB.prepare(`DELETE FROM topics WHERE user_id = ?1 AND conv_count = 0`).bind(u),
      // day counts are recomputed by digest; mark dirty
      env.DB.prepare(`UPDATE day_summaries SET summarized_count = -1 WHERE user_id = ?1`).bind(u),
    ]);
    return { ok: true };
  }
  if (scope === "day") {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(id)) ? String(id) : "";
    if (!day) return { ok: false, error: "bad_day" };
    const { results } = await env.DB.prepare(`SELECT DISTINCT conv_id FROM messages WHERE user_id = ?1 AND day = ?2`).bind(u, day).all();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM messages WHERE user_id = ?1 AND day = ?2`).bind(u, day),
      env.DB.prepare(`DELETE FROM day_summaries WHERE user_id = ?1 AND day = ?2`).bind(u, day),
      ...results.map((r) =>
        env.DB.prepare(
          `UPDATE conversations SET message_count = (SELECT COUNT(*) FROM messages WHERE conv_id = ?1), summarized_count = 0, summary = '', topic_done = 0 WHERE id = ?1`
        ).bind(r.conv_id)
      ),
      env.DB.prepare(`DELETE FROM conversations WHERE user_id = ?1 AND message_count = 0`).bind(u),
      env.DB.prepare(`DELETE FROM topic_links WHERE user_id = ?1 AND conv_id NOT IN (SELECT id FROM conversations WHERE user_id = ?1)`).bind(u),
    ]);
    return { ok: true };
  }
  if (scope === "topic") {
    const tid = cleanId(id);
    if (!tid) return { ok: false, error: "bad_id" };
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM topic_links WHERE topic_id = ?1 AND user_id = ?2`).bind(tid, u),
      env.DB.prepare(`DELETE FROM topics WHERE id = ?1 AND user_id = ?2`).bind(tid, u),
    ]);
    return { ok: true };
  }
  return { ok: false, error: "bad_scope" };
}

/* ---------------------------------------------------------------- recall */

/** "어제 / 지난주 / 지난달 / 3일 전 / 지난 5일" → [fromDay, toDay] in user's tz, or null */
export function parseTimeRange(text, now, tz) {
  const t = String(text || "");
  const today = dayOf(now, tz);
  const m = (re) => t.match(re);
  let r;
  if (/그저께|그제/.test(t)) return [addDays(today, -2), addDays(today, -2)];
  if (/어제|어젯밤/.test(t)) return [addDays(today, -1), addDays(today, -1)];
  if (/오늘|아까|조금\s*전/.test(t)) return [today, today];
  if (/지난\s*주|저번\s*주|일주일\s*전|한\s*주\s*전/.test(t)) return [addDays(today, -13), addDays(today, -6)];
  if (/이번\s*주/.test(t)) return [addDays(today, -6), today];
  if (/지난\s*달|저번\s*달|한\s*달\s*전/.test(t)) return [addDays(today, -60), addDays(today, -28)];
  if (/이번\s*달/.test(t)) return [addDays(today, -30), today];
  if ((r = m(/(\d{1,2})\s*일\s*전/))) return [addDays(today, -Number(r[1])), addDays(today, -Number(r[1]))];
  if ((r = m(/지난\s*(\d{1,2})\s*일/))) return [addDays(today, -Number(r[1])), today];
  if ((r = m(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) {
    const y = today.slice(0, 4);
    const d = `${y}-${String(r[1]).padStart(2, "0")}-${String(r[2]).padStart(2, "0")}`;
    return [d, d];
  }
  if (/예전에|전에|언젠가|옛날|처음/.test(t)) return [addDays(today, -365), addDays(today, -2)];
  return null;
}

const PAST_REF = /(기억|얘기했|말했|했었|했잖|했지|했던|말했던|전에|지난|저번|어제|그제|예전|언젠가|그때|그날|무슨\s*얘기|뭐\s*얘기|뭐라고\s*했)/;

/**
 * Pull memory relevant to this turn.
 * @returns {Promise<{block:string, items:object[], used:{days:number,hits:number,topics:number}}>}
 */
export async function recall(env, { user_id, conv_id, text, memory_query = "", now = Date.now(), tz = "Asia/Seoul" }) {
  const empty = { block: "", items: [], used: { days: 0, hits: 0, topics: 0 } };
  if (!memoryEnabled(env) || !user_id) return empty;
  const lines = [];
  const items = [];
  const today = dayOf(now, tz);

  // 1) always: last few days' summaries (short) so 채티 knows what's been going on
  const { results: recent } = await env.DB.prepare(
    `SELECT day, summary, highlights FROM day_summaries WHERE user_id = ?1 AND day < ?2 AND summary != '' ORDER BY day DESC LIMIT 3`
  )
    .bind(user_id, today)
    .all();
  const { results: todayConvs } = await env.DB.prepare(
    `SELECT id, title, summary FROM conversations WHERE user_id = ?1 AND id != ?2 AND updated_at > ?3 AND summary != '' ORDER BY updated_at DESC LIMIT 3`
  )
    .bind(user_id, conv_id || "-", now - 36 * 3600 * 1000)
    .all();
  if (recent.length || todayConvs.length) {
    lines.push("최근 흐름:");
    for (const d of recent) lines.push(`- ${fmtDay(d.day)}: ${d.summary.slice(0, 220)}`);
    for (const c of todayConvs) lines.push(`- 최근 대화 「${c.title}」: ${c.summary.slice(0, 200)}`);
  }

  // 2) explicit time reference → that range's day summaries + conversation titles
  const range = parseTimeRange(text, now, tz);
  if (range && (range[0] !== today || PAST_REF.test(text))) {
    const { results: days } = await env.DB.prepare(
      `SELECT day, summary, highlights, message_count FROM day_summaries WHERE user_id = ?1 AND day BETWEEN ?2 AND ?3 AND message_count > 0 ORDER BY day DESC LIMIT 14`
    )
      .bind(user_id, range[0], range[1])
      .all();
    const { results: convs } = await env.DB.prepare(
      `SELECT DISTINCT c.id, c.title, c.summary, m.day FROM conversations c JOIN messages m ON m.conv_id = c.id
        WHERE c.user_id = ?1 AND m.day BETWEEN ?2 AND ?3 AND c.id != ?4 ORDER BY m.day DESC LIMIT 12`
    )
      .bind(user_id, range[0], range[1], conv_id || "-")
      .all();
    if (days.length || convs.length) {
      lines.push(`기간 ${fmtDay(range[0])}~${fmtDay(range[1])}의 기록:`);
      for (const d of days) {
        lines.push(`- ${fmtDay(d.day)}: ${d.summary ? d.summary.slice(0, 240) : `(대화 ${d.message_count}개, 아직 요약 전)`}`);
        for (const h of safeArr(d.highlights).slice(0, 3)) lines.push(`    · ${h}`);
      }
      const seen = new Set();
      for (const c of convs) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        lines.push(`- ${fmtDay(c.day)} 「${c.title}」${c.summary ? ": " + c.summary.slice(0, 160) : ""}`);
        items.push({ type: "conversation", conv_id: c.id, title: c.title, day: c.day });
      }
    } else {
      lines.push(`기간 ${fmtDay(range[0])}~${fmtDay(range[1])}에는 저장된 대화가 없다. (없으면 없다고 솔직히 말해라)`);
    }
  }

  // 3) FTS excerpts from other conversations
  const q = [memory_query, text].filter(Boolean).join(" ");
  const fts = await searchMessages(env, user_id, q, { limit: 5, exclude_conv: conv_id });
  if (fts.hits.length) {
    lines.push("관련된 예전 대화(원문 일부):");
    for (const h of fts.hits) {
      const who = h.role === "user" ? "유저" : "채티";
      lines.push(`- [${h.time} · ${h.title}] ${who}: ${h.content.slice(0, 160)}${h.next ? ` / ${h.next.role === "user" ? "유저" : "채티"}: ${h.next.content.slice(0, 120)}` : ""}`);
      items.push({ type: "excerpt", conv_id: h.conv_id, title: h.title, day: h.day, time: h.time, text: h.content.slice(0, 160) });
    }
  }

  // 4) topics matched by keyword
  const toks = [...new Set(String(q).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2))].slice(0, 6);
  let topicHits = [];
  if (toks.length) {
    const where = toks.map((_, i) => `(name LIKE ?${i + 2} OR keywords LIKE ?${i + 2})`).join(" OR ");
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, name, summary FROM topics WHERE user_id = ?1 AND (${where}) ORDER BY updated_at DESC LIMIT 3`
      )
        .bind(user_id, ...toks.map((t) => `%${t}%`))
        .all();
      topicHits = results;
    } catch {
      topicHits = [];
    }
  }
  if (topicHits.length) {
    lines.push("관련 주제 요약:");
    for (const t of topicHits) {
      lines.push(`- ${t.name}: ${t.summary.slice(0, 220)}`);
      items.push({ type: "topic", topic_id: t.id, name: t.name });
    }
  }

  const asked = PAST_REF.test(text) || Boolean(memory_query);
  if (asked && !fts.hits.length && !topicHits.length && !(range && lines.some((l) => l.startsWith("기간")))) {
    lines.push("상대가 예전 일을 묻는 것 같은데, 그 내용은 저장된 기억에 없다. 기억난다고 하지 말고 솔직하게 말해라.");
  }
  if (!lines.length) return { ...empty, asked };
  const block = [
    "【기억】(서버에 저장된 이 유저와의 과거 대화. 여기 있는 것만 '기억한다'고 말하고, 없는 건 지어내지 마라. 자연스럽게 녹여라)",
    ...lines,
  ].join("\n");
  return { block, items, asked, used: { days: recent.length, hits: fts.hits.length, topics: topicHits.length } };
}

/* ---------------------------------------------------------------- digest (LLM) */

async function llmJson(env, system, user, maxTokens = 600) {
  const out = await completeText(env, { system, user, maxTokens, temperature: 0.2, timeoutMs: 25000 });
  return extractFirstJsonObject(out.text) || {};
}

async function summarizeConversation(env, conv) {
  const { results } = await env.DB.prepare(
    `SELECT role, content, ts FROM messages WHERE conv_id = ?1 ORDER BY ts ASC, id ASC LIMIT 120`
  )
    .bind(conv.id)
    .all();
  if (!results.length) return;
  const transcript = results
    .map((m) => `${m.role === "user" ? "유저" : "채티"}: ${String(m.content).replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n")
    .slice(0, 9000);
  const obj = await llmJson(
    env,
    `대화 기록을 장기 기억용으로 정리한다. JSON만: {"title":"8~20자 제목","summary":"3~5문장. 유저가 말한 사실(이름·일정·취향·사건·감정)을 구체적으로. 채티의 리액션은 짧게","facts":["유저 관련 기억할 사실 0~5개"]}`,
    `이전 요약(있으면 이어서 갱신): ${conv.summary || "(없음)"}\n\n대화:\n${transcript}`
  );
  const summary = [String(obj.summary || "").trim(), ...(Array.isArray(obj.facts) ? obj.facts.map((f) => "· " + String(f)) : [])]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1500);
  if (!summary) return;
  const title = String(obj.title || conv.title || "").slice(0, 60);
  await env.DB.prepare(`UPDATE conversations SET summary = ?2, title = ?3, summarized_count = message_count, topic_done = 0, updated_at = updated_at WHERE id = ?1`)
    .bind(conv.id, summary, title || conv.title)
    .run();
}

async function summarizeDay(env, user_id, day) {
  const { results: convs } = await env.DB.prepare(
    `SELECT DISTINCT c.id, c.title, c.summary FROM conversations c JOIN messages m ON m.conv_id = c.id WHERE c.user_id = ?1 AND m.day = ?2 LIMIT 30`
  )
    .bind(user_id, day)
    .all();
  const { results: msgs } = await env.DB.prepare(
    `SELECT role, content, ts FROM messages WHERE user_id = ?1 AND day = ?2 ORDER BY ts ASC LIMIT 80`
  )
    .bind(user_id, day)
    .all();
  const cnt = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?1 AND day = ?2`).bind(user_id, day).first())?.n || 0;
  if (!cnt) {
    await env.DB.prepare(`DELETE FROM day_summaries WHERE user_id = ?1 AND day = ?2`).bind(user_id, day).run();
    return;
  }
  const material =
    convs.map((c) => `[대화 「${c.title}」] ${c.summary || "(요약 없음)"}`).join("\n") +
    "\n\n원문 샘플:\n" +
    msgs.map((m) => `${m.role === "user" ? "유저" : "채티"}: ${String(m.content).replace(/\s+/g, " ").slice(0, 160)}`).join("\n").slice(0, 6000);
  const obj = await llmJson(
    env,
    `하루치 대화를 일기처럼 정리한다. JSON만: {"summary":"3~5문장, 그날 유저에게 있었던 일·기분·결정 중심, 시간 흐름 순","highlights":["기억할 포인트 2~5개, 각 1문장"]}`,
    `날짜: ${day}\n${material}`
  );
  const summary = String(obj.summary || "").trim().slice(0, 1200);
  const highlights = JSON.stringify((Array.isArray(obj.highlights) ? obj.highlights : []).map((h) => String(h).slice(0, 160)).slice(0, 6));
  await env.DB.prepare(
    `INSERT INTO day_summaries (user_id, day, summary, highlights, message_count, summarized_count, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
     ON CONFLICT(user_id, day) DO UPDATE SET summary = excluded.summary, highlights = excluded.highlights, message_count = excluded.message_count, summarized_count = excluded.message_count, updated_at = excluded.updated_at`
  )
    .bind(user_id, day, summary, highlights, cnt, Date.now())
    .run();
}

async function assignTopic(env, user_id, conv) {
  const { results: topics } = await env.DB.prepare(
    `SELECT id, name, keywords, summary FROM topics WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 40`
  )
    .bind(user_id)
    .all();
  const list = topics.map((t) => `- ${t.name} (${t.keywords})`).join("\n") || "(아직 없음)";
  const obj = await llmJson(
    env,
    `대화 요약을 주제로 분류한다. 기존 주제에 맞으면 그 이름을 그대로 쓰고, 아니면 새 주제 이름(2~8자, 명사형)을 만든다. 한 대화에 주제 1~2개. JSON만:
{"topics":[{"name":"주제명","keywords":"쉼표로 키워드 3~6개","snippet":"이 대화가 이 주제에서 다룬 내용 1문장"}]}`,
    `기존 주제:\n${list}\n\n대화 「${conv.title}」 요약:\n${conv.summary}`
  );
  const picks = (Array.isArray(obj.topics) ? obj.topics : []).slice(0, 2);
  const now = Date.now();
  for (const p of picks) {
    const name = String(p.name || "").trim().slice(0, 40);
    if (!name) continue;
    let topic = topics.find((t) => t.name === name) || topics.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!topic) {
      topic = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 20), name, keywords: String(p.keywords || "").slice(0, 200), summary: "" };
      await env.DB.prepare(`INSERT INTO topics (id, user_id, name, summary, keywords, conv_count, created_at, updated_at) VALUES (?1, ?2, ?3, '', ?4, 0, ?5, ?5)`)
        .bind(topic.id, user_id, name, topic.keywords, now)
        .run();
      topics.push(topic);
    }
    await env.DB.prepare(
      `INSERT INTO topic_links (topic_id, conv_id, user_id, snippet, ts) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(topic_id, conv_id) DO UPDATE SET snippet = excluded.snippet, ts = excluded.ts`
    )
      .bind(topic.id, conv.id, user_id, String(p.snippet || "").slice(0, 300), conv.updated_at || now)
      .run();
    // merge topic summary
    const merged = await llmJson(
      env,
      `주제 요약을 갱신한다. JSON만: {"summary":"이 주제에 대해 유저가 말해 온 것들을 3~5문장으로. 최신 내용 반영, 변화가 있으면 '예전엔 ~ 지금은 ~'","keywords":"쉼표 키워드 3~8개"}`,
      `주제: ${name}\n기존 요약: ${topic.summary || "(없음)"}\n새 대화 요약: ${conv.summary}`
    );
    const summary = String(merged.summary || topic.summary || "").slice(0, 1200);
    const keywords = String(merged.keywords || topic.keywords || "").slice(0, 200);
    await env.DB.prepare(
      `UPDATE topics SET summary = ?2, keywords = ?3, updated_at = ?4, conv_count = (SELECT COUNT(*) FROM topic_links WHERE topic_id = ?1) WHERE id = ?1`
    )
      .bind(topic.id, summary, keywords, now)
      .run();
    topic.summary = summary;
  }
  await env.DB.prepare(`UPDATE conversations SET topic_done = 1 WHERE id = ?1`).bind(conv.id).run();
}

/**
 * Bounded digest pass for one user. Call repeatedly (frontend on load / cron) until `pending` is 0.
 * @returns {Promise<{ok:boolean, did:{conversations:number,days:number,topics:number}, pending:number, error?:string}>}
 */
export async function digest(env, user_id, { maxConvs = 4, maxDays = 3, maxTopics = 4, minIdleMs = 20 * 60 * 1000, force_conv = "" } = {}) {
  const did = { conversations: 0, days: 0, topics: 0 };
  if (!memoryEnabled(env) || !user_id) return { ok: false, did, pending: 0, error: "memory_disabled" };
  const now = Date.now();
  try {
    // repair day counters marked dirty by deletions
    await env.DB.prepare(
      `UPDATE day_summaries SET message_count = (SELECT COUNT(*) FROM messages m WHERE m.user_id = day_summaries.user_id AND m.day = day_summaries.day), summarized_count = 0
        WHERE user_id = ?1 AND summarized_count = -1`
    )
      .bind(user_id)
      .run();

    // 1) conversation summaries: idle for a while, or grown a lot since last summary
    const { results: convs } = await env.DB.prepare(
      `SELECT id, title, summary, message_count, summarized_count, updated_at FROM conversations
        WHERE user_id = ?1 AND message_count > summarized_count AND message_count >= 2
          AND (updated_at < ?2 OR message_count - summarized_count >= 10 OR id = ?3)
        ORDER BY updated_at DESC LIMIT ?4`
    )
      .bind(user_id, now - minIdleMs, force_conv || "-", maxConvs)
      .all();
    for (const c of convs) {
      await summarizeConversation(env, c);
      did.conversations++;
    }

    // 2) day summaries for days with new messages (not today unless idle)
    const { results: days } = await env.DB.prepare(
      `SELECT day FROM day_summaries WHERE user_id = ?1 AND message_count > summarized_count AND updated_at < ?2 ORDER BY day DESC LIMIT ?3`
    )
      .bind(user_id, now - minIdleMs, maxDays)
      .all();
    for (const d of days) {
      await summarizeDay(env, user_id, d.day);
      did.days++;
    }

    // 3) topics for summarized conversations
    const { results: forTopics } = await env.DB.prepare(
      `SELECT id, title, summary, updated_at FROM conversations WHERE user_id = ?1 AND topic_done = 0 AND summary != '' ORDER BY updated_at DESC LIMIT ?2`
    )
      .bind(user_id, maxTopics)
      .all();
    for (const c of forTopics) {
      await assignTopic(env, user_id, c);
      did.topics++;
    }

    const pending =
      ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?1 AND message_count > summarized_count AND message_count >= 2 AND updated_at < ?2`).bind(user_id, now - minIdleMs).first())?.n || 0) +
      ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM day_summaries WHERE user_id = ?1 AND message_count > summarized_count AND updated_at < ?2`).bind(user_id, now - minIdleMs).first())?.n || 0) +
      ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?1 AND topic_done = 0 AND summary != ''`).bind(user_id).first())?.n || 0);
    return { ok: true, did, pending };
  } catch (e) {
    return { ok: false, did, pending: 0, error: String(e.message || e).slice(0, 200) };
  }
}

/** Cron: digest every user active in the last 7 days (bounded). */
export async function digestAll(env) {
  if (!memoryEnabled(env)) return { ok: false };
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM conversations WHERE updated_at > ?1 LIMIT 50`
  )
    .bind(Date.now() - 7 * 86400 * 1000)
    .all();
  const out = [];
  for (const r of results) out.push({ user_id: r.user_id, ...(await digest(env, r.user_id, { maxConvs: 6, maxDays: 4, maxTopics: 6 })) });
  return { ok: true, users: out.length, out };
}

export async function memoryStats(env, user_id) {
  if (!memoryEnabled(env)) return { enabled: false };
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?1`).bind(user_id).first();
  const m = await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(day) AS first_day FROM messages WHERE user_id = ?1`).bind(user_id).first();
  const t = await env.DB.prepare(`SELECT COUNT(*) AS n FROM topics WHERE user_id = ?1`).bind(user_id).first();
  return { enabled: true, conversations: c?.n || 0, messages: m?.n || 0, first_day: m?.first_day || null, topics: t?.n || 0 };
}

function safeArr(s) {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function safeObj(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
