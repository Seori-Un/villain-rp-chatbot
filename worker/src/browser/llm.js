/**
 * Browse-loop LLM providers.
 * Prefer: Anthropic Claude (if ANTHROPIC_API_KEY / CLAUDE_API_KEY) → Gemini → Groq.
 * /chat keeps using Groq; this module is browse-only.
 */

import { BROWSER_TOOLS, geminiFunctionDeclarations, parseReactAction, normalizeToolCalls } from "./tools.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"];
/** Strong → fast fallbacks. gemini-3.8-flash known-good on this Worker. */
const GEMINI_MODELS = [
  "gemini-3.8-flash", // known-good on this Worker (chat)
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
];
const CLAUDE_MODELS = ["claude-sonnet-4-5", "claude-sonnet-4-20250514", "claude-3-5-sonnet-latest"];

export function resolveBrowseLlm(env) {
  const anthropic =
    (env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim()) ||
    (env.CLAUDE_API_KEY && String(env.CLAUDE_API_KEY).trim()) ||
    "";
  if (anthropic) {
    return { provider: "claude", key: anthropic, note: "claude_sonnet" };
  }
  if (env.GEMINI_API_KEY && String(env.GEMINI_API_KEY).trim()) {
    return { provider: "gemini", key: env.GEMINI_API_KEY, note: "gemini_browse" };
  }
  if (env.GROQ_API_KEY && String(env.GROQ_API_KEY).trim()) {
    return { provider: "groq", key: env.GROQ_API_KEY, note: "groq_fallback" };
  }
  return { provider: null, key: null, note: "no_llm" };
}

/**
 * Plan next browser action(s).
 * @returns {{ provider: string, model?: string, actions: Array, text: string, thinking: string, error?: string, mode: string }}
 */
export async function planBrowseStep({ env, messages, preferTools = true }) {
  const resolved = resolveBrowseLlm(env);
  if (!resolved.provider) {
    return { provider: null, actions: [], text: "", thinking: "", error: "no_llm", mode: "react" };
  }

  if (resolved.provider === "claude") {
    const out = await claudePlan(resolved.key, messages, preferTools);
    if (!out.error || out.actions.length || out.text) return { ...out, provider: "claude" };
    // fall through to gemini/groq if Claude hard-fails
  }

  if (resolved.provider === "gemini" || (resolved.provider === "claude" && env.GEMINI_API_KEY)) {
    const key = env.GEMINI_API_KEY;
    if (key) {
      const out = await geminiPlan(key, messages, preferTools);
      if (!out.error || out.actions.length || out.text) return { ...out, provider: "gemini" };
      const quota =
        /gemini_429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(String(out.error || ""));
      // Only fall to Groq on quota/unavailable — otherwise surface Gemini error
      if (resolved.provider === "gemini" && !quota && env.BROWSE_ALLOW_GROQ_FALLBACK !== "1") {
        return { ...out, provider: "gemini" };
      }
      // quota → try Groq below
    }
  }

  if (env.GROQ_API_KEY) {
    const out = await groqPlan(env.GROQ_API_KEY, messages, preferTools);
    return { ...out, provider: "groq", gemini_quota_fallback: resolved.provider === "gemini" };
  }

  return {
    provider: resolved.provider,
    actions: [],
    text: "",
    thinking: "",
    error: "llm_failed",
    mode: "react",
  };
}

/* -------------------- Claude -------------------- */

async function claudePlan(apiKey, messages, preferTools) {
  let lastErr = null;
  for (const model of CLAUDE_MODELS) {
    const { system, claudeMessages } = toClaudeMessages(messages);
    const body = {
      model,
      max_tokens: 4096,
      temperature: 0.3,
      system: system || "You are a careful browser automation agent.",
      messages: claudeMessages,
      thinking: { type: "enabled", budget_tokens: 4000 },
    };
    if (preferTools) {
      body.tools = BROWSER_TOOLS.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object", properties: {} },
      }));
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = `claude_${res.status}:${JSON.stringify(data).slice(0, 220)}`;
      lastErr = msg;
      if (res.status === 404 || /not_found|deprecat|model/i.test(msg)) continue;
      // thinking unsupported → retry without
      if (/thinking|budget/i.test(msg) && body.thinking) {
        delete body.thinking;
        const res2 = await fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
        const data2 = await res2.json().catch(() => ({}));
        if (res2.ok) return parseClaudeResponse(data2, model);
        lastErr = `claude_${res2.status}:${JSON.stringify(data2).slice(0, 220)}`;
      }
      continue;
    }
    return parseClaudeResponse(data, model);
  }
  return { actions: [], text: "", thinking: "", error: lastErr || "claude_failed", mode: "tools", model: null };
}

