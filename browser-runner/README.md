# browser-runner (Playwright)

채티 Worker `/browse`가 호출하는 **로컬/VPS 브라우저 러너** v1 스켈레톤.

## 1/2 단계 — 설치

```bash
cd browser-runner
npm install
npx playwright install chromium
cp .env.example .env   # BROWSER_API_KEY 설정
npm start              # http://0.0.0.0:8788
```

## 2/2 단계 — Worker에 연결

```bash
# ngrok (이미 써 본 경로)
ngrok http 8788

cd ../worker
npx wrangler secret put BROWSER_API_URL   # https://xxxx.ngrok-free.app
npx wrangler secret put BROWSER_API_KEY   # .env 와 동일
```

헬스: `GET /health`  
액션: `POST /act` `{ "action":"open","url":"https://example.com","session_id":"s1" }`

지원 action: `open` | `screenshot` | `click` | `type` | `scroll` | `read`(본문 전체+링크, 스크린샷 없음) | `wait` | `close`

CAPTCHA가 뜨면 Worker가 멈추고 사람이 풀어야 합니다. `HEADLESS=false`로 띄워 두면 그 창에서 바로 풀 수 있고, 세션(쿠키)은 유지됩니다.

클라우드(Browserbase 등)를 쓰면 이 패키지 대신 그쪽 URL을 `BROWSER_API_URL`에 넣으면 됩니다 (계약이 다르면 얇은 어댑터 추가).
