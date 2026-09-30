/**
 * Browser agent loop: Groq native tool calling when available,
 * else ReAct JSON actions. Executes via browser client + safety.
 */

import { BROWSER_TOOLS, browserSystemPrompt, parseReactAction, normalizeToolCalls } from "./tools.js";
import { checkGoal, checkAction } from "./safety.js";
import { browserAct, compactObservation } from "./client.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"];

/**
 * @param {object} opts
 * @param {string} opts.goal
 * @param {object} opts.env
 * @param {string} [opts.session_id]
 * @param {number} [opts.max_steps]
 * @param {object} [opts.confirm]
 */
export async function runBrowserAgent({ goal, env, session_id, max_steps = 8, confirm = {} }) {
  const goalCheck = checkGoal(goal);
  if (!goalCheck.ok) {
    return {
      ok: false,
      error: goalCheck.code,
      reply: goalCheck.message,
      steps: [],
      needs_confirm: goalCheck.needs_confirm || null,
    };
  }

  const maxSteps = Math.max(1, Math.min(12, Number(max_steps) || 8));
  const sid = session_id || crypto.randomUUID();
  const steps = [];
  let page = { url: "", title: "" };
  let needsConfirm = null;
  let lastScreenshot = null; // base64 or data URL for UI (not sent to LLM)

  const system = browserSystemPrompt({ maxSteps });
  /** @type {{role:string, content?:string, tool_calls?:any[], tool_call_id?:string}[]} */
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: `목표: ${goal}\n세션: ${sid}\n최대 ${maxSteps} 단계. 한국어로 요약해.`,
    },
  ];

  let mode = "tools"; // or "react"
  let finalSummary = null;

  for (let n = 1; n <= maxSteps; n++) {
    const planned = await planNext({ env, messages, mode });
    mode = planned.mode;

    if (planned.error && !planned.actions.length) {
      const early = {
        ok: false,
        error: planned.error,
        reply: `${n}/${maxSteps} 단계: LLM 계획 실패 — ${planned.error}`,
        steps,
        needs_confirm: null,
        mode,
        session_id: sid,
        browser: "configured",
      };
      if (lastScreenshot && String(lastScreenshot).length <= 400000) {
        early.last_screenshot = lastScreenshot;
      }
      return early;
    }

    // If model returned plain text without tools, treat as done summary
    if (!planned.actions.length && planned.text) {
      finalSummary = planned.text.trim();
      steps.push({ n, tool: "done", args: { summary: finalSummary }, ok: true, source: "text" });
      break;
    }

    for (const act of planned.actions) {
      if (act.action === "done") {
        finalSummary = String(act.args?.summary || act.args?.message || "완료").trim();
        steps.push({ n, tool: "done", args: { summary: finalSummary }, ok: true });
        // tool result for completeness
        if (act.id) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: act.id,
                type: "function",
                function: { name: "done", arguments: JSON.stringify(act.args || {}) },
              },
            ],
          });
          messages.push({
            role: "tool",
            tool_call_id: act.id,
            content: JSON.stringify({ ok: true }),
          });
        }
        return finish(true, finalSummary, steps, null, mode, sid, maxSteps, n, undefined, lastScreenshot);
      }

      const safe = checkAction(act, confirm, page);
      if (!safe.ok) {
        steps.push({
          n,
          tool: act.action,
          args: redactArgs(act.args),
          ok: false,
          error: safe.code,
          message: safe.message,
        });
        if (safe.needs_confirm) {
          needsConfirm = safe.needs_confirm;
          return finish(false, safe.message, steps, needsConfirm, mode, sid, maxSteps, n, safe.code, lastScreenshot);
        }
        // feed refusal back to model and continue
        appendToolResult(messages, act, mode, planned, {
          ok: false,
          error: safe.code,
          message: safe.message,
        });
        continue;
      }

      let result;
      if (act.action === "screenshot" || act.action === "open" || act.action === "click" || act.action === "type" || act.action === "scroll") {
        result = await browserAct(env, { action: act.action, args: act.args, session_id: sid });
      } else {
        result = { ok: false, error: "unknown_action", message: act.action };
      }

      if (result.url) page.url = result.url;
      if (result.title) page.title = result.title;

      const shot = result.screenshot_b64 || result.screenshot || result.screenshot_url;
      if (shot && typeof shot === "string") lastScreenshot = shot;

      const compact = compactObservation(result);
      steps.push({
        n,
        tool: act.action,
        args: redactArgs(act.args),
        ok: compact.ok,
        observation: compact,
      });
      appendToolResult(messages, act, mode, planned, compact);

      if (!compact.ok && result.error === "browser_not_configured") {
        return finish(
          false,
          "브라우저 러너가 연결되지 않았어. BROWSER_API_URL + browser-runner(또는 Browserbase)를 설정해줘.",
          steps,
          null,
          mode,
          sid,
          maxSteps,
          n,
          "browser_not_configured",
          lastScreenshot
        );
      }
    }

    if (finalSummary) break;
  }

  if (!finalSummary) {
    finalSummary = `${maxSteps}/${maxSteps} 단계: 최대 단계에 도달했어. 지금까지 ${steps.length}개 액션 실행.`;
  }
  return finish(true, finalSummary, steps, needsConfirm, mode, sid, maxSteps, steps.length || maxSteps, undefined, lastScreenshot);
}

