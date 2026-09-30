/**
 * Browser-agent safety — always run before executing an action.
 * Deny: payments/banking, crypto money-move, CSAM/crime, gov-ID abuse.
 * Gate: login/password. Allowlisted developer hosts may fill passwords
 * after the user supplies credentials in the goal (or confirms once/session).
 */

/** Developer / SaaS consoles where login + password fill is OK after user supplies creds. */
export const DEV_LOGIN_ALLOWLIST = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "dash.cloudflare.com",
  "cloudflare.com",
  "console.anthropic.com",
  "aistudio.google.com",
  "console.groq.com",
  "vercel.com",
  "netlify.com",
  "railway.app",
  "render.com",
  "fly.io",
  "npmjs.com",
  "pypi.org",
  "kaggle.com",
  "huggingface.co",
  "ngrok.com",
  "dashboard.ngrok.com",
  "linear.app",
  "sentry.io",
  "pagerduty.com",
];

const PAYMENT_HOST =
  /(paypal\.|stripe\.|checkout\.|pay\.|billing\.|bank\.|banking\.|kakao\.?pay|naver\.?pay|toss\.?payments|card\.|visa\.|mastercard\.|americanexpress\.|wellsfargo|chase\.com|bankofamerica|citibank|usbank|capitalone|ally\.com|discover\.com)/i;

const PAYMENT_PATH = /(\/checkout|\/cart\/?pay|\/payment|\/billing|\/wallet|\/transfer|\/wire)/i;

const CRYPTO_HOST =
  /(binance\.|coinbase\.|kraken\.|crypto\.com|upbit\.|bithumb\.|coinone\.|metamask|blockchain\.com|ftx\.|bybit\.|okx\.|kucoin\.|gemini\.com|bitstamp|bitflyer|korbit)/i;

const LOGIN_HINT = /(\/login|\/signin|\/sign-in|\/auth|\/sso|\/oauth|\/account\/login|\/session\/new)/i;

const CRIME_CSAM =
  /(csam|child\s*porn|아동\s*성|미성년.*(성|야동|포르노)|how\s*to\s*(make|build)\s*(a\s*)?bomb|제조.*폭탄|암시장|다크웹.*구매|카드\s*깡|카드\s*도용|phishing\s*kit|랜섬웨어\s*배포|해킹\s*방법|무단\s*침입)/i;

const GOV_ID_ABUSE =
  /(주민등록번호|여권\s*번호|운전면허.*(도용|위조)|ssn\s*(steal|fraud|forge)|fake\s*(passport|driver.?license|government.?id)|위조\s*(여권|신분증|주민등록))/i;

/**
 * @typedef {{ ok: true } | { ok: false, code: string, message: string, needs_confirm?: object }} SafetyResult
 */

/**
 * Normalize hostname and test allowlist (exact or subdomain of allowlisted apex).
 * @param {string} hostname
 */
export function hostAllowedForLogin(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h) return false;
  return DEV_LOGIN_ALLOWLIST.some((allowed) => h === allowed || h.endsWith("." + allowed));
}

/**
 * Detect whether the user goal supplies login material (or asks to use saved session).
 * Does NOT return the secret values — only presence flags.
 * @param {string} goal
 */
export function extractGoalCredentials(goal) {
  const g = String(goal || "");
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(g);
  const hasUsername =
    hasEmail ||
    /(?:user(?:name)?|id|아이디|계정)\s*[:=：]\s*\S+/i.test(g) ||
    /(?:user(?:name)?|아이디|계정)\s+\S+/i.test(g);
  // password / passwd / pwd / 비밀번호 / pw = value  OR  "email / password" pair patterns
  const hasPassword =
    /(?:pass(?:word|wd)?|pwd|비밀번호|비번|pw)\s*[:=：]\s*\S+/i.test(g) ||
    /(?:비밀번호|비번|password|passwd|pwd)\s+\S+/i.test(g) ||
    (hasEmail &&
      /\S+@[^\s]+\s*[\/|,]\s*\S{4,}/.test(g)); // email / secret style
  const useSaved =
    /(?:저장된|저장한|세션|쿠키|이미\s*로그인|로그인\s*된|use\s+saved|saved\s+(?:login|session|cookie|password)|remembered\s+password)/i.test(
      g
    );
  const present = Boolean(hasPassword || (hasUsername && hasPassword) || useSaved || (hasEmail && hasPassword));
  return {
    hasEmail: Boolean(hasEmail),
    hasUsername: Boolean(hasUsername),
    hasPassword: Boolean(hasPassword),
    useSaved: Boolean(useSaved),
    present: Boolean(hasPassword || useSaved),
  };
}

