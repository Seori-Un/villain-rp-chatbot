# 브라우저 에이전트 v1 (채티 / 형제 UI)

채티(또는 sibling agent UI)가 **URL 열기 · 스크린샷 · 클릭 · 타이핑 · 스크롤**을 하고, 한 일을 보고하는 실용 스캐폴드입니다.

> Cloudflare Workers만으로는 Playwright를 돌릴 수 없습니다. Worker는 **도구 호출 루프 + 안전 검사**만 하고, 실제 브라우저는 `BROWSER_API_URL` 뒤의 러너에 위임합니다.

## 1/n 단계 — 구성 요소

| 구성요소 | 역할 | 경로 |
|---------|------|------|
| Worker `/browse` | Groq 도구 호출(또는 ReAct JSON) 루프, 안전 게이트 | `worker/src/browser/` |
| Browser client | `BROWSER_API_URL`로 HTTPS 액션 전달 | `worker/src/browser/client.js` |
| browser-runner | 로컬/VPS Playwright HTTP 서버 | `browser-runner/` |
| (옵션) Browserbase 등 | 클라우드 브라우저; 같은 클라이언트 계약 | env만 바꾸면 됨 |
| 채팅 `/chat` | **변경 없음** — 브라우저 secret 없어도 RP 그대로 | `worker/src/index.js` |

```
사용자 → POST /browse { goal, confirm?: {...} }
       → Worker agent loop (최대 N step)
            ├─ safety.check(action)
            ├─ browserClient.act(action) ──HTTPS──► browser-runner /act
            └─ 관찰(screenshot/url/text) → 다음 LLM 턴
       → { steps[], reply, needs_confirm? }
```

## 2/n 단계 — Secrets / env

Worker (Cloudflare Secrets 또는 `.dev.vars`):

| 이름 | 필수 | 설명 |
|------|------|------|
| `GROQ_API_KEY` | 채팅/브라우즈 LLM | 기존과 동일 |
| `BROWSER_API_URL` | 브라우즈만 | 예: `https://xxxx.ngrok-free.app` 또는 Browserbase gateway |
| `BROWSER_API_KEY` | 권장 | 러너 인증 헤더 `Authorization: Bearer …` |

browser-runner (로컬 `.env`):

| 이름 | 기본 | 설명 |
|------|------|------|
| `PORT` | `8788` | HTTP 포트 |
| `BROWSER_API_KEY` | (비움=개발용 열림) | Worker와 동일 키 |
| `HEADLESS` | `true` | `false`면 창 표시 |

**유료 가입을 강제하지 않습니다.** `BROWSER_API_URL`이 없으면 `/browse`는 `browser_not_configured`를 반환하고 `/chat`은 정상 동작합니다.

## 3/n 단계 — 도구 스키마

| tool | args | 설명 |
|------|------|------|
| `open` | `url` | 페이지 이동 |
| `screenshot` | (없음) | 관찰용 PNG(base64 요약) + 현재 URL |
| `click` | `selector` 또는 `x,y` | 클릭 |
| `type` | `selector`, `text`, `submit?` | 입력 (비밀번호 필드는 confirm 필요) |
| `scroll` | `direction`, `amount?` | 스크롤 |
| `done` | `summary` | 작업 종료 |

## 4/n 단계 — 안전 (stubs, 반드시 유지)

구현: `worker/src/browser/safety.js`

1. **결제/은행 차단** — 도메인·경로 휴리스틱 (bank, paypal, checkout, 카드 결제 등)
2. **로그인/비밀번호** — password 필드·login URL 감지 시 `needs_confirm` 반환, 사용자 확인 전 입력 금지
3. **자격증명 자동 전송 금지** — 채팅에 적힌 비밀번호를 `type`으로 넣지 않음. `confirm.allow_credentials === true` + 이번 턴에만 허용
4. **CSAM / 범죄 거부** — goal·URL 키워드 하드 거부
5. **허용 목록(옵션)** — 추후 `BROWSER_ALLOWLIST`로 호스트 제한 가능 (스텁)

안전 거절 시 한국어로 이유를 알려 줍니다 (`n/n 단계` 톤).

## 5/n 단계 — 이 유저에게 가장 빠른 실클릭 경로

추천 순서:

### A) 로컬 Playwright + ngrok (이미 사용 경험 있음) — **가장 빠름·무료**

```bash
cd browser-runner
npm install
npx playwright install chromium
cp .env.example .env   # BROWSER_API_KEY 설정
npm start              # :8788

# 다른 터미널
ngrok http 8788
```

Worker secret:

```bash
cd worker
npx wrangler secret put BROWSER_API_URL   # ngrok https URL
npx wrangler secret put BROWSER_API_KEY   # runner와 동일
```

### B) Browserbase / Browserless 무료 트라이얼

1. 가입 후 API URL + key 발급  
2. Worker에 `BROWSER_API_URL` / `BROWSER_API_KEY`만 설정  
3. (선택) `browser-runner`를 건너뛰고, cloud가 같은 `/act` 계약을 구현하거나 얇은 어댑터 추가

### C) 싸구려 VPS에 runner 상시 가동

로컬과 동일하나 ngrok 대신 고정 HTTPS.

## 6/n 단계 — API

### `POST /browse`

```json
{
  "goal": "example.com 열어서 제목 알려줘",
  "session_id": "optional",
  "max_steps": 8,
  "confirm": {
    "allow_credentials": false,
    "allow_login": false,
    "approved_action_id": null
  }
}
```

응답 예:

```json
{
  "ok": true,
  "reply": "2/2 단계: example.com을 열었고 제목은 Example Domain 이야.",
  "steps": [
    { "n": 1, "tool": "open", "args": { "url": "https://example.com" }, "ok": true },
    { "n": 2, "tool": "done", "args": { "summary": "..." }, "ok": true }
  ],
  "needs_confirm": null,
  "browser": "configured"
}
```

미설정:

```json
{ "ok": false, "error": "browser_not_configured", "hint": "BROWSER_API_URL secret + browser-runner 또는 Browserbase" }
```

### Runner `POST /act`

```json
{ "action": "open", "url": "https://example.com", "session_id": "s1" }
```

→ `{ "ok": true, "url": "...", "title": "...", "text": "...", "screenshot_b64": "..." }`

## 7/n 단계 — 채티와의 관계

- **v1**: `/browse`는 RP `/chat`과 **분리**. 형제 UI 또는 `?mode=browse`로 호출.
- 집착 RP 페르소나는 브라우저 자동화에 섞지 않음 (안전·의도 혼선 방지).
- 나중에 채티가 “대신 열어줘”라고 하면 intent → `/browse` 위임 가능 (미구현).

## 상태

| 항목 | 상태 |
|------|------|
| 문서 + 도구 스키마 + 안전 stub | ✅ |
| Worker `/browse` 루프 | ✅ (env 없으면 graceful fail) |
| browser-runner Playwright | ✅ skeleton |
| 실클릭 | ❌ `BROWSER_API_URL` + runner/cloud 필요 |
| 채팅 회귀 | ✅ `/chat` 독립 |
