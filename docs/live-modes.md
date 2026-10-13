# 라이브 모드 (얼굴 · 음성 · 카메라 · 시간 감각)

RP 모드(채티)에서만 켜지는 기능. 파일: `frontend/live.js`, 프롬프트 쪽은 `worker/src/time.js`.

| 버튼 | 하는 일 | 브라우저 요구 |
|---|---|---|
| 얼굴 | `/chat` 응답의 `state.emotion`(평온/기쁨/행복·유대감/스트레스/반추/갈망/분리불안) + 집착·불안·애착 수치로 SVG 표정 변화. TTS 중 입 움직임, 깜빡임, 카메라에 사람이 보이면 그쪽으로 시선 | 전부 |
| 음성 | `SpeechRecognition(ko-KR)` 듣기 → `/chat`(`voice:true`) → `speechSynthesis` 말하기 → 다시 듣기 반복. 타이핑해도 음성 켜져 있으면 읽어 줌 | Chrome(Android/데스크톱), Safari 14.1+ (iPad). 마이크 권한 필요, HTTPS |
| 카메라 | 전면 카메라 프레임을 **기기 안에서만** 분석. `FaceDetector` API가 있으면 그걸로(Android Chrome), 없으면(iPad Safari) 피부톤+움직임 근사. Worker로는 `{camera, present, since, last_seen, away_ms, faces}` 숫자만 간다. 영상·사진은 절대 전송/저장 안 함 | `getUserMedia` 가능 브라우저, HTTPS |

## 채티가 먼저 말 거는 이벤트 (`/chat` body의 `event`)

- `face_first` — 카메라 켜고 처음 사람을 봤을 때
- `face_return` — 20초 이상 자리 비웠다가 다시 보일 때 (`presence.away_ms` 포함)
- `face_leave` — 8초 이상 안 보일 때
- `idle_nudge` — 라이브 모드 켠 상태로 12분 이상 조용할 때 (30분에 1번 상한, 카메라 켜져 있고 사람 없으면 안 함)

이벤트 턴은 유저 말풍선 없이 채티 답만 붙고, 워커에서 `event:"presence"`로 처리해서 집착 수치에 "무시당함" 페널티를 주지 않으며 `lastMessageAt`(간격 시계)도 건드리지 않는다. 1분 안에 두 번 안 보냄(`face_first` 제외).

## `/chat` 에 새로 가는 필드

```json
{
  "session_started_at": 1760000000000,
  "voice": true,
  "event": "face_return",
  "presence": { "camera": true, "present": true, "since": 0, "last_seen": 0, "away_ms": 0, "faces": 1 },
  "live": { "face": true, "voice": true, "cam": true, "cam_mode": "heuristic" }
}
```

`time.js`가 이걸 받아 시스템 프롬프트에 세션 길이·카메라 상태·음성 모드(짧게, 지문 없이)·이벤트 지시를 넣는다.

## 아직 안 한 것
- 이동(로봇 베이스), 블루투스
- 카메라 근사 감지는 조명에 민감함. 정확도 필요하면 나중에 작은 온디바이스 모델(예: MediaPipe Face Detection WASM)로 교체 — 네트워크 없이 로컬 번들만 추가하면 됨.
