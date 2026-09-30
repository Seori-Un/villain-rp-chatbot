# Villain RP Chatbot

Kaggle (PDF RAG) + Cloudflare Worker + chat frontend.

## PDF
저장소 루트에 **`this.pdf`** 를 올리세요. (구 `PDF1.pdf`)

## Layout
- `kaggle/` — Kaggle notebook + Hangul PDF filter patch
- `prompts/system_prompt.txt` — villain RP system prompt
- `worker/` — Cloudflare Worker (`POST /chat`)
- `frontend/` — static chat UI (Points at Worker `/chat`)

## Deploy Worker from GitHub only
Cloudflare Dashboard → Workers & Pages → Create → Connect GitHub repo `Seori-Un/villain-rp-chatbot` → root directory `worker` → Deploy.
Secrets: `KAGGLE_API_BASE` (ngrok URL), optional `SYSTEM_PROMPT`.

로컬 `wrangler login` 없이도 Git 연동만으로 배포 가능합니다.

## Kaggle notebook
https://www.kaggle.com/code/seoriun/notebookf32ae7a716/edit


## Frontend
정적 파일: `frontend/index.html`
로컬: 폴더를 열어두거나 Cloudflare Pages로 `frontend` 배포.
기본 API: `https://villain-rp-chatbot.e5eeeee.workers.dev` (`?api=` 로 변경 가능)

## Browser agent (optional, v1 scaffold)

채티 형제 엔드포인트 `POST /browse` — 클릭·타이핑 자동화 스캐폴드.
Workers alone cannot run Playwright; connect a runner via secrets:

- `BROWSER_API_URL` — ngrok/VPS Playwright (`browser-runner/`) or Browserbase gateway
- `BROWSER_API_KEY` — shared bearer token

Without these secrets, **`/chat` still works**; `/browse` returns `browser_not_configured`.

Docs: [`docs/browser-agent.md`](docs/browser-agent.md)

