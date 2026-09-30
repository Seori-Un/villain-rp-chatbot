/**
 * Task / browse-intent heuristics for secretary mode.
 * Used by POST /agent (mirrored lightly on the frontend).
 */

export function stripWebPrefix(text) {
  return String(text || "")
    .replace(/^\s*\/웹\s*/i, "")
    .replace(/^\s*\/web\s*/i, "")
    .replace(/^\s*\/browse\s*/i, "")
    .trim();
}

/**
 * True when the utterance looks like a web/tool task
 * (검색/열어/로그인/배포/찾아/확인해 …) or has /웹|/web|/browse prefix.
 */
export function looksLikeBrowseTask(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/^\s*\/(?:웹|web|browse)(?=\s|$)/i.test(raw)) return true;
  // Slash RP commands stay on /chat
  if (/^\s*\//.test(raw)) return false;

  const t = raw.normalize("NFC");

  if (/(웹\s*(으로|에서|검색|열어|확인)|브라우저|검색해|구글|네이버|사이트\s*열)/.test(t)) {
    return true;
  }

  if (
    /(검색|열어|열어줘|열어봐|로그인|배포|찾아|찾아줘|확인해|확인하|확인\s*해|클릭|스크롤|캡처|스크린샷|접속|들어가|들어가서|들어가줘|다운로드|업로드|설치|설정|가입|회원가입|티켓|예약|가격|시세|뉴스|날씨|지도|링크|URL|url|http)/.test(
      t
    )
  ) {
    return true;
  }

  if (/\b[\w-]+\.(com|net|org|io|dev|kr|co\.kr|ai|app)\b/i.test(t)) return true;
  if (/https?:\/\//i.test(t)) return true;

  return false;
}

/**
 * Route hint for /agent: "browse" | "chat"
 * force_browse / force_chat from client override heuristics.
 */
export function routeAgentMode(body) {
  const force = (body?.mode || body?.force || "").toString().toLowerCase();
  if (force === "browse" || force === "web" || force === "secretary_browse") return "browse";
  if (force === "chat" || force === "rp" || force === "roleplay") return "chat";
  const msg = (body?.message || body?.text || body?.goal || "").toString();
  return looksLikeBrowseTask(msg) ? "browse" : "chat";
}
