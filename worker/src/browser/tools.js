/**
 * Browser agent tool schemas (OpenAI/Groq/Claude/Gemini shapes)
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
      parameters: {
        type: "object",
        properties: {
          full_page: { type: "boolean", description: "Optional; runner may ignore" },
        },
      },
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
        "Type text into an input. Password fields: only when user supplied creds in goal (dev allowlist) or confirmed — never invent credentials.",
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
      description: "Finish the task and report a clear Korean summary to the user.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was done / result in Korean" },
        },
        required: ["summary"],
      },
    },
  },
];

export const TOOL_NAMES = BROWSER_TOOLS.map((t) => t.function.name);

/** Gemini functionDeclarations (strip OpenAI wrapper). */
export function geminiFunctionDeclarations() {
  return BROWSER_TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters || { type: "object", properties: {} },
  }));
}

/** System prompt for tool-calling or ReAct JSON mode */
export function browserSystemPrompt({ maxSteps }) {
  return `너는 신중한 브라우저 자동화 에이전트다. 사용자 goal을 달성하기 위해 도구를 사용한다.
매 행동 전에 짧게 생각하고(한국어), 관찰한 뒤 다음 행동을 고른다.
다단계 작업은 "n/${maxSteps} 단계" 식으로 보고한다.

도구: open, screenshot, click, type, scroll, done
규칙:
- 먼저 open 또는 screenshot으로 관찰한 뒤 행동한다.
- 클릭·입력 뒤에는 가능하면 screenshot으로 결과를 확인한다.
- 결제/은행/체크아웃·암호화폐 거래소 페이지는 열지 말고 done으로 거절한다.
- 개발 도구 허용 목록(github, gitlab, cloudflare, vercel, npm, huggingface 등) 로그인은
  사용자가 goal에 이메일/비밀번호를 넣었거나 "저장된 세션 사용"이라고 한 뒤에만 type 한다.
  (Worker가 세션·호스트당 확인 게이트를 건다. 확인 전 password type은 실패할 수 있다.)
- 허용 목록 밖 사이트의 비밀번호는 사용자가 명시적으로 confirm하기 전에는 type 하지 않는다.
- goal에 없는 비밀번호를 추측·생성·채팅 기록에서 끌어오지 않는다. type 시 args.text에만 넣는다.
- CSAM·범죄·해킹·사기·신분증 위조 요청은 즉시 done으로 거절한다.
- 도구 오류가 나면 한 번 다른 방법(다른 selector, screenshot)으로 재시도한다.
- 끝나면 반드시 done(summary)을 호출한다. summary는 한국어로 구체적이고 친절하게. 비밀번호는 요약에 넣지 않는다.
- 응답은 도구 호출 우선. (ReAct 모드면 아래 JSON 한 줄만)
- thought 필드에 한국어로 지금 왜 이 행동을 하는지 1~2문장 적는다.

ReAct JSON 형식 예:
{"thought":"예제 페이지를 연다","action":"open","args":{"url":"https://example.com"}}
{"thought":"제목을 확인했다","action":"done","args":{"summary":"example.com을 열었고 제목은 Example Domain이야."}}`;
}

/**
 * Parse ReAct-style JSON action from model text.
 * @returns {{ action: string, args: object, thought?: string } | null}
 */
/** Extract first balanced JSON object from text. */
export function extractFirstJsonObject(text) {
  const raw = String(text || "");
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  let i = 0;
  while (i < candidate.length) {
    const start = candidate.indexOf("{", i);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < candidate.length; j++) {
      const ch = candidate[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, j + 1));
          } catch {
            i = j + 1;
            break;
          }
        }
      }
    }
    if (depth !== 0) return null;
  }
  return null;
}

export function parseReactAction(text) {
  const obj = extractFirstJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  try {
    const action = obj.action || obj.name || obj.tool;
    if (!action || !TOOL_NAMES.includes(action)) return null;
    let args = obj.args || obj.arguments || obj.parameters || {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { action, args, thought: obj.thought || obj.reasoning || obj.thinking };
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
      args =
        typeof c.function?.arguments === "string"
          ? JSON.parse(c.function.arguments || "{}")
          : c.function?.arguments || {};
    } catch {
      args = {};
    }
    out.push({ action: name, args, id: c.id || `call_${out.length}` });
  }
  return out;
}
