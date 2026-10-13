/**
 * 듣기 — 음성 인식이 잘못 들은 말을 채티가 문맥으로 되살린다.
 *
 *  buildLexicon(env, user_id)        → 이 사람과 쓰는 단어들 (주제 키워드, 대화 제목, 최근 메시지 속 고유명사)
 *  phoneticCandidates(text, lexicon) → 발음이 비슷한 아는 단어 (자모 단위 편집거리)
 *  repairHearing(env, {text, alternatives, confidence, lexicon, recent}) → {text, repaired, confidence, note, ask}
 *
 * 규칙: 확신이 서면 고쳐서 쓰고(화면에 "들린 말 → 이해한 말"), 애매하면 채티가 되묻는다("~라고 한 거야?").
 */

import { completeText } from "./llm-text.js";
import { extractFirstJsonObject } from "./browser/tools.js";
import { memoryEnabled } from "./memory.js";

/* ---------- 자모 분해 ---------- */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
export function toJamo(s) {
  let out = "";
  for (const ch of String(s || "")) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const i = c - 0xac00;
      out += CHO[Math.floor(i / 588)] + JUNG[Math.floor((i % 588) / 28)] + (i % 28 ? JONG[i % 28] : "");
    } else out += ch.toLowerCase();
  }
  return out;
}
// sounds that ASR commonly confuses → same bucket
const SOUND_MAP = { ㅐ: "ㅔ", ㅒ: "ㅖ", ㅙ: "ㅚ", ㅞ: "ㅚ", ㄲ: "ㄱ", ㄸ: "ㄷ", ㅃ: "ㅂ", ㅆ: "ㅅ", ㅉ: "ㅈ", ㅋ: "ㄱ", ㅌ: "ㄷ", ㅍ: "ㅂ", ㅊ: "ㅈ" };
function soundKey(s) {
  return toJamo(s)
    .split("")
    .map((c) => SOUND_MAP[c] || c)
    .join("");
}
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* ---------- 이 사람의 단어장 ---------- */
const STOP = new Set(["그리고", "그런데", "하지만", "근데", "오늘", "어제", "내일", "지금", "진짜", "그냥", "이거", "그거", "저거", "뭐야", "있어", "없어", "채티", "우리", "사람"]);

/** @returns {Promise<string[]>} up to ~120 distinctive words 채티 has heard from this person */
export async function buildLexicon(env, user_id) {
  if (!memoryEnabled(env) || !user_id) return [];
  const words = new Map(); // word → weight
  const add = (w, wt) => {
    w = String(w || "").trim();
    if (w.length < 2 || w.length > 12 || STOP.has(w) || /^\d+$/.test(w)) return;
    words.set(w, (words.get(w) || 0) + wt);
  };
  try {
    const { results: topics } = await env.DB.prepare(`SELECT name, keywords FROM topics WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 40`).bind(user_id).all();
    for (const t of topics) {
      add(t.name, 3);
      for (const k of String(t.keywords || "").split(/[,\s]+/)) add(k, 2);
    }
    const { results: convs } = await env.DB.prepare(`SELECT title FROM conversations WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 60`).bind(user_id).all();
    for (const c of convs) for (const w of tokenize(c.title)) add(w, 1);
    const { results: msgs } = await env.DB.prepare(`SELECT content FROM messages WHERE user_id = ?1 AND role = 'user' ORDER BY ts DESC LIMIT 150`).bind(user_id).all();
    const seen = new Map();
    for (const m of msgs) for (const w of tokenize(m.content)) seen.set(w, (seen.get(w) || 0) + 1);
    // words that recur across messages are "theirs": names, places, projects, slang
    for (const [w, n] of seen) if (n >= 2) add(w, Math.min(3, n * 0.5));
    const { results: feel } = await env.DB.prepare(`SELECT grudge, wish FROM feelings WHERE user_id = ?1`).bind(user_id).all();
    for (const f of feel) for (const w of tokenize(f.grudge + " " + f.wish)) add(w, 1);
  } catch {
    /* tables may not exist yet */
  }
  return [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120).map(([w]) => w);
}

const PART = /(은|는|이|가|을|를|에서|에게|에|도|로|으로|의|랑|이랑|하고|까지|부터|만|요|야|지|니|냐|한테|처럼|보다)$/;
function tokenize(text) {
  return String(text || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => (t.length >= 3 ? t.replace(PART, "") : t))
    .filter((t) => t.length >= 2);
}

