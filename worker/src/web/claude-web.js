/**
 * 웹 = Claude 서버 도구 (web_search + web_fetch). 별도 검색 API 키 없음.
 *
 *   claudeResearch(env, {question, queries, context}) → {digest, results, pages, citations, provider, queries}
 *   claudeSearch(env, query)                           → [{n,title,url,page_age,summary}]
 *   claudeFetch(env, url)                              → {ok,url,title,text}
 *
 * 응답 블록: server_tool_use → web_search_tool_result / web_fetch_tool_result → text(+citations).
 * stop_reason "pause_turn" 이면 받은 assistant 메시지를 그대로 되돌려 보내 이어간다.
 * 폴백: Anthropic 키가 없으면 Gemini 검색 그라운딩(google_search) → 그것도 없으면 빈 결과.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-sonnet-5-5", "claude-sonnet-4-6"];
const SEARCH_TOOL = (max_uses) => ({ type: "web_search_20250305", name: "web_search", max_uses });
const FETCH_TOOL = (max_uses, max_content_tokens = 12000) => ({
  type: "web_fetch_20250910",
  name: "web_fetch",
  max_uses,
  citations: { enabled: true },
  max_content_tokens,
});

function anthropicKey(env) {
  return (
    (env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim()) ||
    (env.CLAUDE_API_KEY && String(env.CLAUDE_API_KEY).trim()) ||
    ""
  );
}

export function webProvider(env) {
  if (anthropicKey(env)) return "claude_web";
  if (env.GEMINI_API_KEY) return "gemini_grounding";
  return "none";
}

function timed(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/**
 * One Messages call with server tools; follows pause_turn. Returns parsed blocks across all turns.
 * @returns {Promise<{text:string, searches:Array, results:Array, fetches:Array, citations:Array, model:string, errors:string[]}>}
 */
async function runWithTools(env, { system, user, tools, maxTokens = 2500, timeoutMs = 60000, model: forced = "" }) {
  const key = anthropicKey(env);
  if (!key) throw new Error("no_anthropic");
  const models = forced ? [forced] : CLAUDE_MODELS;
  let lastErr = "claude_web_failed";
  for (const model of models) {
    const messages = [{ role: "user", content: user }];
    const acc = { text: "", searches: [], results: [], fetches: [], citations: [], model, errors: [] };
    let hops = 0;
    try {
      while (hops < 4) {
        hops++;
        const { signal, clear } = timed(timeoutMs);
        let res, data;
        try {
          res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools }),
            signal,
          });
          data = await res.json().catch(() => ({}));
        } finally {
          clear();
        }
        if (!res.ok) {
          lastErr = `claude_${res.status}:${JSON.stringify(data).slice(0, 160)}`;
          if (res.status === 404 || /not_found|model/i.test(lastErr)) break; // next model
          if (/web_search|web_fetch|tool/i.test(lastErr) && res.status === 400) throw new Error(lastErr); // org disabled → caller falls back
          break;
        }
        for (const b of data.content || []) {
          if (b.type === "text") {
            acc.text += (acc.text ? "\n" : "") + (b.text || "");
            for (const c of b.citations || []) {
              if (c.type === "web_search_result_location") acc.citations.push({ url: c.url, title: c.title, cited: c.cited_text });
              else if (c.type === "char_location" && c.document_title) acc.citations.push({ url: "", title: c.document_title, cited: c.cited_text });
            }
          } else if (b.type === "server_tool_use") {
            if (b.name === "web_search") acc.searches.push(String(b.input?.query || ""));
          } else if (b.type === "web_search_tool_result") {
            if (Array.isArray(b.content)) {
              for (const r of b.content) if (r.type === "web_search_result") acc.results.push({ url: r.url, title: r.title, page_age: r.page_age });
            } else if (b.content?.type === "web_search_tool_result_error") acc.errors.push("search:" + b.content.error_code);
          } else if (b.type === "web_fetch_tool_result") {
            const c = b.content || {};
            if (c.type === "web_fetch_result") {
              const src = c.content?.source || {};
              acc.fetches.push({
                url: c.url,
                title: c.content?.title || "",
                text: src.type === "text" ? String(src.data || "") : "",
                retrieved_at: c.retrieved_at,
              });
            } else if (c.type === "web_fetch_tool_result_error") acc.errors.push("fetch:" + c.error_code);
          }
        }
        if (data.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: data.content });
          continue;
        }
        return acc;
      }
      return acc;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
      if (/no_anthropic|web_search|web_fetch|invalid_request/i.test(lastErr)) throw e;
    }
  }
  throw new Error(lastErr);
}

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