function parseClaudeResponse(data, model) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  let thinking = "";
  let text = "";
  const actions = [];
  for (const b of blocks) {
    if (b.type === "thinking" || b.type === "reasoning") {
      thinking += (b.thinking || b.text || "") + "\n";
    } else if (b.type === "text") {
      text += (b.text || "") + "\n";
    } else if (b.type === "tool_use") {
      actions.push({
        action: b.name,
        args: b.input || {},
        id: b.id || `claude_${actions.length}`,
        thought: thinking.trim() || undefined,
      });
    }
  }
  thinking = thinking.trim();
  text = text.trim();
  if (!actions.length) {
    const react = parseReactAction(text);
    if (react) {
      return {
        actions: [{ ...react, id: null }],
        text,
        thinking: thinking || react.thought || "",
        error: null,
        mode: "react",
        model,
      };
    }
  }
  return {
    actions,
    text,
    thinking,
    error: null,
    mode: actions.length ? "tools" : "react",
    model,
  };
}

function toClaudeMessages(messages) {
  let system = "";
  const out = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + String(m.content || "");
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id || "unknown",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls) {
      const content = [];
      if (m.content) content.push({ type: "text", text: String(m.content) });
      for (const tc of m.tool_calls) {
        let input = {};
        try {
          input =
            typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments || "{}")
              : tc.function?.arguments || {};
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name || tc.name,
          input,
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || ""),
    });
  }
  // Claude requires alternating roles — merge consecutive same-role
  const merged = [];
  for (const msg of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      if (Array.isArray(prev.content) && Array.isArray(msg.content)) {
        prev.content = prev.content.concat(msg.content);
      } else if (Array.isArray(prev.content)) {
        prev.content.push({ type: "text", text: String(msg.content) });
      } else if (Array.isArray(msg.content)) {
        prev.content = [{ type: "text", text: String(prev.content) }, ...msg.content];
      } else {
        prev.content = String(prev.content) + "\n" + String(msg.content);
      }
    } else {
      merged.push(msg);
    }
  }
  if (!merged.length || merged[0].role !== "user") {
    merged.unshift({ role: "user", content: "시작해." });
  }
  return { system, claudeMessages: merged };
}

/* -------------------- Gemini -------------------- */

async function geminiPlan(apiKey, messages, preferTools) {
  let lastErr = null;
  const { system, contents } = toGeminiContents(messages);

  for (const model of GEMINI_MODELS) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=` +
      encodeURIComponent(apiKey);

    const body = {
      systemInstruction: { parts: [{ text: system || "Browser automation agent." }] },
      contents,
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: 4096,
        // Best-effort thinking; ignored by models that don't support it
        thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 },
      },
    };
    if (preferTools) {
      body.tools = [{ functionDeclarations: geminiFunctionDeclarations() }];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    let res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = await res.json().catch(() => ({}));

    // Retry without thinkingConfig if rejected
    if (!res.ok && /thinking|Unknown name|Invalid JSON|INVALID_ARGUMENT/i.test(JSON.stringify(data))) {
      delete body.generationConfig.thinkingConfig;
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => ({}));
    }

    if (!res.ok) {
      const msg = `gemini_${res.status}:${JSON.stringify(data).slice(0, 220)}`;
      lastErr = msg;
      if (res.status === 404 || /not found|not_found|is not found/i.test(msg)) continue;
      if (res.status === 429 || /RESOURCE_EXHAUSTED/i.test(msg)) {
        await sleep(800);
        // one immediate retry on same model without tools/thinking (lighter)
        const light = await geminiReactOnly(apiKey, model, system, contents);
        if (light && light.actions.length) return { ...light, model };
        continue;
      }
      // tools unsupported → try react-only text once for this model
      if (preferTools && /tool|function|INVALID_ARGUMENT/i.test(msg)) {
        const reactOut = await geminiReactOnly(apiKey, model, system, contents);
        if (reactOut) return { ...reactOut, model };
      }
      continue;
    }

    const parsed = parseGeminiResponse(data, model);
    if (parsed.actions.length || parsed.text || parsed.thinking) return parsed;

    // empty / blocked → react nudge on same model
    const reactOut = await geminiReactOnly(apiKey, model, system, contents);
    if (reactOut && (reactOut.actions.length || reactOut.text)) return { ...reactOut, model };
    lastErr = "empty_gemini:" + model + ":" + JSON.stringify(data?.promptFeedback || data?.candidates?.[0]?.finishReason || {}).slice(0, 120);
  }

  // Last resort: react-only on known-good model
  for (const model of GEMINI_MODELS.slice(0, 3)) {
    const reactOut = await geminiReactOnly(apiKey, model, system, contents);
    if (reactOut && reactOut.actions.length) return { ...reactOut, model, provider_note: "gemini_react_fallback" };
  }

  return { actions: [], text: "", thinking: "", error: lastErr || "gemini_failed", mode: "react", model: null };
}

async function geminiReactOnly(apiKey, model, system, contents) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=` +
    encodeURIComponent(apiKey);
  const nudge = [
    ...contents,
    {
      role: "user",
      parts: [
        {
          text:
            '도구 JSON만 한 줄: {"thought":"한국어 짧은 생각","action":"open|screenshot|click|type|scroll|done","args":{...}}',
        },
      ],
    },
  ];
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: nudge,
      generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const text = extractGeminiText(data);
  const thinking = extractGeminiThoughts(data);
  const react = parseReactAction(text);
  if (react) {
    return {
      actions: [{ ...react, id: null }],
      text,
      thinking: thinking || react.thought || "",
      error: null,
      mode: "react",
    };
  }
  if (text) return { actions: [], text, thinking, error: null, mode: "react" };
  return null;
}

