/**
 * Worker-side web research — no browser runner needed.
 *   webSearch(env, query)      → [{ title, url, snippet, source }]
 *   readPage(url)              → { ok, url, title, text }
 *   researchQueries(env, qs)   → { results, pages, provider }
 *   formatWebBlock(research)   → prompt block with numbered sources
 *
 * Search provider: BRAVE_API_KEY → TAVILY_API_KEY → DuckDuckGo HTML (no key).
 * Used by /chat (auto web when the plan says so) and by /browse `search` / `read` tools.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 ChaetiBot/1.0";

const SKIP_HOSTS = /(^|\.)(duckduckgo\.com|google\.com|bing\.com|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com)$/i;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function searchProvider(env) {
  if (env.BRAVE_API_KEY && String(env.BRAVE_API_KEY).trim()) return "brave";
  if (env.TAVILY_API_KEY && String(env.TAVILY_API_KEY).trim()) return "tavily";
  return "duckduckgo";
}

/** @returns {Promise<Array<{title:string,url:string,snippet:string,source:string}>>} */
export async function webSearch(env, query, { count = 6 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const provider = searchProvider(env);
  try {
    if (provider === "brave") return await braveSearch(env.BRAVE_API_KEY, q, count);
    if (provider === "tavily") return await tavilySearch(env.TAVILY_API_KEY, q, count);
  } catch (e) {
    // fall through to DDG
  }
  try {
    return await ddgSearch(q, count);
  } catch {
    return [];
  }
}

async function braveSearch(key, q, count) {
  const { signal, clear } = withTimeout(10000);
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}&search_lang=ko&country=KR`,
      { headers: { Accept: "application/json", "X-Subscription-Token": String(key).trim() }, signal }
    );
    if (!res.ok) throw new Error("brave_" + res.status);
    const data = await res.json();
    const items = data?.web?.results || [];
    return items.slice(0, count).map((r) => ({
      title: String(r.title || "").slice(0, 160),
      url: String(r.url || ""),
      snippet: String(r.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
      source: "brave",
    }));
  } finally {
    clear();
  }
}

async function tavilySearch(key, q, count) {
  const { signal, clear } = withTimeout(12000);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: String(key).trim(), query: q, max_results: count, search_depth: "basic" }),
      signal,
    });
    if (!res.ok) throw new Error("tavily_" + res.status);
    const data = await res.json();
    return (data?.results || []).slice(0, count).map((r) => ({
      title: String(r.title || "").slice(0, 160),
      url: String(r.url || ""),
      snippet: String(r.content || "").slice(0, 300),
      source: "tavily",
    }));
  } finally {
    clear();
  }
}

async function ddgSearch(q, count) {
  const { signal, clear } = withTimeout(10000);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=kr-kr`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal,
    });
    if (!res.ok) throw new Error("ddg_" + res.status);
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while ((m = re.exec(html)) && out.length < count) {
      let url = decodeEntities(m[1]);
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (url.startsWith("//")) url = "https:" + url;
      if (!/^https?:\/\//i.test(url)) continue;
      out.push({
        title: stripTags(m[2]).slice(0, 160),
        url,
        snippet: stripTags(m[3] || "").slice(0, 300),
        source: "duckduckgo",
      });
    }
    return out;
  } finally {
    clear();
  }
}

/* ---------- page reading ---------- */

