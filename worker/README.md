# Cloudflare Worker

## Deploy
```bash
cd worker
npm i
npx wrangler login
npx wrangler deploy
npx wrangler secret put KAGGLE_API_BASE   # ngrok URL
# optional:
npx wrangler secret put SYSTEM_PROMPT
```

## API
- `GET /health`
- `POST /chat` `{ "message": "...", "history": [] }`