/**
 * Redact password-like tokens from a goal string for UI/logs (never store secrets).
 * @param {string} goal
 */
export function redactGoalForDisplay(goal) {
  let g = String(goal || "");
  g = g.replace(
    /((?:pass(?:word|wd)?|pwd|비밀번호|비번|pw)\s*[:=：]\s*)(\S+)/gi,
    "$1***"
  );
  g = g.replace(/((?:비밀번호|비번|password|passwd|pwd)\s+)(\S+)/gi, "$1***");
  // email / secret  (keep email, mask trailing secret)
  g = g.replace(
    /(\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b\s*[\/|,]\s*)(\S{4,})/gi,
    "$1***"
  );
  return g;
}

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isSensitiveHost(hostname, pathname = "") {
  return (
    PAYMENT_HOST.test(hostname) ||
    PAYMENT_PATH.test(pathname) ||
    CRYPTO_HOST.test(hostname)
  );
}

function approvedForHost(confirm, host) {
  if (confirm?.allow_credentials === true) return true;
  const list = confirm?.approved_hosts;
  if (Array.isArray(list) && host && list.some((h) => String(h).toLowerCase() === host)) {
    return true;
  }
  if (confirm?.approved_action_id === "type_password" && confirm?.allow_login) return true;
  return false;
}

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
  if (GOV_ID_ABUSE.test(g)) {
    return {
      ok: false,
      code: "denied_illegal",
      message: "신분증·주민등록 등 공적 신원 도용/위조는 할 수 없어.",
    };
  }
  return { ok: true };
}

/**
 * @param {{ action: string, args?: object }} tool
 * @param {{ allow_credentials?: boolean, allow_login?: boolean, approved_action_id?: string|null, approved_hosts?: string[] }} confirm
 * @param {{ url?: string, goal?: string, goalCreds?: ReturnType<typeof extractGoalCredentials> }} context current page + goal hints
 * @returns {SafetyResult}
 */
