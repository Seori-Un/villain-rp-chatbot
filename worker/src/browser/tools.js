/**
 * Browser agent tool schemas (OpenAI/Groq function-calling shape)
 * + ReAct JSON fallback prompt fragment.
 */

export const BROWSER_TOOLS = [
  {
    type: "function",
    function: {
      name: "open",
      description: "Open a URL in the browser session.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Capture current page observation (URL, title, text snippet, screenshot).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an element by CSS selector or viewport coordinates.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          x: { type: "number" },
          y: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description:
        "Type text into an input. Password/login fields require user confirm — do not invent credentials.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
          submit: { type: "boolean", description: "Press Enter after typing" },
          is_password: { type: "boolean" },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          amount: { type: "number", description: "Pixels (default 600)" },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Finish the task and report a Korean summary to the user.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was done / result" },
        },
        required: ["summary"],
      },
    },
  },
];

export const TOOL_NAMES = BROWSER_TOOLS.map((t) => t.function.name);

/** System prompt for tool-calling or ReAct JSON mode */
export function browserSystemPrompt({ maxSteps }) {
  return `너는 브라우저 자동화 에이전트다. 사용자 goal을 달성하기 위해 도구만 사용한다.
다단계 작업은 "n/${maxSteps} 단계" 식으로 짧게 보고한다 (한국어).

도구: open, screenshot, click, type, scroll, done
규칙:
- 먼저 open 또는 screenshot으로 관찰한 뒤 행동한다.
- 결제/은행/체크아웃 페이지는 열지 말고 done으로 거절한다.
- 로그인·비밀번호 입력은 사용자가 confirm하기 전에는 type 하지 않는다.
- 채팅에 적힌 비밀번호를 마음대로 type 하지 않는다.
- CSAM·범죄·해킹·사기 요청은 즉시 done으로 거절한다.
- 끝나면 반드시 done(summary)을 호출한다.
- 응답은 도구 호출만. (ReAct 모드면 아래 JSON 한 줄만)

ReAct JSON 형식 예:
{"thought":"페이지를 연다","action":"open","args":{"url":"https://example.com"}}
{"thought":"완료","action":"done","args":{"summary":"1/1 단계: 열었다."}}`;
}

/**
 * Parse ReAct-style JSON action from model text.
 * @returns {{ action: string, args: object, thought?: string } | null}
 */
export function parseReactAction(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  // fenced or bare JSON
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    const action = obj.action || obj.name || obj.tool;
    if (!action || !TOOL_NAMES.includes(action)) return null;
    const args = obj.args || obj.arguments || obj.parameters || {};
    return { action, args: typeof args === "string" ? JSON.parse(args) : args, thought: obj.thought };
  } catch {
    return null;
  }
}

/** Normalize OpenAI tool_calls → { action, args, id }[] */
export function normalizeToolCalls(message) {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return [];
  const out = [];
  for (const c of calls) {
    const name = c.function?.name || c.name;
    if (!name || !TOOL_NAMES.includes(name)) continue;
    let args = {};
    try {
      args = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function?.arguments || {};
    } catch {
      args = {};
    }
    out.push({ action: name, args, id: c.id || `call_${out.length}` });
  }
  return out;
}
