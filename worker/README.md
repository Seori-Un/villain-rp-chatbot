# Cloudflare Worker

## Deploy (GitHub만)
1. [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create
2. Connect to Git → `Seori-Un/villain-rp-chatbot`
3. Root directory: `worker`
4. Deploy
5. Settings → Variables → Secrets: `KAGGLE_API_BASE`, optional `SYSTEM_PROMPT`

## API
- `GET /health`
- `POST /chat` `{ "message": "...", "history": [] }`

지식 PDF는 저장소 루트 `this.pdf` (Kaggle/RAG 쪽).

## Browser agent (optional)
Secrets (only needed for `/browse`):
- `BROWSER_API_URL`
- `BROWSER_API_KEY`

API:
- `POST /browse` `{ "goal": "example.com 열어서 제목 알려줘" }`
- Chat RP: `POST /chat` (unchanged if browser secrets missing)

See `../docs/browser-agent.md` and `../browser-runner/`.