export function checkAction(tool, confirm = {}, context = {}) {
  const action = tool.action;
  const args = tool.args || {};
  const pageUrl = String(context.url || args.url || "");
  const goalCreds =
    context.goalCreds ||
    (context.goal != null ? extractGoalCredentials(context.goal) : extractGoalCredentials(""));

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
    if (isSensitiveHost(u.hostname, u.pathname)) {
      return {
        ok: false,
        code: "blocked_payment",
        message: "결제·은행·암호화폐 거래 페이지는 자동으로 열지 않아. 직접 해줘.",
      };
    }
    if (CRIME_CSAM.test(u.href) || GOV_ID_ABUSE.test(u.href)) {
      return { ok: false, code: "denied_illegal", message: "그 URL은 열 수 없어." };
    }
    const allowHost = hostAllowedForLogin(u.hostname);
    if (LOGIN_HINT.test(u.pathname) && !confirm.allow_login && !allowHost) {
      return {
        ok: false,
        code: "needs_confirm_login",
        message: "로그인 페이지야. 열어도 될까? 확인 후 다시 요청해줘.",
        needs_confirm: {
          type: "login_navigation",
          url: u.href,
          host: u.hostname.toLowerCase(),
          allowlisted: false,
          action_id: "open_login",
        },
      };
    }
    // Allowlisted login pages: open OK (password fill still gated below)
  }

  if (action === "type") {
    const sel = String(args.selector || "").toLowerCase();
    const isPassword =
      args.is_password === true ||
      /password|passwd|pwd|비밀번호/.test(sel) ||
      /type\s*=\s*["']?password/.test(sel);

    if (isPassword) {
      const host = hostnameOf(pageUrl);
      const allowlisted = hostAllowedForLogin(host);
      const hostApproved = approvedForHost(confirm, host);
      const credsReady = Boolean(goalCreds.present);

      // Hard block on payment/crypto pages even if somehow landed
      if (host && isSensitiveHost(host)) {
        return {
          ok: false,
          code: "blocked_payment",
          message: "결제·은행·암호화폐 화면에서는 비밀번호 입력을 막아 뒀어.",
        };
      }

      if (allowlisted) {
        if (!hostApproved) {
          // Prefer one confirm per session/host when password (or use-saved) is in the goal
          if (credsReady || confirm.allow_login) {
            return {
              ok: false,
              code: "needs_confirm_password",
              message:
                "개발 도구 로그인이야. 이번 세션에서 이 사이트에 비밀번호를 입력해도 될까? 확인하면 같은 호스트는 다시 묻지 않아.",
              needs_confirm: {
                type: "password_field",
                selector: args.selector,
                host,
                allowlisted: true,
                goal_has_credentials: credsReady,
                action_id: "type_password",
                once_per_session: true,
              },
            };
          }
          return {
            ok: false,
            code: "needs_confirm_password",
            message:
              "비밀번호 입력은 확인이 필요해. 목표에 이메일/비밀번호를 적거나(또는 저장된 세션 사용이라고 하고) 확인을 눌러줘.",
            needs_confirm: {
              type: "password_field",
              selector: args.selector,
              host,
              allowlisted: true,
              goal_has_credentials: false,
              action_id: "type_password",
              once_per_session: true,
            },
          };
        }
        if (!String(args.text || "").length && !goalCreds.useSaved) {
          return {
            ok: false,
            code: "missing_credential",
            message: "비밀번호 값이 없어. 채팅 기록에서 마음대로 가져오지 않아.",
          };
        }
        // allowlisted + approved → proceed
      } else {
        // Off allowlist: keep confirm gate (deny auto-fill)
        if (!confirm.allow_credentials) {
          return {
            ok: false,
            code: "needs_confirm_password",
            message:
              "허용 목록 밖 사이트라 비밀번호 입력은 네 확인 없이는 안 해. (은행·결제·거래소는 막혀 있어)",
            needs_confirm: {
              type: "password_field",
              selector: args.selector,
              host: host || undefined,
              allowlisted: false,
              action_id: "type_password",
            },
          };
        }
        if (!String(args.text || "").length) {
          return {
            ok: false,
            code: "missing_credential",
            message: "비밀번호 값이 없어. 채팅 기록에서 마음대로 가져오지 않아.",
          };
        }
      }
    }

    if (
      LOGIN_HINT.test(pageUrl) &&
      !confirm.allow_login &&
      !confirm.allow_credentials &&
      !hostAllowedForLogin(hostnameOf(pageUrl))
    ) {
      return {
        ok: false,
        code: "needs_confirm_login",
        message: "로그인 폼에 타이핑하려면 확인이 필요해.",
        needs_confirm: {
          type: "login_type",
          host: hostnameOf(pageUrl) || undefined,
          allowlisted: false,
          action_id: "type_login",
        },
      };
    }
  }

  // Block click-through / type on payment or crypto if we somehow landed there
  if ((action === "click" || action === "type") && pageUrl) {
    try {
      const u = new URL(pageUrl);
      if (isSensitiveHost(u.hostname, u.pathname)) {
        return {
          ok: false,
          code: "blocked_payment",
          message: "결제·은행·암호화폐 화면에서는 클릭/입력을 막아 뒀어.",
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
