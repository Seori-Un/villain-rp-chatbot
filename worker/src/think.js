/**
 * Plan → answer (stage 1).
 * Before every /chat reply, 채티 thinks in a short structured step:
 *   - what the user actually wants / what to pay attention to
 *   - whether current web info is needed (and which queries)
 *   - how to respond (tone, must-mention)
 * The thoughts are returned to the UI as a summary ("생각 단계").
 */

import { completeText } from "./llm-text.js";
import { extractFirstJsonObject } from "./browser/tools.js";
import { researchQueries, formatWebBlock, sourcesForClient } from "./web/search.js";

const PLAN_SYSTEM = `너는 한국어 챗봇 '채티'의 내부 계획기다. 답을 쓰지 말고, 답하기 전에 생각만 한다.
반드시 JSON 한 개만 출력 (설명/마크다운 금지):
{
 "thoughts": ["..."],           // 2~4개. 사용자가 진짜 원하는 것, 놓치면 안 될 맥락, 답의 방향. 각 1문장, 한국어. 화면에 그대로 보임.
 "needs_web": false,            // 최신 정보·실시간 데이터·특정 사실 확인(뉴스, 가격, 일정, 버전, 날씨, 인물 현재 직책, 최근 출시 등)이 답의 정확성에 필요하면 true
 "queries": ["..."],            // needs_web일 때만, 1~3개, 검색엔진용 짧은 검색어 (한국어/영어 혼용 가능)
 "answer_hint": "...",          // 답변 톤/길이/꼭 넣을 것 1문장
 "memory_query": ""             // 유저가 예전 대화·과거 일·"기억나?" 같은 걸 언급하면, 기억 검색용 핵심어 2~5개 (아니면 빈 문자열)
}
needs_web 기준: 일상 대화·감정·롤플레이·상식은 false. "요즘/최근/지금/오늘/올해/가격/몇 시/누가 ~인지/출시/버전" 같은 현재성 질문은 true.
mode=rp 이면 채티는 집착형 롤플레이 캐릭터다. thoughts는 캐릭터의 속마음 톤(짧게, 집착 섞어도 됨)으로 쓰되 과하게 길지 않게.
mode=secretary 이면 비서 톤으로 실용적으로.`;

/**
 * @param {object} env
 * @param {{userText:string, history:Array<{role:string,content:string}>, mode:string, timeHint?:string}} p
 * @returns {Promise<{thoughts:string[], needs_web:boolean, queries:string[], answer_hint:string, provider:string, model:string, ms:number, error?:string}>}
 */
export async function planTurn(env, { userText, history = [], mode = "rp", timeHint = "" }) {
  const t0 = Date.now();
  const text = String(userText || "").trim();
  const empty = { thoughts: [], needs_web: false, queries: [], answer_hint: "", memory_query: "", provider: "none", model: "", ms: 0 };
  if (!text || text.startsWith("/")) return empty;

  const recent = history
    .slice(-6)
    .map((m) => `${m.role === "assistant" ? "채티" : "유저"}: ${String(m.content || "").slice(0, 200)}`)
    .join("\n");
  const user = `mode=${mode}${timeHint ? `\n지금: ${timeHint}` : ""}\n최근 대화:\n${recent || "(없음)"}\n\n유저의 새 메시지: ${text}\n\nJSON:`;

  try {
    const out = await completeText(env, { system: PLAN_SYSTEM, user, maxTokens: 400, temperature: 0.2, timeoutMs: 20000 });
    const obj = extractFirstJsonObject(out.text) || {};
    const thoughts = (Array.isArray(obj.thoughts) ? obj.thoughts : [])
      .map((t) => String(t || "").trim())
      .filter(Boolean)
      .slice(0, 4);
    const needs_web = Boolean(obj.needs_web) && env.CHAT_AUTO_WEB !== "0";
    const queries = needs_web
      ? (Array.isArray(obj.queries) ? obj.queries : [])
          .map((q) => String(q || "").trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
    if (needs_web && !queries.length) queries.push(text.slice(0, 80));
    return {
      thoughts,
      needs_web,
      queries,
      answer_hint: String(obj.answer_hint || "").slice(0, 200),
      memory_query: String(obj.memory_query || "").slice(0, 120),
      provider: out.provider,
      model: out.model,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ...empty, ms: Date.now() - t0, error: String(e.message || e).slice(0, 120) };
  }
}

/**
 * Stage 1.5: if the plan asked for the web, search + read pages.
 * @returns {Promise<{block:string, sources:Array, thoughts:string[], research:object|null}>}
 */
export async function runPlanResearch(env, plan) {
  if (!plan || !plan.needs_web || !plan.queries.length) return { block: "", sources: [], thoughts: [], research: null };
  const t0 = Date.now();
  let research = null;
  try {
    research = await researchQueries(env, plan.queries, { perQuery: 5, readTop: 3, pageChars: 3500 });
  } catch {
    research = null;
  }
  const thoughts = [];
  if (research && research.results.length) {
    const read = research.pages.filter((p) => p.ok).length;
    thoughts.push(
      `웹 검색(${research.provider}): "${research.queries.join('", "')}" → ${research.results.length}건, ${read}개 페이지 읽음 (${Math.round((Date.now() - t0) / 100) / 10}s)`
    );
  } else {
    thoughts.push(`웹 검색을 시도했지만 결과를 못 얻었어 — 아는 범위에서 답할게.`);
  }
  return {
    block: formatWebBlock(research),
    sources: sourcesForClient(research),
    thoughts,
    research,
  };
}

/** Plan block for the answer model's system prompt. */
export function formatPlanBlock(plan) {
  if (!plan || !plan.thoughts?.length) return "";
  return [
    "【내부 계획】(답하기 전에 네가 한 생각. 따르되 그대로 읽지 마라)",
    ...plan.thoughts.map((t) => `- ${t}`),
    plan.answer_hint ? `- 답변 힌트: ${plan.answer_hint}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Trim Claude extended-thinking text to a short display line. */
export function summarizeRawThinking(raw, max = 320) {
  const s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("다 "), cut.lastIndexOf("요 "));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut) + " …";
}
