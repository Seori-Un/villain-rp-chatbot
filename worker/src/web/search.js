/**
 * Plain page fetch + HTML → text. Used only as a fallback for the browse `read` tool
 * when Anthropic web_fetch can't get a page. Search lives in ./claude-web.js (Claude server tools).
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 ChaetiBot/1.0";


function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
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