/** Known words that sound like something in the transcript. */
export function phoneticCandidates(text, lexicon, { max = 6 } = {}) {
  const out = [];
  const toks = tokenize(text);
  const lexKeys = lexicon.map((w) => [w, soundKey(w)]);
  for (const tok of toks) {
    if (lexicon.includes(tok)) continue;
    const tk = soundKey(tok);
    for (const [w, wk] of lexKeys) {
      if (Math.abs(wk.length - tk.length) > 3) continue;
      const d = lev(tk, wk);
      const limit = tk.length <= 4 ? 1 : tk.length <= 7 ? 2 : 3;
      if (d <= limit && tok !== w) out.push({ heard: tok, maybe: w, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  const uniq = [];
  for (const c of out) if (!uniq.some((u) => u.heard === c.heard && u.maybe === c.maybe)) uniq.push(c);
  return uniq.slice(0, max);
}

/** Heuristic: does this transcript look broken? */
export function looksGarbled(text, confidence) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (confidence > 0 && confidence < 0.6) return true;
  // lots of single syllables / no particles / odd spacing
  const toks = t.split(/\s+/);
  const singles = toks.filter((x) => x.length === 1).length;
  if (toks.length >= 4 && singles / toks.length > 0.4) return true;
  if (/[a-z]{2,}\s*[가-힣]{1,2}\s*[a-z]{2,}/i.test(t)) return true; // mixed garble
  return false;
}

const REPAIR_SYSTEM = `너는 채티의 귀다. 음성 인식기가 적어 준 문장을 받아, 이 사람이 실제로 말했을 문장을 되살린다.
음성 인식은 비슷한 발음(ㅐ/ㅔ, 된소리, 받침), 띄어쓰기, 고유명사(이름·장소·앱·게임·프로젝트), 영어 단어를 자주 틀린다.
단서: 다른 인식 후보들, 이 사람이 자주 쓰는 단어(lexicon), 비슷하게 들리는 아는 단어(candidates), 직전 대화.
원칙:
- 말이 자연스럽게 통하면 그대로 둔다 (고치지 않는 게 기본).
- 확실히 더 말이 되는 복원이 있으면 고친다. 특히 lexicon에 있는 단어로 바뀌면 적극적으로.
- 복원이 둘 이상이고 뜻이 크게 갈리면 고치지 말고 ask에 되물을 짧은 질문을 쓴다 ("OO라고 한 거야?").
JSON만: {"text":"복원한 문장(또는 원문)","repaired":true|false,"confidence":0~1,"ask":"","note":"무엇을 왜 고쳤는지 한 줄"}`;

/**
 * @returns {Promise<{text:string, repaired:boolean, confidence:number, ask:string, note:string, candidates:Array}>}
 */
export async function repairHearing(env, { text, alternatives = [], confidence = 0, lexicon = [], recent = [] }) {
  const raw = String(text || "").trim();
  const base = { text: raw, repaired: false, confidence: confidence || 1, ask: "", note: "", candidates: [] };
  if (!raw || env.CHAT_HEARING === "0") return base;
  const candidates = phoneticCandidates(raw, lexicon);
  const alts = (alternatives || []).map((a) => String(a).trim()).filter((a) => a && a !== raw).slice(0, 3);
  const garbled = looksGarbled(raw, confidence);
  // cheap exit: clean transcript, nothing sounds like a known word, no alternatives disagreeing much
  if (!garbled && !candidates.length && (!alts.length || alts.every((a) => lev(soundKey(a), soundKey(raw)) <= 1))) return base;

  const user = [
    `들린 문장: ${raw}`,
    `인식 확신도: ${confidence ? confidence.toFixed(2) : "모름"}${garbled ? " (깨진 것 같음)" : ""}`,
    alts.length ? `다른 후보: ${alts.map((a) => `"${a}"`).join(", ")}` : "",
    candidates.length ? `비슷하게 들리는 아는 단어: ${candidates.map((c) => `${c.heard}→${c.maybe}`).join(", ")}` : "",
    lexicon.length ? `이 사람이 자주 쓰는 단어: ${lexicon.slice(0, 60).join(", ")}` : "",
    recent.length ? `직전 대화:\n${recent.slice(-4).map((m) => `${m.role === "assistant" ? "채티" : "이 사람"}: ${String(m.content).slice(0, 120)}`).join("\n")}` : "",
    "JSON:",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const out = await completeText(env, { system: REPAIR_SYSTEM, user, maxTokens: 220, temperature: 0.1, timeoutMs: 9000 });
    const obj = extractFirstJsonObject(out.text) || {};
    const fixed = String(obj.text || raw).trim() || raw;
    const repaired = Boolean(obj.repaired) && fixed !== raw;
    return {
      text: repaired ? fixed : raw,
      repaired,
      confidence: Number.isFinite(Number(obj.confidence)) ? Number(obj.confidence) : confidence || 0.7,
      ask: String(obj.ask || "").slice(0, 80),
      note: String(obj.note || "").slice(0, 120),
      candidates,
    };
  } catch {
    // no LLM → apply only the safest phonetic fix (distance 1 to a strong lexicon word)
    let fixed = raw;
    for (const c of candidates) if (c.d === 1) fixed = fixed.replace(c.heard, c.maybe);
    return { ...base, text: fixed, repaired: fixed !== raw, note: fixed !== raw ? "아는 단어로 바꿔 들음" : "", candidates };
  }
}