function finish(ok, reply, steps, needsConfirm, mode, sid, maxSteps, n, error, lastScreenshot) {
  const prefixed =
    reply && !/^\d+\s*\/\s*\d+\s*단계/.test(reply) ? `${n}/${maxSteps} 단계: ${reply}` : reply;
  const out = {
    ok,
    error: error || (ok ? undefined : "failed"),
    reply: prefixed,
    steps,
    needs_confirm: needsConfirm,
    mode,
    session_id: sid,
    browser: "configured",
  };
  if (lastScreenshot) {
    // Cap huge payloads (~400KB chars) — UI optional preview only
    const s = String(lastScreenshot);
    if (s.length <= 400000) out.last_screenshot = s;
  }
  return out;
}

function redactArgs(args) {
  if (!args || typeof args !== "object") return args;
  const copy = { ...args };
  if (copy.is_password || /password|비밀번호/i.test(String(copy.selector || ""))) {
    if (copy.text) copy.text = "***";
  }
  return copy;
}

function appendToolResult(messages, act, mode, planned, compact) {
  if (mode === "tools" && act.id) {
    // Ensure assistant tool_calls message exists once per plan batch
    if (planned._assistantPushed !== true) {
      messages.push({
        role: "assistant",
        content: planned.text || null,
        tool_calls: planned.actions
          .filter((a) => a.id)
          .map((a) => ({
            id: a.id,
            type: "function",
            function: { name: a.action, arguments: JSON.stringify(a.args || {}) },
          })),
      });
      planned._assistantPushed = true;
    }
    messages.push({
      role: "tool",
      tool_call_id: act.id,
      content: JSON.stringify(compact),
    });
  } else {
    messages.push({
      role: "assistant",
      content: JSON.stringify({ action: act.action, args: redactArgs(act.args) }),
    });
    messages.push({
      role: "user",
      content: `관찰(JSON): ${JSON.stringify(compact)}\n다음 액션 JSON을 한 줄로.`,
    });
  }
}

async function planNext({ env, messages, mode }) {
  if (!env.GROQ_API_KEY) {
    return { mode: "react", actions: [], text: "", error: "no_groq_key" };
  }

  // Prefer native tools first; on empty tool_calls fall back to ReAct parse; on 400 tools → ReAct only
  if (mode === "tools") {
    const withTools = await groqChat(env, messages, { tools: BROWSER_TOOLS, tool_choice: "auto" });
    if (withTools.unsupported) {
      return planReact(env, messages);
    }
    if (withTools.error && !withTools.message) {
      return { mode: "tools", actions: [], text: "", error: withTools.error };
    }
    const actions = normalizeToolCalls(withTools.message);
    if (actions.length) {
      return { mode: "tools", actions, text: withTools.message?.content || "", error: null };
    }
    const text = String(withTools.message?.content || "").trim();
    const react = parseReactAction(text);
    if (react) {
      return { mode: "react", actions: [{ ...react, id: null }], text, error: null };
    }
    if (text) {
      return { mode: "tools", actions: [], text, error: null };
    }
    // empty → try react prompt once
    return planReact(env, messages);
  }
  return planReact(env, messages);
}

async function planReact(env, messages) {
  const reactMessages = [
    ...messages,
    {
      role: "user",
      content:
        '도구 JSON만 출력: {"thought":"...","action":"open|screenshot|click|type|scroll|done","args":{...}}',
    },
  ];
  const res = await groqChat(env, reactMessages, {});
  if (res.error && !res.message) {
    return { mode: "react", actions: [], text: "", error: res.error };
  }
  const text = String(res.message?.content || "").trim();
  const react = parseReactAction(text);
  if (react) {
    return { mode: "react", actions: [{ ...react, id: null }], text, error: null };
  }
  return { mode: "react", actions: [], text, error: react ? null : "no_action_parsed" };
}

async function groqChat(env, messages, extra) {
  let lastErr = null;
  for (const model of MODELS) {
    const body = {
      model,
      messages: messages.map(sanitizeMessage),
      temperature: 0.3,
      max_tokens: 600,
      ...extra,
    };
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.GROQ_API_KEY,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = `groq_${res.status}:${JSON.stringify(data).slice(0, 200)}`;
      lastErr = msg;
      // tools not supported
      if (extra.tools && (res.status === 400 || /tool|function|unsupported/i.test(msg))) {
        return { unsupported: true, error: msg };
      }
      if (res.status === 404 || /does not exist|deprecat|not_found/i.test(msg)) {
        continue;
      }
      return { error: msg };
    }
    return { message: data?.choices?.[0]?.message || {}, raw: data };
  }
  return { error: lastErr || "groq_failed" };
}

function sanitizeMessage(m) {
  const out = { role: m.role };
  if (m.content !== undefined) out.content = m.content;
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}