export function htmlToText(html, maxChars = 6000) {
  let s = String(html || "");
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|footer|header|aside|form|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // prefer <article>/<main> if present and substantial
  const main = (s.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2];
  if (main && stripTags(main).length > 800) s = main;
  s = s.replace(/<(br|p|div|li|h[1-6]|tr|section)[^>]*>/gi, "\n");
  const text = decodeEntities(stripTags(s))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1)
    .join("\n")
    .slice(0, maxChars);
  return { title: decodeEntities(stripTags(title)).trim().slice(0, 160), text };
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** @returns {Promise<{ok:boolean,url:string,title:string,text:string,error?:string}>} */
export async function readPage(url, { maxChars = 6000, timeoutMs = 12000 } = {}) {
  const u = String(url || "");
  if (!/^https?:\/\//i.test(u)) return { ok: false, url: u, title: "", text: "", error: "bad_url" };
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(u, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "Accept-Language": "ko,en;q=0.8" },
      redirect: "follow",
      signal,
    });
    const ct = String(res.headers.get("content-type") || "");
    if (!res.ok) return { ok: false, url: u, title: "", text: "", error: "http_" + res.status };
    if (!/html|xml|text\/plain|json/i.test(ct)) {
      return { ok: false, url: u, title: "", text: "", error: "unsupported_type:" + ct.slice(0, 40) };
    }
    const body = await res.text();
    if (/text\/plain|json/i.test(ct)) return { ok: true, url: res.url || u, title: "", text: body.slice(0, maxChars) };
    const { title, text } = htmlToText(body, maxChars);
    if (text.length < 80) return { ok: false, url: res.url || u, title, text, error: "empty_or_js_rendered" };
    return { ok: true, url: res.url || u, title, text };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    return { ok: false, url: u, title: "", text: "", error: /abort/i.test(msg) ? "timeout" : msg.slice(0, 120) };
  } finally {
    clear();
  }
}

/**
 * Search several queries, dedupe, read the top pages in parallel.
 * @returns {Promise<{results:Array, pages:Array, provider:string, queries:string[]}>}
 */
export async function researchQueries(env, queries, { perQuery = 5, readTop = 3, pageChars = 3500 } = {}) {
  const qs = [...new Set((queries || []).map((q) => String(q || "").trim()).filter(Boolean))].slice(0, 3);
  const provider = searchProvider(env);
  const lists = await Promise.all(qs.map((q) => webSearch(env, q, { count: perQuery })));
  const seen = new Set();
  const results = [];
  for (const list of lists) {
    for (const r of list) {
      const h = hostOf(r.url);
      if (!r.url || seen.has(r.url) || SKIP_HOSTS.test(h)) continue;
      seen.add(r.url);
      results.push(r);
    }
  }
  const toRead = results.slice(0, Math.max(0, readTop));
  const pages = (await Promise.all(toRead.map((r) => readPage(r.url, { maxChars: pageChars })))).map((p, i) => ({
    ...p,
    title: p.title || toRead[i].title,
    snippet: toRead[i].snippet,
  }));
  return { results, pages, provider, queries: qs };
}

/** Numbered sources block for the system prompt. */
export function formatWebBlock(research) {
  if (!research || !research.results?.length) return "";
  const lines = [
    `【웹 참고】(방금 검색한 최신 자료. 아래 번호 출처만 근거로 삼고, 없는 사실은 지어내지 마라. 출처끼리 다르면 차이를 말해라)`,
    `검색어: ${research.queries.join(" / ")}`,
  ];
  const pagesByUrl = new Map((research.pages || []).map((p) => [p.url, p]));
  research.results.slice(0, 8).forEach((r, i) => {
    const p = pagesByUrl.get(r.url);
    lines.push(`[${i + 1}] ${r.title || r.url} — ${r.url}`);
    if (p && p.ok && p.text) lines.push(`    본문: ${p.text.replace(/\n+/g, " ").slice(0, 1800)}`);
    else if (r.snippet) lines.push(`    요약: ${r.snippet}`);
  });
  return lines.join("\n");
}

/** Compact source list for the API response / UI. */
export function sourcesForClient(research) {
  if (!research) return [];
  const read = new Set((research.pages || []).filter((p) => p.ok).map((p) => p.url));
  return research.results.slice(0, 8).map((r, i) => ({
    n: i + 1,
    title: r.title || r.url,
    url: r.url,
    read: read.has(r.url),
  }));
}