/* ---------------------------------------------------------------- /chat research */

const RESEARCH_SYSTEM = `너는 조사 담당이다. 질문에 답하기 위해 web_search로 찾고(필요하면 검색어를 바꿔 2~3번), 가장 믿을 만한 페이지 1~3개를 web_fetch로 읽는다.
그런 다음 한국어로 '조사 메모'를 쓴다: 사실만, 출처마다 번호 [n]을 붙여서, 출처끼리 다르면 차이를 적고, 못 찾은 건 "못 찾음"이라고. 날짜가 중요한 사실은 언제 기준인지 적는다.
의견·추측·인사말 없이 메모만. 400자 안팎.`;

/**
 * @returns {Promise<{digest:string, results:Array, pages:Array, citations:Array, provider:string, queries:string[], errors:string[]}>}
 */
export async function claudeResearch(env, { question, queries = [], context = "" }) {
  const qs = [...new Set((queries || []).map((q) => String(q || "").trim()).filter(Boolean))].slice(0, 3);
  const user = [
    `질문: ${String(question || "").slice(0, 400)}`,
    qs.length ? `검색어 후보: ${qs.join(" / ")}` : "",
    context ? `맥락: ${String(context).slice(0, 400)}` : "",
    "web_search → web_fetch → 조사 메모 순서로.",
  ]
    .filter(Boolean)
    .join("\n");
  const acc = await runWithTools(env, {
    system: RESEARCH_SYSTEM,
    user,
    tools: [SEARCH_TOOL(4), FETCH_TOOL(3, 10000)],
    maxTokens: 2500,
    timeoutMs: 75000,
  });
  const results = dedupe([
    ...acc.citations.filter((c) => c.url).map((c) => ({ url: c.url, title: c.title, snippet: c.cited })),
    ...acc.fetches.map((f) => ({ url: f.url, title: f.title })),
    ...acc.results,
  ]).slice(0, 10);
  return {
    digest: acc.text.trim(),
    results,
    pages: acc.fetches.map((f) => ({ ok: Boolean(f.text), url: f.url, title: f.title, text: f.text.slice(0, 3500) })),
    citations: acc.citations,
    provider: "claude_web",
    model: acc.model,
    queries: acc.searches.length ? acc.searches : qs,
    errors: acc.errors,
  };
}

/* ---------------------------------------------------------------- /browse tools */

/** search(query) for the browse agent: results + a one-line summary per result when Claude wrote one. */
export async function claudeSearch(env, query) {
  const q = String(query || "").trim().slice(0, 200);
  if (!q) return [];
  const acc = await runWithTools(env, {
    system: "web_search로 딱 한 번 검색하고, 결과를 한국어로 번호 [n] 목록(제목 — 한 줄 요약)으로만 적어라. 다른 말 금지.",
    user: `검색어: ${q}`,
    tools: [SEARCH_TOOL(1)],
    maxTokens: 900,
    timeoutMs: 40000,
  });
  const results = dedupe(acc.results).slice(0, 8);
  // attach Claude's one-liners when it followed the [n] format
  const lines = acc.text.split("\n").filter((l) => /^\s*\[?\d+[\].)]/.test(l));
  return results.map((r, i) => ({
    n: i + 1,
    title: r.title || r.url,
    url: r.url,
    snippet: (lines[i] || "").replace(/^\s*\[?\d+[\].)]\s*/, "").slice(0, 200) || (r.page_age ? `(${r.page_age})` : ""),
    source: "claude_web",
  }));
}

