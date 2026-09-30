/**
 * Browser agent loop — Claude (if key) → Gemini → Groq.
 * Emits structured steps: {type: think|tool|observe, content, ...}
 * Keeps /chat Groq RP untouched.
 */

import { browserSystemPrompt, TOOL_NAMES } from "./tools.js";
import { checkGoal, checkAction, extractGoalCredentials } from "./safety.js";
import { browserAct, compactObservation } from "./client.js";
import { planBrowseStep, resolveBrowseLlm } from "./llm.js";

/**
 * @param {object} opts
 * @param {string} opts.goal
 * @param {object} opts.env
 * @param {string} [opts.session_id]
 * @param {number} [opts.max_steps]
 * @param {object} [opts.confirm]
 */
export async function runBrowserAgent({ goal, env, session_id, max_steps = 12, confirm = {} }) {
  const goalCheck = checkGoal(goal);
  if (!goalCheck.ok) {
    return {
      ok: false,
      error: goalCheck.code,
      reply: goalCheck.message,
      steps: [],
      thinking: [],
      needs_confirm: goalCheck.needs_confirm || null,
      llm: resolveBrowseLlm(env).note,
    };
  }

  const goalCreds = extractGoalCredentials(goal);
  const confirmState = normalizeConfirm(confirm);

  const llmInfo = resolveBrowseLlm(env);
  if (!llmInfo.provider) {
    return {
      ok: false,
      error: "no_llm",
      reply:
        "브라우즈용 LLM 키가 없어. GEMINI_API_KEY(권장) 또는 ANTHROPIC_API_KEY를 Worker secret으로 넣어줘. (진짜 Claude thinking은 Anthropic 키 필요)",
      steps: [],
      thinking: [],
      needs_confirm: null,
      llm: "no_llm",
      hint_anthropic: "For Claude Sonnet + extended thinking: wrangler secret put ANTHROPIC_API_KEY",
    };
  }

  const maxSteps = Math.max(1, Math.min(20, Number(max_steps) || 12));
  const sid = session_id || crypto.randomUUID();
  /** @type {object[]} timeline steps for UI */
  const steps = [];
  let page = { url: "", title: "" };
  let needsConfirm = null;
  let lastScreenshot = null;
  let actionCount = 0;
  let providerUsed = llmInfo.provider;
  let modelUsed = null;

  const system = browserSystemPrompt({ maxSteps });
  /** @type {{role:string, content?:string, tool_calls?:any[], tool_call_id?:string, name?:string}[]} */
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: `목표: ${goal}\n세션: ${sid}\n최대 ${maxSteps} 단계.\n매 행동 전 한국어로 짧게 생각하고, 끝나면 done(summary)으로 한국어 요약해.`,
    },
  ];

  let mode = "tools";
  let finalSummary = null;
  let consecutivePlanFails = 0;

  const credNote = goalCreds.present
    ? " · 자격증명 감지됨 — 허용 목록 호스트는 세션당 1회 확인 후 입력"
    : "";
  pushStep(steps, {
    type: "think",
    content: `목표를 확인했어. 웹을 탐색할게. (선호 LLM: ${llmInfo.provider}${credNote})`,
  });

  for (let n = 1; n <= maxSteps; n++) {
    const planned = await planBrowseStep({ env, messages, preferTools: mode !== "react_only" });
    if (planned.provider) providerUsed = planned.provider;
    if (planned.model) modelUsed = planned.model;
    if (planned.mode) mode = planned.mode;

    if (planned.thinking) {
      pushStep(steps, { type: "think", content: planned.thinking });
    } else if (planned.provider && n === 1) {
      const fb = planned.gemini_quota_fallback ? " (Gemini 쿼터 초과 → 폴백)" : "";
      pushStep(steps, {
        type: "think",
        content: `${planned.provider}${planned.model ? " / " + planned.model : ""} 로 계획 중.${fb}`,
      });
    }

    if (planned.error && !planned.actions.length && !planned.text) {
      consecutivePlanFails += 1;
      pushStep(steps, {
        type: "think",
        content: `계획 실패 (${planned.error}). ${consecutivePlanFails < 2 ? "다시 시도할게." : "여기서 멈출게."}`,
      });
      if (consecutivePlanFails >= 2) {
        return finish({
          ok: false,
          reply: `${n}/${maxSteps} 단계: LLM 계획 실패 — ${planned.error}`,
          steps,
          needsConfirm: null,
          mode,
          sid,
          maxSteps,
          n,
          error: planned.error,
          lastScreenshot,
          providerUsed,
          modelUsed,
          llmInfo,
        });
      }
      // nudge and retry
      messages.push({
        role: "user",
        content:
          '이전 응답을 파싱할 수 없었어. JSON 한 줄만: {"thought":"...","action":"open|screenshot|click|type|scroll|done","args":{...}}',
      });
      mode = "react_only";
      continue;
    }
    consecutivePlanFails = 0;

    if (!planned.actions.length && planned.text) {
      const looksLikeToolJson =
        /"action"\s*:/.test(planned.text) || /"tool"\s*:/.test(planned.text);
      if (looksLikeToolJson) {
        // re-parse aggressively; if still fail, nudge instead of treating as done
        pushStep(steps, {
          type: "think",
          content: "모델이 JSON을 냈지만 파싱에 실패했어. 다시 요청할게.",
        });
        messages.push({
          role: "user",
          content:
            'JSON이 깨졌어. 딱 한 개만: {"thought":"한국어","action":"open|screenshot|click|type|scroll|done","args":{...}}',
        });
        mode = "react_only";
        consecutivePlanFails += 1;
        if (consecutivePlanFails >= 3) {
          return finish({
            ok: false,
            reply: `${n}/${maxSteps} 단계: 도구 JSON 파싱 반복 실패`,
            steps,
            needsConfirm: null,
            mode,
            sid,
            maxSteps,
            n,
            error: "no_action_parsed",
            lastScreenshot,
            providerUsed,
            modelUsed,
            llmInfo,
          });
        }
        continue;
      }
      finalSummary = planned.text.trim();
      pushStep(steps, {
        type: "tool",
        n,
        tool: "done",
        args: { summary: finalSummary },
        ok: true,
        content: finalSummary,
        source: "text",
      });
      break;
    }

    // Attach thought from first action if present and not already pushed
    const firstThought = planned.actions[0]?.thought;
    if (firstThought && firstThought !== planned.thinking) {
      pushStep(steps, { type: "think", content: String(firstThought) });
    }

    let batchDone = false;
    for (const act of planned.actions) {
      if (!TOOL_NAMES.includes(act.action)) continue;

      if (act.action === "done") {
        finalSummary = String(act.args?.summary || act.args?.message || "완료").trim();
        pushStep(steps, {
          type: "tool",
          n,
          tool: "done",
          args: { summary: finalSummary },
          ok: true,
          content: finalSummary,
        });
        if (act.id) {
          messages.push({
            role: "assistant",
            content: planned.text || null,
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
            name: "done",
            content: JSON.stringify({ ok: true }),
          });
        }
        return finish({
          ok: true,
          reply: finalSummary,
          steps,
          needsConfirm: null,
          mode,
          sid,
          maxSteps,
          n,
          error: undefined,
          lastScreenshot,
          providerUsed,
          modelUsed,
          llmInfo,
        });
      }

      const safe = checkAction(act, confirmState, {
        ...page,
        goal,
        goalCreds,
      });
      // Remember host approval for rest of this run if confirm already granted
      if (safe.ok && act.action === "type" && confirmState.allow_credentials) {
        const h = safeHost(page.url);
        if (h && !confirmState.approved_hosts.includes(h)) {
          confirmState.approved_hosts.push(h);
        }
      }
      if (!safe.ok) {
        pushStep(steps, {
          type: "tool",
          n,
          tool: act.action,
          args: redactArgs(act.args),
          ok: false,
          error: safe.code,
          content: safe.message,
          message: safe.message,
        });
        if (safe.needs_confirm) {
          needsConfirm = safe.needs_confirm;
          return finish({
            ok: false,
            reply: safe.message,
            steps,
            needsConfirm,
            mode,
            sid,
            maxSteps,
            n,
            error: safe.code,
            lastScreenshot,
            providerUsed,
            modelUsed,
            llmInfo,
          });
        }
        appendToolResult(messages, act, mode, planned, {
          ok: false,
          error: safe.code,
          message: safe.message,
        });
        continue;
      }

      let result = await execWithRetry(env, act, sid);
      actionCount += 1;

      if (result.url) page.url = result.url;
      if (result.title) page.title = result.title;

      const shot = result.screenshot_b64 || result.screenshot || result.screenshot_url;
      if (shot && typeof shot === "string") lastScreenshot = shot;

      const compact = compactObservation(result);
      pushStep(steps, {
        type: "tool",
        n,
        tool: act.action,
        args: redactArgs(act.args),
        ok: compact.ok,
        content: summarizeTool(act, compact),
        observation: compact,
        error: compact.ok ? undefined : compact.error,
      });

      const obsText = formatObserve(compact);
      pushStep(steps, {
        type: "observe",
        n,
        content: obsText,
        observation: compact,
        ok: compact.ok,
      });

      appendToolResult(messages, act, mode, planned, compact);

      if (!compact.ok && result.error === "browser_not_configured") {
        return finish({
          ok: false,
          reply:
            "브라우저 러너가 연결되지 않았어. BROWSER_API_URL + browser-runner(또는 Browserbase)를 설정해줘.",
          steps,
          needsConfirm: null,
          mode,
          sid,
          maxSteps,
          n,
          error: "browser_not_configured",
          lastScreenshot,
          providerUsed,
          modelUsed,
          llmInfo,
        });
      }

      // Periodic screenshot observe for richer context (every 2 non-screenshot actions)
      if (
        compact.ok &&
        act.action !== "screenshot" &&
        actionCount % 2 === 0 &&
        n < maxSteps
      ) {
        const shotRes = await browserAct(env, { action: "screenshot", args: {}, session_id: sid });
        if (shotRes.url) page.url = shotRes.url;
        if (shotRes.title) page.title = shotRes.title;
        const shotB = shotRes.screenshot_b64 || shotRes.screenshot || shotRes.screenshot_url;
        if (shotB && typeof shotB === "string") lastScreenshot = shotB;
        const shotCompact = compactObservation(shotRes);
        pushStep(steps, {
          type: "observe",
          n,
          content: "화면 확인: " + formatObserve(shotCompact),
          observation: shotCompact,
          ok: shotCompact.ok,
          auto_screenshot: true,
        });
        messages.push({
          role: "user",
          content: `자동 화면 관찰(JSON): ${JSON.stringify(shotCompact)}\n이어서 다음 행동을 정해.`,
        });
      }

      if (act.action === "done") {
        batchDone = true;
        break;
      }
    }

    if (finalSummary || batchDone) break;

    // After a full plan batch with no done, nudge model to continue or finish
    if (n === maxSteps) break;
    messages.push({
      role: "user",
      content: `지금까지 ${actionCount}개 액션. 목표가 달성됐으면 done(summary), 아니면 다음 도구를 호출해. 한국어 thought 포함.`,
    });
  }

  if (!finalSummary) {
    finalSummary = buildPartialSummary(steps, maxSteps, page);
  }
  return finish({
    ok: true,
    reply: finalSummary,
    steps,
    needsConfirm,
    mode,
    sid,
    maxSteps,
    n: Math.min(maxSteps, steps.filter((s) => s.type === "tool").length || maxSteps),
    error: undefined,
    lastScreenshot,
    providerUsed,
    modelUsed,
    llmInfo,
  });
}

