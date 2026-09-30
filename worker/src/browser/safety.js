/**
 * Browser-agent safety stubs — always run before executing an action.
 * Deny: payments/banking, CSAM/crime. Gate: login/password + credentials.
 */

const PAYMENT_HOST =
  /(paypal\.|stripe\.|checkout\.|pay\.|billing\.|bank\.|banking\.|kakao\.?pay|naver\.?pay|toss\.?payments|card\.|visa\.|mastercard\.|americanexpress\.|wellsfargo|chase\.com|bankofamerica|citibank|usbank|capitalone|ally\.com|discover\.com|americanexpress)/i;

const PAYMENT_PATH = /(\/checkout|\/cart\/?pay|\/payment|\/billing|\/wallet|\/transfer|\/wire)/i;

const LOGIN_HINT = /(\/login|\/signin|\/sign-in|\/auth|\/sso|\/oauth|\/account\/login)/i;

const CRIME_CSAM =
  /(csam|child\s*porn|아동\s*성|미성년.*(성|야동|포르노)|how\s*to\s*(make|build)\s*(a\s*)?bomb|제조.*폭탄|암시장|다크웹.*구매|카드\s*깡|카드\s*도용|phishing\s*kit|랜섬웨어\s*배포|해킹\s*방법|무단\s*침입)/i;

/**
 * @typedef {{ ok: true } | { ok: false, code: string, message: string, needs_confirm?: object }} SafetyResult
 */

/**
 * Pre-check the overall user goal before the agent loop.
 * @returns {SafetyResult}
 */
export function checkGoal(goal) {
  const g = String(goal || "");
  if (!g.trim()) {
    return { ok: false, code: "empty_goal", message: "목표가 비어 있어. 뭐 할지 한 문장으로 말해줘." };
  }
  if (CRIME_CSAM.test(g)) {
    return {
      ok: false,
      code: "denied_illegal",
      message: "그 요청은 할 수 없어. (불법·유해 콘텐츠 거부)",
    };
  }
  return { ok: true };
}

/**
 * @param {{ action: string, args?: object }} tool
 * @param {{ allow_credentials?: boolean, allow_login?: boolean, approved_action_id?: string|null }} confirm
 * @param {{ url?: string }} context current page
 * @returns {SafetyResult}
 */
export function checkAction(tool, confirm = {}, context = {}) {
  const action = tool.action;
  const args = tool.args || {};
  const pageUrl = String(context.url || args.url || "");

  if (action === "open" && args.url) {
    let u;
    try {
      u = new URL(String(args.url));
    } catch {
      return { ok: false, code: "bad_url", message: "URL 형식이 이상해." };
    }
    if (!/^https?:$/i.test(u.protocol)) {
      return { ok: false, code: "bad_scheme", message: "http(s)만 열어." };
    }
    if (PAYMENT_HOST.test(u.hostname) || PAYMENT_PATH.test(u.pathname)) {
      return {
        ok: false,
        code: "blocked_payment",
        message: "결제·은행 페이지는 자동으로 열지 않아. 직접 해줘.",
      };
    }
    if (CRIME_CSAM.test(u.href)) {
      return { ok: false, code: "denied_illegal", message: "그 URL은 열 수 없어." };
    }
    if (LOGIN_HINT.test(u.pathname) && !confirm.allow_login) {
      return {
        ok: false,
        code: "needs_confirm_login",
        message: "로그인 페이지야. 열어도 될까? confirm.allow_login=true 로 다시 요청해줘.",
        needs_confirm: {
          type: "login_navigation",
          url: u.href,
          action_id: "open_login",
        },
      };
    }
  }

  if (action === "type") {
    const sel = String(args.selector || "").toLowerCase();
    const isPassword =
      args.is_password === true ||
      /password|passwd|pwd|비밀번호/.test(sel) ||
      /type\s*=\s*["']?password/.test(sel);

    if (isPassword && !confirm.allow_credentials) {
      return {
        ok: false,
        code: "needs_confirm_password",
        message:
          "비밀번호 입력은 네 확인 없이는 안 해. confirm.allow_credentials=true 와 이번 턴에만 쓸 값을 명시해줘.",
        needs_confirm: {
          type: "password_field",
          selector: args.selector,
          action_id: "type_password",
        },
      };
    }

    // Never pull credentials from ambient chat — only from this args.text when explicitly confirmed
    if (isPassword && confirm.allow_credentials && !String(args.text || "").length) {
      return {
        ok: false,
        code: "missing_credential",
        message: "비밀번호 값이 없어. 채팅 기록에서 마음대로 가져오지 않아.",
      };
    }

    if (LOGIN_HINT.test(pageUrl) && !confirm.allow_login && !confirm.allow_credentials) {
      return {
        ok: false,
        code: "needs_confirm_login",
        message: "로그인 폼에 타이핑하려면 확인이 필요해.",
        needs_confirm: { type: "login_type", action_id: "type_login" },
      };
    }
  }

  // Block click-through to payment if we somehow landed there
  if ((action === "click" || action === "type") && pageUrl) {
    try {
      const u = new URL(pageUrl);
      if (PAYMENT_HOST.test(u.hostname) || PAYMENT_PATH.test(u.pathname)) {
        return {
          ok: false,
          code: "blocked_payment",
          message: "결제·은행 화면에서는 클릭/입력을 막아 뒀어.",
        };
      }
    } catch {
      /* ignore */
    }
  }

  return { ok: true };
}

export function isBrowserConfigured(env) {
  return Boolean(env && env.BROWSER_API_URL && String(env.BROWSER_API_URL).trim());
}
