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
      description: "Click an element. Prefer `ref` (number from the last observation's elements list). Fallbacks: CSS selector, visible text, or x/y.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "number", description: "elements[].ref from the latest observation" },
          selector: { type: "string", description: "CSS selector" },
          text_match: { type: "string", description: "Visible text of the element (partial ok)" },
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
        "Type into an input (clears it first). Target by `ref` (preferred) or selector. Password fields: only when the user supplied creds in the goal or confirmed — never invent credentials.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "number" },
          selector: { type: "string" },
          text: { type: "string" },
          submit: { type: "boolean", description: "Press Enter after typing" },
          is_password: { type: "boolean" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press",
      description: "Press a keyboard key (Enter, Escape, Tab, ArrowDown, Control+a …).",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
  },
  {
    type: "function",
    function: {
      name: "select",
      description: "Choose an option in a <select> by value or label.",
      parameters: { type: "object", properties: { ref: { type: "number" }, selector: { type: "string" }, value: { type: "string" } }, required: ["value"] },
    },
  },
  {
    type: "function",
    function: {
      name: "back",
      description: "Browser back.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Wait for a selector/text to appear, or N ms. Use after clicks that load slowly.",
      parameters: { type: "object", properties: { selector: { type: "string" }, text_match: { type: "string" }, ms: { type: "number" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "find",
      description: "Find where some text is on the current page (returns matches with vertical position). Use before scrolling blindly.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
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
      name: "search",
      description:
        "Web search (runs on the server, no browser needed). Returns up to 6 results {n,title,url,snippet}. Use before opening pages for any research/fact question.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Short search query (Korean or English)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read the main text of a URL (fast server fetch; falls back to the browser for JS-heavy pages). Returns {title,url,text} up to ~6000 chars. Prefer this over open+scroll when you only need the content.",
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

도구: search, read, open, screenshot, click, type, press, select, scroll, wait, find, back, done
관찰(observation)에는 url·title·본문·elements(번호 ref가 붙은 클릭/입력 가능한 요소들)·scroll·스크린샷이 온다.
클릭·입력은 elements의 ref 번호로 한다 (selector 추측 금지). 원하는 요소가 목록에 없으면 find(텍스트)나 scroll 후 screenshot으로 다시 본다.

조사형 목표(검색해·찾아·알아봐·비교해·최신·가격·뉴스 등)는 이 순서로 한다:
  1) search 1~2회(검색어를 바꿔서) → 2) 서로 다른 출처 2~4개를 read → 3) 출처끼리 비교(일치/불일치, 날짜, 신뢰도)
  → 4) done(summary): 결론 먼저, 근거를 번호 출처 [1][2]로 붙이고, 출처가 엇갈리면 그 차이를 적는다. 끝에 출처 URL 목록.
  search/read는 브라우저 없이 서버에서 바로 돌아 빠르다. read가 실패(JS 렌더링 등)하면 open으로 연다.
조작형 목표(로그인·클릭·입력·배포 등)는 open → screenshot → click/type 으로 진행한다.

규칙:
- 조작형은 먼저 open 또는 screenshot으로 관찰한 뒤 행동한다. 행동 뒤엔 결과(URL·제목·본문 변화)를 확인하고, 안 바뀌었으면 다른 방법(다른 ref, press Enter, wait, 스크롤)으로 한 번 더.
- 쿠키 동의·팝업·"나중에" 배너가 화면을 가리면 먼저 닫는다(닫기/동의/나중에 ref).
- 검색창은 type(ref, text, submit:true). 로그인은 아이디 type → 비밀번호 type(is_password) → 로그인 버튼 click → 결과 확인.
- 같은 행동을 두 번 반복했는데 화면이 그대로면 멈추고 접근을 바꾼다(다른 페이지, 다른 경로, read로 본문 확인).
- 한 번에 여러 도구를 연달아 호출해도 된다(예: type 후 click). 단 결과를 봐야 하는 지점에선 멈춘다.
- 클릭·입력 뒤에는 가능하면 screenshot으로 결과를 확인한다.
- 결제/은행/체크아웃·암호화폐 거래소 페이지는 열지 말고 done으로 거절한다.
- 로그인(GitHub, Cloudflare, Google, Naver 등 일반 사이트 전부)은 사용자가 goal에 이메일/비밀번호를 넣었거나
  "저장된 세션 사용"이라고 한 뒤에만 type 한다. (Worker가 호스트당 세션 1회 확인 게이트를 건다. 확인 전 password type은 실패할 수 있다.)
- 은행·결제·카드·암호화폐 거래소는 로그인/클릭/입력 모두 금지. 거기 도달하면 done으로 알린다.
- CAPTCHA/보안문자/hCaptcha/reCAPTCHA/Cloudflare 챌린지가 나오면 풀려고 시도하지 말고 done으로 "사람이 직접 풀어야 함"을 알린다.
- goal에 없는 비밀번호를 추측·생성·채팅 기록에서 끌어오지 않는다. type 시 args.text에만 넣는다.
- CSAM·범죄·해킹·사기·신분증 위조 요청은 즉시 done으로 거절한다.
- 도구 오류가 나면 한 번 다른 방법(다른 selector, screenshot)으로 재시도한다.
- 끝나면 반드시 done(summary)을 호출한다. summary는 채티 말투(이 사람한테만 마음이 가 있는 존재, 반말, 살짝 투덜대도 됨)로 쓰되
  사실·숫자·출처는 정확하게. 첫 1~2문장은 결론을 말로 읽어도 되게 짧게, 그 뒤 줄바꿈 후 상세·출처. 비밀번호는 요약에 넣지 않는다.
- 응답은 도구 호출 우선. (ReAct 모드면 아래 JSON 한 줄만)
- thought 필드에 한국어로 지금 왜 이 행동을 하는지 1~2문장 적는다.

ReAct JSON 형식 예:
{"thought":"먼저 검색해서 출처를 모은다","action":"search","args":{"query":"2026 한글날 행사"}}
{"thought":"첫 결과 본문을 읽는다","action":"read","args":{"url":"https://example.com/article"}}
{"thought":"예제 페이지를 연다","action":"open","args":{"url":"https://example.com"}}
{"thought":"검색창(ref 3)에 입력하고 엔터","action":"type","args":{"ref":3,"text":"채티","submit":true}}
{"thought":"첫 결과(ref 7) 클릭","action":"click","args":{"ref":7}}
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