async function execWithRetry(env, act, sid) {
  let result = await browserAct(env, { action: act.action, args: act.args, session_id: sid });
  if (result.ok !== false) return result;
  // one retry on transient errors
  if (/timeout|fetch_failed|browser_http_5|runner_error/i.test(String(result.error || ""))) {
    await new Promise((r) => setTimeout(r, 400));
    result = await browserAct(env, { action: act.action, args: act.args, session_id: sid });
  }
  return result;
}

function pushStep(steps, step) {
  steps.push({
    ...step,
    at: Date.now(),
  });
}

function summarizeTool(act, compact) {
  const a = act.args || {};
  if (act.action === "open") return `열기 ${a.url || ""}`.trim();
  if (act.action === "click") return `클릭 ${a.selector || `(${a.x},${a.y})`}`;
  if (act.action === "type") return `입력 ${a.selector || ""} ← ${a.text === "***" ? "***" : String(a.text || "").slice(0, 40)}`;
  if (act.action === "scroll") return `스크롤 ${a.direction || "down"}`;
  if (act.action === "screenshot") return "화면 캡처";
  if (!compact.ok) return `실패: ${compact.error || "error"}`;
  return act.action;
}

function formatObserve(compact) {
  if (!compact) return "(관찰 없음)";
  if (!compact.ok) return `실패 — ${compact.error || "error"}`;
  const bits = [];
  if (compact.title) bits.push(`제목: ${String(compact.title).slice(0, 80)}`);
  if (compact.url) bits.push(`URL: ${String(compact.url).slice(0, 100)}`);
  if (compact.text) bits.push(`본문: ${String(compact.text).slice(0, 180)}`);
  return bits.join(" · ") || "페이지 관찰 완료";
}

