# 브라우저 에이전트 v2 (채티 / 생각 중 타임라인)

채티(또는 sibling agent UI)가 **URL 열기 · 스크린샷 · 클릭 · 타이핑 · 스크롤**을 하고, Claude 스타일 **「생각 중」** 타임라인으로 추론·도구·관찰을 보여 줍니다.

> Cloudflare Workers만으로는 Playwright를 돌릴 수 없습니다. Worker는 **도구 호출 루프 + 안전 검사**만 하고, 실제 브라우저는 `BROWSER_API_URL` 뒤의 러너에 위임합니다.

## 1/n 단계 — 구성 요소

| 구성요소 | 역할 | 경로 |
|---------|------|------|
| Worker `/browse` | 브라우즈 LLM 루프 + 안전 게이트 + thinking steps | `worker/src/browser/` |
| Browse LLM | **Claude**(키 있으면) → **Gemini** → Groq 폴백 | `worker/src/browser/llm.js` |
| RP `/chat` | **Claude** → Gemini → Groq → template | `worker/src/index.js` |
| browser-runner | 로컬/VPS Playwright HTTP 서버 | `browser-runner/` |
| 프론트 「웹 시켜줘」 | 접이식 「생각 중」 타임라인 | `frontend/` |

```
사용자 → POST /browse { goal, confirm?: {...} }
       → Worker agent loop (최대 N step, 기본 12)
            ├─ LLM plan (Claude / Gemini / Groq) + thinking
            ├─ safety.check(action)
            ├─ browserClient.act(action) ──HTTPS──► browser-runner /act
            ├─ observe (+ 주기적 screenshot)
            └─ steps[] = {type: think|tool|observe, content}
       → { steps[], thinking[], reply, llm, model, needs_confirm? }
```

## 2/n 단계 — Secrets / env

Worker (Cloudflare Secrets):

| 이름 | 필수 | 설명 |
|------|------|------|
| `GROQ_API_KEY` | `/chat` 폴백 | 브라우즈·채팅 폴백 (느리거나 불안정할 수 있음) |
| `GEMINI_API_KEY` | 브라우즈 권장 | 브라우즈 루프 기본 (Claude 키 없을 때). 쿼터 429 시 Groq로 자동 폴백 |
| `ANTHROPIC_API_KEY` 또는 `CLAUDE_API_KEY` | `/chat` 권장 · 브라우즈 옵션 | **채팅 1순위 + 브라우즈 Claude Sonnet/thinking**. 없으면 채팅은 Gemini→Groq |
| `BROWSER_API_URL` | 브라우즈만 | 예: `https://xxxx.trycloudflare.com` |
| `BROWSER_API_KEY` | 권장 | 러너 Bearer 토큰 |

```bash
# Claude로 업그레이드하려면:
cd worker
npx wrangler secret put ANTHROPIC_API_KEY
```

**유료 가입을 강제하지 않습니다.** `BROWSER_API_URL`이 없으면 `/browse`는 `browser_not_configured`를 반환하고 `/chat`은 정상 동작합니다.

## 3/n 단계 — steps / thinking UI

각 step:

```json
{ "type": "think", "content": "예제 도메인을 먼저 연다" }
{ "type": "tool", "n": 1, "tool": "open", "args": { "url": "https://example.com" }, "ok": true, "content": "열기 …" }
{ "type": "observe", "content": "제목: Example Domain · URL: …", "observation": { ... } }
```

프론트는 `<details>` **「생각 중」** 안에 타임라인으로 렌더합니다 (생각=이탤릭, 도구=주황, 관찰=초록).

## 4/n 단계 — 도구 스키마

| tool | args | 설명 |
|------|------|------|
| `open` | `url` | 페이지 이동 (+ 스크린샷) |
| `screenshot` | (없음) | 관찰용 PNG + URL/제목/텍스트 |
| `click` | `selector` 또는 `x,y` | 클릭 |
| `type` | `selector`, `text`, `submit?` | 입력 (비밀번호는 confirm) |
| `scroll` | `direction`, `amount?` | 스크롤 |
| `done` | `summary` | 한국어 요약 후 종료 |

루프 개선: 최대 20 step, 도구 오류 1회 재시도, 2액션마다 자동 screenshot 관찰, 한국어 summary.

## 5/n 단계 — 안전 (stubs, 반드시 유지)

구현: `worker/src/browser/safety.js`

1. **결제/은행 차단**
2. **로그인/비밀번호** — `needs_confirm`
3. **자격증명 자동 전송 금지**
4. **CSAM / 범죄 거부**
5. **허용 목록(옵션)** — 스텁

## 6/n 단계 — API

### `POST /browse`

```json
{
  "goal": "example.com 열어서 제목 알려줘",
  "session_id": "optional",
  "max_steps": 12,
  "confirm": { "allow_credentials": false, "allow_login": false }
}
```

응답 예:

```json
{
  "ok": true,
  "reply": "2/12 단계: example.com을 열었고 제목은 Example Domain이야.",
  "llm": "gemini",
  "model": "gemini-2.5-pro",
  "thinking": ["목표를 확인했어…", "예제 페이지를 연다"],
  "steps": [
    { "type": "think", "content": "…" },
    { "type": "tool", "n": 1, "tool": "open", "ok": true, "content": "열기 https://example.com" },
    { "type": "observe", "content": "제목: Example Domain · …", "ok": true }
  ],
  "hint_anthropic": "True Claude… ANTHROPIC_API_KEY …",
  "last_screenshot": "(optional base64)"
}
```

## 상태

| 항목 | 상태 |
|------|------|
| Gemini 브라우즈 + thinking UI | ✅ (ANTHROPIC 없으면) |
| Claude 브라우즈 (키 있을 때) | ✅ 코드 준비 — secret 필요 |
| Claude `/chat` RP | ✅ 1순위 (Gemini→Groq 폴백) |
| browser-runner | ✅ |
| 채티 「생각 중」 타임라인 | ✅ |
