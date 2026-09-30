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
정적 파일: `frontend/` (Cloudflare Pages → https://villain-rp-chatbot.pages.dev)
로컬: 폴더를 열어두거나 `npx wrangler pages deploy frontend --project-name=villain-rp-chatbot`
기본 API: `https://villain-rp-chatbot.e5eeeee.workers.dev` (`?api=` 로 변경 가능)
헤더 **「웹 시켜줘」** → Worker `POST /browse` (RP 채팅과 독립)

## Browser agent (v2 — thinking timeline)

`POST /browse` — multi-step web agent with Claude-style **「생각 중」** UI.
Browse LLM: **Claude** (if `ANTHROPIC_API_KEY`) → **Gemini** (`GEMINI_API_KEY`) → Groq fallback.
**`/chat` stays on Groq** for fast RP.

Secrets:

- `BROWSER_API_URL` / `BROWSER_API_KEY` — Playwright runner (trycloudflare / ngrok / VPS)
- `GEMINI_API_KEY` — browse loop (recommended without Anthropic)
- `ANTHROPIC_API_KEY` — optional, for true Claude Sonnet + extended thinking

Without browser secrets, **`/chat` still works**; `/browse` returns `browser_not_configured`.

Docs: [`docs/browser-agent.md`](docs/browser-agent.md)