function buildPartialSummary(steps, maxSteps, page) {
  const tools = steps.filter((s) => s.type === "tool");
  const lastObs = [...steps].reverse().find((s) => s.type === "observe" && s.ok);
  const title = lastObs?.observation?.title || page.title || "";
  const url = lastObs?.observation?.url || page.url || "";
  let msg = `${maxSteps}/${maxSteps} 단계: 최대 단계에 도달했어. ${tools.length}개 액션 실행.`;
  if (title || url) msg += ` 마지막 페이지${title ? ` 「${title}」` : ""}${url ? ` (${url})` : ""}.`;
  return msg;
}

function finish({
  ok,
  reply,
  steps,
  needsConfirm,
  mode,
  sid,
  maxSteps,
  n,
  error,
  lastScreenshot,
  providerUsed,
  modelUsed,
  llmInfo,
}) {
  const prefixed =
    reply && !/^\d+\s*\/\s*\d+\s*단계/.test(reply) ? `${n}/${maxSteps} 단계: ${reply}` : reply;

  // thinking[] = think-type steps for convenience
  const thinking = steps.filter((s) => s.type === "think").map((s) => s.content);

  const out = {
    ok,
    error: error || (ok ? undefined : "failed"),
    reply: prefixed,
    steps,
    thinking,
    needs_confirm: needsConfirm,
    mode,
    session_id: sid,
    browser: "configured",
    llm: providerUsed || llmInfo?.provider || llmInfo?.note,
    model: modelUsed || undefined,
  };
  if (llmInfo?.provider !== "claude") {
    out.hint_anthropic =
      "True Claude extended thinking needs Worker secret ANTHROPIC_API_KEY (or CLAUDE_API_KEY). Browse currently uses " +
      (providerUsed || "gemini") +
      ".";
  }
  if (lastScreenshot) {
    const s = String(lastScreenshot);
    if (s.length <= 400000) out.last_screenshot = s;
  }
  return out;
}

