# Villain RP Chatbot (채티)

Kaggle (PDF RAG) + Cloudflare Worker + chat frontend.

## PDF
저장소 루트에 **`this.pdf`** 를 올리세요. (구 `PDF1.pdf`)

## Layout
- `kaggle/` — Kaggle notebook + Hangul PDF filter patch
- `prompts/system_prompt.txt` — villain RP system prompt
- `worker/` — Cloudflare Worker (`POST /agent`, `/chat`, `/browse`)
- `frontend/` — static chat UI (비서 기본 · 단일 입력 자동 라우팅)

## Deploy Worker from GitHub only
Cloudflare Dashboard → Workers & Pages → Create → Connect GitHub repo `Seori-Un/villain-rp-chatbot` → root directory `worker` → Deploy.
Secrets: `KAGGLE_API_BASE` (ngrok URL), optional `SYSTEM_PROMPT`.

로컬 `wrangler login` 없이도 Git 연동만으로 배포 가능합니다.

## Kaggle notebook
https://www.kaggle.com/code/seoriun/notebookf32ae7a716/edit

## Frontend (비서 v1)
정적 파일: `frontend/` (Cloudflare Pages → https://villain-rp-chatbot.pages.dev)
로컬: `npx wrangler pages deploy frontend --project-name=villain-rp-chatbot`
기본 API: `https://villain-rp-chatbot.e5eeeee.workers.dev` (`?api=` 로 변경 가능)

**기본 UX:** 채팅창에 그냥 입력 → 작업처럼 보이면 자동으로 `/browse`, 아니면 `/chat`.
「웹 시켜줘」 버튼을 따로 누를 필요 없음. 헤더의 「비서」/「채티(RP)」는 보조 전환(기본=비서).

강제 웹: 메시지 앞에 `/웹 ` 접두사.

### 로컬 저장 (localStorage `chaeti_v3`)
- 대화 메시지, 마지막 browse step 요약, `session_id`, RP `snapshot`, 모드
- **비밀번호·쿠키·브라우저 탭 상태는 저장하지 않음** (러너/Worker 메모리만)
- 용량·민감정보 한도: [`docs/browser-agent.md`](docs/browser-agent.md) 「Persist」 절

## API
| 경로 | 설명 |
|------|------|
| `POST /agent` | 통합: task-like → browse, else chat |
| `POST /chat` | RP 채팅 (그대로 유지) |
| `POST /browse` | 브라우저 에이전트 |
| `GET /health` | 상태 |

## Browser agent
Browse LLM: **Claude** → **Gemini** → Groq.
`/chat` primary: **Claude** → Gemini → Groq → template.

Secrets: `BROWSER_API_URL` / `BROWSER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …

Docs: [`docs/browser-agent.md`](docs/browser-agent.md)