/** read(url) for the browse agent: the page text as fetched by Anthropic (no runner needed). */
export async function claudeFetch(env, url, { maxChars = 6000 } = {}) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, url: u, title: "", text: "", error: "bad_url" };
  let acc;
  try {
    acc = await runWithTools(env, {
      system: "주어진 URL을 web_fetch로 한 번 읽고 '읽음'이라고만 답하라.",
      user: `URL: ${u}`,
      tools: [FETCH_TOOL(1, 8000)],
      maxTokens: 200,
      timeoutMs: 40000,
    });
  } catch (e) {
    return { ok: false, url: u, title: "", text: "", error: String(e.message || e).slice(0, 120) };
  }
  const f = acc.fetches.find((x) => x.text) || acc.fetches[0];
  if (!f) return { ok: false, url: u, title: "", text: "", error: acc.errors[0] || "no_fetch_result" };
  if (!f.text) return { ok: false, url: f.url, title: f.title, text: "", error: acc.errors[0] || "empty_or_binary" };
  return { ok: true, url: f.url || u, title: f.title, text: f.text.slice(0, maxChars), via: "claude_web" };
}

/* ---------------------------------------------------------------- Gemini fallback (no Anthropic key) */

export async function geminiGroundedResearch(env, { question, queries = [] }) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("no_gemini");
  const models = ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash"];
  let lastErr = "gemini_failed";
  for (const model of models) {
    const { signal, clear } = timed(45000);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: RESEARCH_SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: `질문: ${question}\n검색어 후보: ${queries.join(" / ")}` }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        }),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = `gemini_${res.status}`;
        continue;
      }
      const cand = data.candidates?.[0] || {};
      const text = (cand.content?.parts || []).map((p) => p.text || "").join("").trim();
      const chunks = cand.groundingMetadata?.groundingChunks || [];
      const results = dedupe(chunks.map((c) => ({ url: c.web?.uri || "", title: c.web?.title || "" }))).slice(0, 10);
      return { digest: text, results, pages: [], citations: [], provider: "gemini_grounding", model, queries, errors: [] };
    } catch (e) {
      lastErr = String(e.message || e);
    } finally {
      clear();
    }
  }
  throw new Error(lastErr);
}

/* ---------------------------------------------------------------- prompt / client formatting */

export function formatWebBlock(research) {
  if (!research || (!research.results?.length && !research.digest)) return "";
  const lines = [
    `【웹 참고】(방금 찾아본 자료. 아래 번호 출처에 있는 사실만 근거로 삼고, 없는 건 지어내지 마라. 출처끼리 다르면 차이를 말해라)`,
    research.queries?.length ? `검색어: ${research.queries.join(" / ")}` : "",
  ];
  if (research.digest) lines.push(`조사 메모:\n${research.digest.slice(0, 2500)}`);
  const pagesByUrl = new Map((research.pages || []).map((p) => [p.url, p]));
  (research.results || []).slice(0, 8).forEach((r, i) => {
    const p = pagesByUrl.get(r.url);
    lines.push(`[${i + 1}] ${r.title || r.url} — ${r.url}${r.page_age ? ` (${r.page_age})` : ""}`);
    if (p && p.ok && p.text) lines.push(`    본문: ${p.text.replace(/\n+/g, " ").slice(0, 1200)}`);
    else if (r.snippet) lines.push(`    인용: ${r.snippet}`);
  });
  if (research.errors?.length) lines.push(`(도구 오류: ${research.errors.join(", ")})`);
  return lines.filter(Boolean).join("\n");
}

export function sourcesForClient(research) {
  if (!research) return [];
  const read = new Set((research.pages || []).filter((p) => p.ok).map((p) => p.url));
  const cited = new Set((research.citations || []).map((c) => c.url).filter(Boolean));
  return (research.results || []).slice(0, 8).map((r, i) => ({
    n: i + 1,
    title: r.title || r.url,
    url: r.url,
    read: read.has(r.url) || cited.has(r.url),
  }));
}
