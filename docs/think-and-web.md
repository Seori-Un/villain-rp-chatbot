# 추론 단계 + 웹 능력 (secretary-v1.4-think-web)

## /chat: 계획 → (웹) → 답
매 턴 3단계로 돈다 (이벤트 턴 제외):

1. **계획** `worker/src/think.js planTurn` — 짧은 JSON 사고: 유저 의도·놓치면 안 될 맥락·답 방향(2~4줄), `needs_web`, 검색어. Claude→Gemini→Groq 중 있는 것(`llm-text.js`).
2. **웹** (`needs_web`일 때) `worker/src/web/search.js` — 검색어 1~3개 → 결과 병합 → 상위 3페이지 본문 fetch → 시스템 프롬프트에 `【웹 참고】` 번호 출처 블록.
3. **답** — 기존 RP/비서 생성기. Claude면 adaptive extended thinking 켬(`CHAT_THINKING=0`으로 끔).

응답에 새로 오는 필드: `thinking[]`(계획 요약 + 검색 요약 + 모델 내부 생각 앞부분), `sources[]`, `web`, `model`, `plan`.
프론트는 봇 말풍선 위에 접힌 「생각 N단계」와 아래에 출처 칩을 붙인다. 기록에도 저장돼 새로고침 후에도 보인다.

환경변수:
- `CHAT_THINK=0` 계획 단계 끔 · `CHAT_AUTO_WEB=0` 자동 웹 끔 · `CHAT_THINKING=0` Claude extended thinking 끔
- 웹 공급자 (v1.11): **Anthropic 서버 도구** `web_search_20250305` + `web_fetch_20250910` (`worker/src/web/claude-web.js`). 별도 검색 키 없음. 한 번의 Messages 호출 안에서 검색→읽기→조사 메모까지 끝나고, `pause_turn`이면 이어서 보냄. 출처는 `web_search_tool_result`·`web_fetch_tool_result`·text `citations`에서 모아 `sources[]`로. Anthropic 키가 없을 때만 Gemini `google_search` 그라운딩으로 폴백, 둘 다 없으면 "모른다"로. Brave/Tavily/DDG 경로는 제거됨.
- 콘솔에서 조직 단위로 web search가 꺼져 있으면 400이 나니, 그때는 Anthropic Console → Settings에서 켜야 함.

## /browse: 검색 → 읽기 → 비교 → 요약
- `search(query)` = Claude `web_search`, `read(url)` = Claude `web_fetch` (본문을 그대로 받음). `web_fetch`가 못 읽으면(JS 렌더링·robots·로그인 벽) 일반 fetch → 그래도 안 되면 pull-runner 브라우저 `open`+`read`. 실제 클릭·입력·로그인만 러너를 쓴다.
- 시스템 프롬프트에 조사 절차 고정: 검색 1~2회 → 출처 2~4개 read → 일치/불일치 비교 → `done`에 결론·근거[n]·출처 URL.
- 루프가 `done` 없이 끝나면(단계/시간 소진) 읽은 내용으로 **자동 정리**(`synthesizeFromSteps`)해서 답한다.
- 응답 `sources[]` 추가(프론트 출처 칩), `max_steps` 상한 16, 프론트 기본 12, 벽시계 예산 118s.

## 로그인·결제·CAPTCHA 정책
- 로그인: **모든 사이트 허용**, 단 은행·카드·결제·암호화폐 거래소는 로그인/클릭/입력 전부 차단 (`safety.js PAYMENT_HOST`에 국내 은행·카드사 추가). 비밀번호 입력은 호스트당 세션 1회 확인은 그대로.
- CAPTCHA/보안문자/Cloudflare 챌린지: **풀지 않는다.** 감지되면 멈추고 `needs_human:{type:"captcha",url}`로 알림. 러너를 `HEADLESS=false`로 띄워 두면 그 창에서 사람이 풀고, 같은 목표로 다시 시키면 세션(쿠키) 유지된 채 이어서 한다.
