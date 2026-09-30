# Villain RP Chatbot

Kaggle (PDF RAG) + Cloudflare Worker + chat frontend.

## PDF
저장소 루트에 **`this.pdf`** 를 올리세요. (구 `PDF1.pdf`)

## Layout
- `kaggle/` — Kaggle notebook + Hangul PDF filter patch
- `prompts/system_prompt.txt` — villain RP system prompt
- `worker/` — Cloudflare Worker (`POST /chat`)
- `frontend/` — chat UI (TBD)

## Deploy Worker from GitHub only
Cloudflare Dashboard → Workers & Pages → Create → Connect GitHub repo `Seori-Un/villain-rp-chatbot` → root directory `worker` → Deploy.
Secrets: `KAGGLE_API_BASE` (ngrok URL), optional `SYSTEM_PROMPT`.

로컬 `wrangler login` 없이도 Git 연동만으로 배포 가능합니다.

## Kaggle notebook
https://www.kaggle.com/code/seoriun/notebookf32ae7a716/edit
