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