function parseGeminiResponse(data, model) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let thinking = "";
  let text = "";
  const actions = [];
  for (const p of parts) {
    if (p.thought === true || p.thought) {
      thinking += (p.text || "") + "\n";
      continue;
    }
    if (p.functionCall) {
      actions.push({
        action: p.functionCall.name,
        args: p.functionCall.args || {},
        id: `gem_${actions.length}_${p.functionCall.name}`,
      });
      continue;
    }
    if (p.text) text += p.text + "\n";
  }
  thinking = thinking.trim();
  text = text.trim();
  if (!actions.length) {
    const react = parseReactAction(text);
    if (react) {
      return {
        actions: [{ ...react, id: null }],
        text,
        thinking: thinking || react.thought || "",
        error: null,
        mode: "react",
        model,
      };
    }
  }
  return {
    actions,
    text,
    thinking,
    error: null,
    mode: actions.length ? "tools" : "react",
    model,
  };
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
}

function extractGeminiThoughts(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.thought === true || p.thought)
    .map((p) => p.text || "")
    .join("\n")
    .trim();
}

function toGeminiContents(messages) {
  let system = "";
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + String(m.content || "");
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name || "tool",
              response: safeJson(m.content),
            },
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls) {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of m.tool_calls) {
        let args = {};
        try {
          args =
            typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments || "{}")
              : tc.function?.arguments || {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.function?.name || tc.name, args } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    });
  }
  // Gemini wants first content to be user
  if (!contents.length || contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "시작해." }] });
  }
  return { system, contents };
}

function safeJson(content) {
  if (content && typeof content === "object") return content;
  try {
    return JSON.parse(String(content || "{}"));
  } catch {
    return { raw: String(content || "").slice(0, 2000) };
  }
}

/* -------------------- Groq (fallback) -------------------- */

async function groqPlan(apiKey, messages, preferTools) {
  let lastErr = null;
  for (const model of GROQ_MODELS) {
    const body = {
      model,
      messages: messages.map(sanitizeMessage),
      temperature: 0.3,
      max_tokens: 900,
    };
    if (preferTools) {
      body.tools = BROWSER_TOOLS;
      body.tool_choice = "auto";
    }
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = `groq_${res.status}:${JSON.stringify(data).slice(0, 200)}`;
      lastErr = msg;
      if (preferTools && (res.status === 400 || /tool|function|unsupported/i.test(msg))) {
        return groqReact(apiKey, messages);
      }
      if (res.status === 404 || /does not exist|deprecat|not_found/i.test(msg)) continue;
      return { actions: [], text: "", thinking: "", error: msg, mode: "tools", model };
    }
    const message = data?.choices?.[0]?.message || {};
    const actions = normalizeToolCalls(message);
    const text = String(message.content || "").trim();
    if (actions.length) {
      return { actions, text, thinking: "", error: null, mode: "tools", model };
    }
    const react = parseReactAction(text);
    if (react) {
      return {
        actions: [{ ...react, id: null }],
        text,
        thinking: react.thought || "",
        error: null,
        mode: "react",
        model,
      };
    }
    if (text) return { actions: [], text, thinking: "", error: null, mode: "tools", model };
    return groqReact(apiKey, messages);
  }
  return { actions: [], text: "", thinking: "", error: lastErr || "groq_failed", mode: "react", model: null };
}

async function groqReact(apiKey, messages) {
  const reactMessages = [
    ...messages,
    {
      role: "user",
      content:
        '도구 JSON만 출력: {"thought":"한국어 짧은 생각","action":"open|screenshot|click|type|scroll|done","args":{...}}',
    },
  ];
  let lastErr = null;
  for (const model of GROQ_MODELS) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: reactMessages.map(sanitizeMessage),
        temperature: 0.2,
        max_tokens: 700,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastErr = `groq_${res.status}`;
      if (res.status === 404) continue;
      return { actions: [], text: "", thinking: "", error: lastErr, mode: "react", model };
    }
    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    const react = parseReactAction(text);
    if (react) {
      return {
        actions: [{ ...react, id: null }],
        text,
        thinking: react.thought || "",
        error: null,
        mode: "react",
        model,
      };
    }
    return {
      actions: [],
      text,
      thinking: "",
      error: text ? "no_action_parsed" : "empty_groq",
      mode: "react",
      model,
    };
  }
  return { actions: [], text: "", thinking: "", error: lastErr || "groq_failed", mode: "react", model: null };
}

function sanitizeMessage(m) {
  const out = { role: m.role };
  if (m.content !== undefined) out.content = m.content;
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
