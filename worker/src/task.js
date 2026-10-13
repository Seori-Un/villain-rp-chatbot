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
  // Slash commands stay on /chat
  if (/^\s*\//.test(raw)) return false;

  const t = raw.normalize("NFC");
  // v1.6: simple lookups (뉴스·날씨·가격·"검색해") are answered by /chat with auto web search.
  // Only *actions in a browser* or explicit deep research go to the /browse agent.
  if (/(브라우저|사이트\s*(를\s*)?(열|들어가)|페이지\s*(를\s*)?열|탭\s*열)/.test(t)) return true;
  if (
    /(열어\s*(줘|봐|서)?|로그인|로그아웃|배포|클릭|스크롤|캡처|스크린샷|접속|들어가\s*(서|줘|봐)?|다운로드|업로드|설치해|설정\s*(바꿔|해\s*줘|들어가)|가입|회원가입|예약\s*(해|잡아)|티켓\s*(끊|예매)|예매|결제\s*(말고|빼고)?|제출|등록해|커밋|푸시|머지|PR\s*(올려|만들어))/.test(
      t
    )
  ) {
    return true;
  }
  if (/(자세히|꼼꼼히|제대로|여러\s*(출처|사이트|군데))\s*(조사|알아봐|비교)|조사해\s*줘|비교해\s*줘|리서치/.test(t)) return true;
  if (/https?:\/\//i.test(t)) return true;
  if (/\b[\w-]+\.(com|net|org|io|dev|kr|co\.kr|ai|app)\b/i.test(t) && /(열|들어가|접속|확인|봐)/.test(t)) return true;
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