function normalizeConfirm(confirm = {}) {
  const c = confirm && typeof confirm === "object" ? { ...confirm } : {};
  const hosts = Array.isArray(c.approved_hosts)
    ? c.approved_hosts.map((h) => String(h).toLowerCase()).filter(Boolean)
    : [];
  c.approved_hosts = hosts;
  return c;
}

function safeHost(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function redactArgs(args) {
  if (!args || typeof args !== "object") return args;
  const copy = { ...args };
  const sel = String(copy.selector || "");
  if (
    copy.is_password ||
    /password|passwd|pwd|비밀번호/i.test(sel) ||
    /type\s*=\s*["']?password/i.test(sel)
  ) {
    if (copy.text) copy.text = "***";
  }
  return copy;
}

function appendToolResult(messages, act, mode, planned, compact) {
  if ((mode === "tools" || act.id) && act.id) {
    if (planned._assistantPushed !== true) {
      messages.push({
        role: "assistant",
        content: planned.text || null,
        tool_calls: planned.actions
          .filter((a) => a.id)
          .map((a) => ({
            id: a.id,
            type: "function",
            function: { name: a.action, arguments: JSON.stringify(redactArgs(a.args || {})) },
          })),
      });
      planned._assistantPushed = true;
    }
    messages.push({
      role: "tool",
      tool_call_id: act.id,
      name: act.action,
      content: JSON.stringify(compact),
    });
  } else {
    messages.push({
      role: "assistant",
      content: JSON.stringify({
        thought: act.thought || planned.thinking || "",
        action: act.action,
        args: redactArgs(act.args),
      }),
    });
    messages.push({
      role: "user",
      content: `관찰(JSON): ${JSON.stringify(compact)}\n다음 액션 JSON을 한 줄로 (thought 포함).`,
    });
  }
}
