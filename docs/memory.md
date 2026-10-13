# 장기 기억 (secretary-v1.5-memory)

모든 대화를 Cloudflare **D1**에 저장하고, 날짜·주제로 정리해 두었다가 다음 대화에서 자동으로 꺼내 쓴다.

## 설정 (한 번)
```bash
cd worker
npx wrangler d1 create chaeti-memory            # 출력된 database_id 를 wrangler.toml [[d1_databases]] 에 넣기
npx wrangler d1 migrations apply chaeti-memory --remote
npx wrangler deploy
```
`wrangler.toml`의 `database_id = "REPLACE_WITH_D1_DATABASE_ID"` 를 **반드시 바꿔야** 배포가 된다.
바인딩을 빼면 기억 기능만 꺼지고(503 `memory_disabled`) 나머지는 그대로 동작한다.
야간 정리 cron(`[triggers] crons`)은 KST 04:00.

## 신원 = 기억 코드
로그인이 없으므로 프론트가 `user_id`(기억 코드, `u-…`)를 만들어 localStorage에 둔다. 기억 패널 하단에서 복사해 다른 기기의 「다른 기기 코드 입력」에 붙이면 같은 기억을 쓴다. 코드는 비밀번호 역할이니 공유 금지.

## 흐름
| 단계 | 어디서 | 내용 |
|---|---|---|
| 저장 | `/chat`, `/browse` (서버, `waitUntil`) | 유저·채티 메시지, 대화(`conv_id`) 단위. 6시간 이상 쉬면 새 대화로 쪼개짐. 「새 대화」 버튼도 있음 |
| 회상 | `/chat` 답하기 전 `memory.recall()` | ① 최근 3일 하루 요약 ② "어제/지난주/지난달/N일 전/O월 O일" 등 시간 표현 → 그 기간 요약·대화 목록 ③ FTS(prefix) 검색으로 다른 대화의 원문 발췌 + 바로 뒤 답 ④ 키워드로 맞는 주제 요약 → `【기억】` 블록. 계획 단계가 `memory_query`(핵심어)도 보태줌 |
| 정리 | `POST /memory/digest` (프론트 접속 시·20분마다) + cron | 대화 요약(제목·요약·사실) → 하루 요약(일기+하이라이트) → 주제 분류·주제 요약 갱신. 한 번에 상한이 있어 `pending`이 0 될 때까지 반복 |
| 화면 | `frontend/memory.js` 「기억」 버튼 | 타임라인(날짜별 요약·대화)/주제/검색, 대화 열기·**이어서 대화**·삭제(대화/날짜/주제/전체) |

## API
`GET /memory/stats|timeline|conversation|topics|topic|search` · `POST /memory/append|delete|digest` — 전부 `user_id` 필요.
`/chat` 응답에 `memory: {used, items}` 가 붙고, 프론트는 답 밑에 「기억」 칩(눌러서 그 대화 열기)을 보여준다.

## 한계 / 다음
- FTS는 unicode61 + prefix(`날씨*`)라 어간은 잘 잡지만 동의어는 못 잡음. 임베딩(Vectorize)으로 바꾸면 더 좋아짐.
- 요약·주제는 LLM이 만드니 키가 있어야 하고(Claude→Gemini→Groq), 대화가 20분 이상 잠잠해져야 정리된다.
