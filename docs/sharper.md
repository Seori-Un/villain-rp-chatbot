# 더 똑똑하게: 잘못 들은 말 되살리기 + 웹 손놀림 (chaeti-v1.8-sharper)

## 귀 (`worker/src/hearing.js`)
음성으로 온 말은 답하기 전에 한 번 "다시 듣는다".
1. 프론트가 음성 인식 **대체 후보 4개 + 확신도**를 같이 보냄 (`asr: {alternatives, confidence}`).
2. 워커가 이 사람의 **단어장**을 만든다 — 기억 DB의 주제 키워드, 대화 제목, 유저 메시지에서 2번 이상 나온 단어(이름·장소·게임·프로젝트), 감정 grudge/wish.
3. **자모 단위 발음 거리**로 "비슷하게 들리는 아는 단어"를 찾는다 (ㅐ/ㅔ, 된소리, 받침 혼동은 같은 소리로 취급: 모지→모찌, 발로란→발로란트).
4. 말이 깨진 것 같거나(확신도 <0.6, 단음절 투성이) 후보가 있으면 LLM이 복원. 확실하면 고쳐 쓰고 — 화면 말풍선에 ~~들린 말~~ → 이해한 말, 생각 단계에도 한 줄 — 뜻이 갈리면 고치지 않고 채티가 되묻는다 ("OO라고 한 거야?", 답은 보류).
5. 멀쩡한 문장은 LLM 호출 없이 통과(비용 0). `CHAT_HEARING=0`으로 끔.

## 손 (`browser-runner` + `worker/src/browser/*`)
| 전 | 후 |
|---|---|
| 본문 텍스트만 보고 CSS selector를 추측 | 관찰마다 **번호 붙은 요소 목록**(ref, 역할, 이름, href) → `click(ref)`, `type(ref, text, submit)`. selector 추측 금지 |
| 스크린샷 찍지만 LLM엔 안 보임 | JPEG(품질 55)로 **Claude/Gemini에 실제 화면 전달**(최근 2장 유지). 레이아웃·팝업·에러를 눈으로 판단 |
| open/click/type/scroll | + `press`(Enter/Esc…), `select`, `wait`(selector·텍스트·ms), `find`(페이지 내 텍스트 위치), `back`. 클릭은 가려져 있으면 force 재시도, 다이얼로그 자동 닫기, 로드 settle |
| 100초 지나면 끊김 → 처음부터 | **라운드 이어가기**: 워커가 세션별 진행 기록을 20분 보관, 프론트가 자동으로 최대 4라운드 `continue:true` 호출. 유저 말풍선 없이 "(1/4라운드 · 이어서 계속할게…)" |
| UA가 "ChaetiBrowserRunner" | 일반 데스크톱 Chrome UA + ko-KR 로케일 (봇 차단 덜 걸림) |

프롬프트에 "행동 뒤 결과 확인, 안 바뀌면 접근 변경 / 쿠키·팝업 먼저 닫기 / 같은 행동 2번 반복 시 멈춤" 규칙 추가.

## 배포
worker + frontend + **browser-runner**(sessions.js 바뀜, 재시작) 셋 다. D1 변경 없음.
