/**
 * 채티 live layer — 얼굴·목소리·눈.
 *  ① 얼굴 표정 모드   : /chat state.emotion + 집착/불안 수치 → SVG 표정, 말할 때 입 움직임
 *  ② 음성 대화        : SpeechRecognition(ko-KR) 듣기 → /chat → speechSynthesis 말하기 → 다시 듣기
 *  ③ 카메라 사람 인식 : getUserMedia + FaceDetector(없으면 픽셀 휴리스틱). 영상은 기기 밖으로 절대 안 나감.
 *                       Worker에는 {camera, present, since, last_seen, away_ms, faces} 숫자/불리언만 전송.
 *  ④ 시간 감각        : 이벤트(face_first/face_return/face_leave/idle_nudge)를 /chat 에 event 로 보내
 *                       채티가 먼저 말 걸게 함. 프롬프트 쪽 처리는 worker/src/time.js.
 *
 * app.js 가 window.Chaeti { runChatTurn, getMode, lastUserMessageAt } 를 노출하고,
 * 여기서는 window.ChaetiLive { payload, onReply, onModeChange } 를 노출한다.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const panel = $("livePanel");
  const faceSvg = $("faceSvg");
  const liveStatus = $("liveStatus");
  const btnFace = $("liveFace");
  const btnVoice = $("liveVoice");
  const btnCam = $("liveCam");
  const video = $("camVideo");
  const canvas = $("camCanvas");
  const caption = $("faceCaption");

  if (!panel || !faceSvg) return;

  /* ---------- 공통 상태 ---------- */
  const st = {
    face: false,
    voice: false,
    cam: false,
    speaking: false,
    listening: false,
    busy: false, // /chat in flight
    emotion: "평온",
    state: null, // last state from worker
  };

  const SPEECH = {
    Rec: window.SpeechRecognition || window.webkitSpeechRecognition || null,
    synth: window.speechSynthesis || null,
  };

  function setStatus(text, cls) {
    if (!liveStatus) return;
    liveStatus.textContent = text || "";
    liveStatus.className = "live-status" + (cls ? " " + cls : "");
  }
  function pressed(btn, on) {
    if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function rpMode() {
    return Boolean(window.Chaeti); // v1.6: single persona, always on
  }
  /** text panel asked for typed input (URL/long text) → keep the mic quiet until it's done */
  let micPaused = false;

  /* =====================================================================
   * ① 얼굴 표정
   * ===================================================================== */
  // emotionLabel() in worker/src/index.js → CSS class on the SVG
  const EMOTION_CLASS = {
    "평온": "calm",
    "기쁨": "joy",
    "행복/유대감": "bonded",
    "스트레스": "stressed",
    "반추": "ruminate",
    "갈망(집착)": "yearning",
    "분리불안": "anxious",
  };

  // Mouth shapes set from JS (Safari can't animate/override SVG `d` from CSS)
  const MOUTH = {
    calm: "M96 140 Q120 148 144 140",
    joy: "M92 136 Q120 162 148 136",
    bonded: "M94 138 Q120 156 146 138",
    stressed: "M98 146 Q120 136 142 146",
    ruminate: "M100 144 Q120 142 140 146",
    yearning: "M100 142 Q120 150 140 140",
    anxious: "M98 148 Q120 134 142 148",
  };

  function applyExpression(state) {
    const emo = (state && state.emotion) || st.emotion || "평온";
    st.emotion = emo;
    const cls = EMOTION_CLASS[emo] || "calm";
    faceSvg.setAttribute("data-emotion", cls);
    const mouth = faceSvg.querySelector(".mouth");
    if (mouth) mouth.setAttribute("d", MOUTH[cls] || MOUTH.calm);
    // continuous knobs → CSS custom properties
    const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : 0);
    const obsession = num(state && state.obsession);
    const stress = num(state && state.stress);
    const attachment = num(state && state.attachment);
    faceSvg.style.setProperty("--pupil", String(0.75 + obsession * 0.55)); // bigger pupils when obsessed
    faceSvg.style.setProperty("--brow", String(stress)); // brow knit
    faceSvg.style.setProperty("--blush", String(attachment * 0.9));
    if (caption) caption.textContent = emo;
  }

  /** Longer-lived feelings (from the server) tint the face under the per-turn expression. */
  function applyFeelings(f) {
    if (!f) return;
    const n = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(v) || 0));
    faceSvg.style.setProperty("--mood", String(n(f.mood, -1, 1)));
    faceSvg.style.setProperty("--hurt", String(n(f.hurt)));
    faceSvg.style.setProperty("--jealousy", String(n(f.jealousy)));
    faceSvg.style.setProperty("--longing", String(n(f.longing)));
    faceSvg.style.setProperty("--energy", String(n(f.energy)));
    faceSvg.classList.toggle("sulking", f.hurt > 0.5 || f.mood < -0.45);
    faceSvg.classList.toggle("glowing", f.mood > 0.5);
    faceSvg.classList.toggle("tired", f.energy < 0.3);
    if (caption && f.label) caption.textContent = f.label;
  }

  function startTalking() {
    faceSvg.classList.add("talking");
  }
  function stopTalking() {
    faceSvg.classList.remove("talking");
  }

  // random blinks
  let blinkTimer = 0;
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      faceSvg.classList.add("blink");
      setTimeout(() => faceSvg.classList.remove("blink"), 140);
      scheduleBlink();
    }, 2200 + Math.random() * 3500);
  }

  // eyes drift toward the user when seen, otherwise wander
  let gazeTimer = 0;
  function scheduleGaze() {
    clearInterval(gazeTimer);
    gazeTimer = setInterval(() => {
      let dx = 0,
        dy = 0;
      if (cam.present && cam.lastBox) {
        // look toward the detected face position (normalized -1..1)
        dx = (cam.lastBox.cx - 0.5) * -2; // mirrored selfie cam
        dy = (cam.lastBox.cy - 0.5) * 2;
      } else {
        dx = (Math.random() - 0.5) * 1.2;
        dy = (Math.random() - 0.5) * 0.6;
      }
      faceSvg.style.setProperty("--gx", (dx * 6).toFixed(1));
      faceSvg.style.setProperty("--gy", (dy * 4).toFixed(1));
    }, 1600);
  }

  function setFace(on) {
    st.face = on;
    pressed(btnFace, on);
    panel.classList.toggle("face-on", on);
    panel.hidden = !(st.face || st.voice || st.cam);
    if (on) {
      applyExpression(st.state);
      scheduleBlink();
      scheduleGaze();
    } else {
      clearTimeout(blinkTimer);
      clearInterval(gazeTimer);
    }
  }

  /* =====================================================================
   * ② 음성 대화 (듣기 → /chat → 말하기 → 듣기)
   * ===================================================================== */
  let rec = null;
  let koVoice = null;
  let restartTimer = 0;

  function pickVoice() {
    if (!SPEECH.synth) return null;
    const voices = SPEECH.synth.getVoices() || [];
    const ko = voices.filter((v) => /^ko/i.test(v.lang));
    // prefer natural/female-ish voices commonly available: Yuna(iOS), Google 한국의, Heami(Win)
    const pref = ko.find((v) => /Yuna|유나|Google|Natural|Premium/i.test(v.name)) || ko[0];
    return pref || null;
  }
  if (SPEECH.synth) {
    koVoice = pickVoice();
    SPEECH.synth.onvoiceschanged = () => {
      koVoice = pickVoice();
    };
  }

  /** strip emoji / stage directions / markdown so TTS reads clean Korean */
  function cleanForSpeech(text) {
    let t = String(text || "");
    // code blocks are never read aloud
    t = t.replace(/```[\s\S]*?```/g, " ");
    // "짧은 말 \n\n 상세(코드·링크·목록)" convention: read only the spoken lead when the tail is text-only content
    const cut = t.indexOf("\n\n");
    if (cut > 0) {
      const tail = t.slice(cut);
      if (/https?:\/\/|^\s*(?:[-*•]|\d+[.)])\s/m.test(tail) || tail.length > 300) t = t.slice(0, cut);
    }
    t = t.replace(/https?:\/\/\S+/g, "링크");
    if (t.length > 600) t = t.slice(0, 600);
    return t
      .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|\*[^*]*\*/g, " ") // (지문) [..] *action*
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
      .replace(/[#*_`>~|]/g, "")
      .replace(/…/g, ", ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!SPEECH.synth) return resolve();
      const clean = cleanForSpeech(text);
      if (!clean) return resolve();
      try {
        SPEECH.synth.cancel();
      } catch {}
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = "ko-KR";
      if (koVoice) u.voice = koVoice;
      u.rate = 1.0;
      u.pitch = 1.05;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        st.speaking = false;
        stopTalking();
        resolve();
      };
      u.onstart = () => {
        st.speaking = true;
        startTalking();
        setStatus("말하는 중…", "speaking");
      };
      u.onend = finish;
      u.onerror = finish;
      // Safari sometimes never fires onend; guard with a length-based timeout
      setTimeout(finish, Math.min(60000, 3000 + clean.length * 180));
      SPEECH.synth.speak(u);
    });
  }

  function stopListening() {
    clearTimeout(restartTimer);
    st.listening = false;
    if (rec) {
      try {
        rec.onend = null;
        rec.stop();
      } catch {}
      rec = null;
    }
  }

  function listenOnce() {
    if (!st.voice || st.speaking || st.busy || micPaused || !SPEECH.Rec) return;
    stopListening();
    const r = new SPEECH.Rec();
    rec = r;
    r.lang = "ko-KR";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 4;
    let finalText = "";
    /** @type {Array<{text:string, confidence:number}>} alternatives of the final result (best first) */
    let alts = [];
    let confidence = 0;
    r.onstart = () => {
      st.listening = true;
      setStatus("듣는 중… (말해 봐)", "listening");
    };
    r.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const t = res[0].transcript;
        if (res.isFinal) {
          finalText += t;
          confidence = Number(res[0].confidence) || 0;
          alts = [];
          for (let k = 0; k < res.length && k < 4; k++) {
            const a = String(res[k].transcript || "").trim();
            if (a && !alts.some((x) => x.text === a)) alts.push({ text: a, confidence: Number(res[k].confidence) || 0 });
          }
        } else interim += t;
      }
      if (interim) setStatus("듣는 중… " + interim.slice(-40), "listening");
    };
    r.onerror = (ev) => {
      // no-speech / aborted are routine; permission errors are not
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setStatus("마이크 권한이 없어. 브라우저 설정에서 허용해 줘.", "err");
        setVoice(false);
      }
    };
    r.onend = async () => {
      st.listening = false;
      rec = null;
      const text = finalText.trim();
      if (!st.voice) return;
      if (text) {
        await handleVoiceUtterance(text, { alternatives: alts.slice(1).map((a) => a.text), confidence });
      }
      if (st.voice) restartTimer = setTimeout(listenOnce, 350);
    };
    try {
      r.start();
    } catch (e) {
      // InvalidStateError when a previous instance is still shutting down
      restartTimer = setTimeout(listenOnce, 600);
    }
  }

  async function handleVoiceUtterance(text, asr = null) {
    if (!window.Chaeti) return;
    st.busy = true;
    setStatus("생각 중…", "busy");
    try {
      const reply = await window.Chaeti.runChatTurn(text, { voice: true, asr });
      if (reply) await speak(reply);
    } finally {
      st.busy = false;
      if (st.voice) setStatus("듣는 중…", "listening");
    }
  }

  function setVoice(on) {
    if (on && !SPEECH.Rec) {
      setStatus("이 브라우저는 음성 인식을 지원하지 않아 (Chrome/Safari 최신 버전 권장).", "err");
      on = false;
    }
    st.voice = on;
    pressed(btnVoice, on);
    panel.hidden = !(st.face || st.voice || st.cam);
    if (on) {
      // iOS needs a user-gesture-primed utterance before later speak() calls work
      if (SPEECH.synth) {
        try {
          const warm = new SpeechSynthesisUtterance("");
          warm.lang = "ko-KR";
          SPEECH.synth.speak(warm);
        } catch {}
      }
      listenOnce();
    } else {
      stopListening();
      if (SPEECH.synth) {
        try {
          SPEECH.synth.cancel();
        } catch {}
      }
      st.speaking = false;
      stopTalking();
      setStatus("");
    }
  }

  /* =====================================================================
   * ③ 카메라 사람 인식 (기기 내부에서만 처리)
   * ===================================================================== */
  const cam = {
    stream: null,
    timer: 0,
    detector: null, // window.FaceDetector when available
    present: false,
    since: 0,
    lastSeen: 0,
    awayAt: 0,
    faces: 0,
    lastBox: null,
    hits: 0,
    misses: 0,
    everSeen: false,
    prevFrame: null,
    mode: "none", // "facedetector" | "heuristic"
  };
  const CAM_INTERVAL_MS = 700;
  const PRESENT_AFTER = 2; // consecutive hits
  const ABSENT_AFTER_MS = 8000; // no face for this long → absent
  const RETURN_MIN_AWAY_MS = 20000; // away at least this long → face_return event

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("이 브라우저는 카메라를 지원하지 않아.", "err");
      return false;
    }
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
    } catch (e) {
      setStatus("카메라 권한이 없어. 브라우저 설정에서 허용해 줘.", "err");
      return false;
    }
    video.srcObject = cam.stream;
    video.muted = true;
    video.playsInline = true;
    try {
      await video.play();
    } catch {}
    if ("FaceDetector" in window) {
      try {
        cam.detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
        cam.mode = "facedetector";
      } catch {
        cam.detector = null;
      }
    }
    if (!cam.detector) cam.mode = "heuristic";
    cam.timer = setInterval(tick, CAM_INTERVAL_MS);
    return true;
  }

  function stopCamera() {
    clearInterval(cam.timer);
    cam.timer = 0;
    if (cam.stream) {
      for (const t of cam.stream.getTracks()) t.stop();
      cam.stream = null;
    }
    video.srcObject = null;
    cam.present = false;
    cam.faces = 0;
    cam.lastBox = null;
    cam.prevFrame = null;
    cam.hits = cam.misses = 0;
  }

  /** returns {faces:number, box:{cx,cy}|null} — never leaves the device */
  async function detect() {
    const w = (canvas.width = 160);
    const h = (canvas.height = 120);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!video.videoWidth) return { faces: 0, box: null };
    ctx.drawImage(video, 0, 0, w, h);

    if (cam.detector) {
      try {
        const faces = await cam.detector.detect(canvas);
        if (faces.length) {
          const b = faces[0].boundingBox;
          return { faces: faces.length, box: { cx: (b.x + b.width / 2) / w, cy: (b.y + b.height / 2) / h } };
        }
        return { faces: 0, box: null };
      } catch {
        // fall through to heuristic if detector throws (unsupported source etc.)
        cam.detector = null;
        cam.mode = "heuristic";
      }
    }

    // Heuristic fallback: skin-tone blob in the frame + motion vs previous frame.
    // Rough, but runs everywhere (iPad Safari has no FaceDetector).
    const img = ctx.getImageData(0, 0, w, h).data;
    let skin = 0,
      sx = 0,
      sy = 0,
      motion = 0;
    const prev = cam.prevFrame;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const r = img[i],
          g = img[i + 1],
          b = img[i + 2];
        // YCbCr skin range
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (cr > 135 && cr < 175 && cb > 80 && cb < 125 && r > 60) {
          skin++;
          sx += x;
          sy += y;
        }
        if (prev) {
          const l = (r + g + b) / 3;
          const pl = (prev[i] + prev[i + 1] + prev[i + 2]) / 3;
          if (Math.abs(l - pl) > 28) motion++;
        }
      }
    }
    cam.prevFrame = img;
    const samples = (w / 2) * (h / 2);
    const skinRatio = skin / samples;
    const motionRatio = motion / samples;
    // a face at tablet distance covers roughly 4–40% of the frame as skin
    const hit = skinRatio > 0.04 && skinRatio < 0.5 && (motionRatio > 0.002 || cam.present);
    return hit ? { faces: 1, box: { cx: sx / skin / w, cy: sy / skin / h } } : { faces: 0, box: null };
  }

  async function tick() {
    if (!cam.stream || document.hidden) return;
    let res;
    try {
      res = await detect();
    } catch {
      return;
    }
    const now = Date.now();
    cam.faces = res.faces;
    if (res.faces > 0) {
      cam.hits++;
      cam.misses = 0;
      cam.lastSeen = now;
      cam.lastBox = res.box;
      if (!cam.present && cam.hits >= PRESENT_AFTER) onPresent(now);
    } else {
      cam.hits = 0;
      cam.misses++;
      if (cam.present && now - cam.lastSeen > ABSENT_AFTER_MS) onAbsent(now);
    }
    renderCamStatus();
  }

  function renderCamStatus() {
    if (!st.cam) return;
    const modeTag = cam.mode === "facedetector" ? "얼굴인식" : "근사 감지";
    if (cam.present) {
      setStatus(`카메라: 보고 있어 · ${modeTag}${cam.faces > 1 ? ` · ${cam.faces}명?` : ""}`, "present");
    } else {
      setStatus(`카메라: 안 보여 · ${modeTag}`, "absent");
    }
    panel.classList.toggle("user-present", cam.present);
  }

  function onPresent(now) {
    cam.present = true;
    cam.since = now;
    const awayMs = cam.awayAt ? now - cam.awayAt : 0;
    if (!cam.everSeen) {
      cam.everSeen = true;
      fireEvent("face_first", { away_ms: 0 });
    } else if (awayMs >= RETURN_MIN_AWAY_MS) {
      fireEvent("face_return", { away_ms: awayMs });
    }
    cam.awayAt = 0;
  }

  function onAbsent(now) {
    cam.present = false;
    cam.awayAt = cam.lastSeen || now;
    // sulking → lets you go without a word; lonely/attached → almost always says something
    if (Math.random() < LEAVE_CHANCE) fireEvent("face_leave", {});
  }

  async function setCam(on) {
    if (on) {
      const ok = await startCamera();
      if (!ok) on = false;
    } else {
      stopCamera();
      panel.classList.remove("user-present");
    }
    st.cam = on;
    pressed(btnCam, on);
    panel.hidden = !(st.face || st.voice || st.cam);
    if (on) renderCamStatus();
    else if (!st.voice) setStatus("");
  }

  function presencePayload() {
    if (!st.cam) return null;
    const now = Date.now();
    return {
      camera: true,
      present: cam.present,
      since: cam.present ? cam.since : 0,
      last_seen: cam.lastSeen || 0,
      away_ms: cam.present ? 0 : cam.awayAt ? now - cam.awayAt : 0,
      faces: cam.faces,
    };
  }

  /* =====================================================================
   * ④ 이벤트 → 채티가 먼저 말 걸기 (시간 감각 + 존재 감각)
   * ===================================================================== */
  let lastProactiveAt = 0;
  const PROACTIVE_MIN_GAP_MS = 60 * 1000;
  // how soon 채티 speaks first depends on how she feels right now (server sends `proactive` with every reply)
  let IDLE_NUDGE_AFTER_MS = 12 * 60 * 1000;
  let IDLE_NUDGE_MIN_GAP_MS = 30 * 60 * 1000;
  let LEAVE_CHANCE = 0.6;
  function applyProactive(p) {
    if (!p || typeof p !== "object") return;
    if (p.idle_nudge_min) IDLE_NUDGE_AFTER_MS = Math.max(2, Number(p.idle_nudge_min)) * 60 * 1000;
    if (p.idle_repeat_min) IDLE_NUDGE_MIN_GAP_MS = Math.max(5, Number(p.idle_repeat_min)) * 60 * 1000;
    if (p.leave_chance != null) LEAVE_CHANCE = Math.max(0, Math.min(1, Number(p.leave_chance)));
  }
  let lastIdleNudgeAt = 0;
  let eventQueue = Promise.resolve();

  function fireEvent(name, extra) {
    if (!rpMode() || !window.Chaeti) return;
    const now = Date.now();
    // face_first always goes through; the rest are rate-limited so 채티 doesn't spam
    if (name !== "face_first" && now - lastProactiveAt < PROACTIVE_MIN_GAP_MS) return;
    if (st.busy || st.speaking) return;
    lastProactiveAt = now;
    eventQueue = eventQueue.then(async () => {
      st.busy = true;
      stopListening();
      try {
        const presence = presencePayload();
        if (presence && extra && extra.away_ms) presence.away_ms = extra.away_ms;
        const reply = await window.Chaeti.runChatTurn("", { event: name, voice: st.voice, presence });
        if (reply && st.voice) await speak(reply);
      } finally {
        st.busy = false;
        if (st.voice) restartTimer = setTimeout(listenOnce, 350);
      }
    });
  }

  setInterval(() => {
    if (!rpMode() || !(st.face || st.voice || st.cam)) return;
    if (st.cam && !cam.present) return; // nobody there — don't talk to an empty room
    const now = Date.now();
    const lastUser = window.Chaeti ? window.Chaeti.lastUserMessageAt() : 0;
    const quietFor = now - Math.max(lastUser, lastProactiveAt);
    if (quietFor >= IDLE_NUDGE_AFTER_MS && now - lastIdleNudgeAt >= IDLE_NUDGE_MIN_GAP_MS) {
      lastIdleNudgeAt = now;
      fireEvent("idle_nudge", {});
    }
  }, 30 * 1000);

  /* ---------- hooks used by app.js ---------- */
  window.ChaetiLive = {
    /** extra fields merged into every /chat body */
    payload() {
      const p = presencePayload();
      return {
        voice: st.voice,
        presence: p || undefined,
        live: { face: st.face, voice: st.voice, cam: st.cam, cam_mode: st.cam ? cam.mode : "none" },
      };
    },
    /** called after every /chat reply (typed or spoken) */
    onReply(reply, state, ok, extras) {
      if (state) {
        st.state = state;
        if (st.face) applyExpression(state);
      }
      if (extras && extras.feelings) applyFeelings(extras.feelings);
      if (extras && extras.proactive) applyProactive(extras.proactive);
      // typed message while voice mode is on → still read it aloud
      if (ok && st.voice && !st.busy && reply) {
        st.busy = true;
        stopListening();
        speak(reply).finally(() => {
          st.busy = false;
          if (st.voice) restartTimer = setTimeout(listenOnce, 350);
        });
      }
    },
    onModeChange() {
      panel.classList.add("rp");
      for (const b of [btnFace, btnVoice, btnCam]) if (b) b.hidden = false;
    },
    isVoiceOn: () => st.voice,
    /** app.js: text panel opened/closed; needInput pauses listening so typing isn't transcribed over */
    onTextPanel(open, needInput) {
      const pause = Boolean(open && needInput);
      if (pause === micPaused) return;
      micPaused = pause;
      if (pause) {
        stopListening();
        if (st.voice) setStatus("입력창에 붙여 넣는 동안 마이크는 잠깐 쉴게", "busy");
      } else if (st.voice && !st.busy) {
        restartTimer = setTimeout(listenOnce, 300);
      }
    },
    /** start overlay → face + voice with the user gesture the browser needs */
    startDefault(withVoice) {
      setFace(true);
      if (withVoice) setVoice(true);
      else if (window.Chaeti) window.Chaeti.openText({ focus: true });
      if (!withVoice || !st.voice) {
        // voice unavailable / declined → text is the way in
        if (window.Chaeti) window.Chaeti.openText({ focus: true });
      }
    },
  };

  /* ---------- start overlay (face + voice is the default screen) ---------- */
  const overlay = $("startOverlay");
  const startBtn = $("startBtn");
  const startText = $("startText");
  if (overlay) {
    if (!SPEECH.Rec) {
      const small = startBtn && startBtn.querySelector("small");
      if (small) small.textContent = "이 브라우저는 음성 인식이 안 돼서 얼굴 + 글로 시작해";
    }
    const go = (withVoice) => {
      overlay.classList.add("gone");
      setTimeout(() => overlay.remove(), 400);
      window.ChaetiLive.startDefault(withVoice);
    };
    if (startBtn) startBtn.addEventListener("click", () => go(Boolean(SPEECH.Rec)));
    if (startText) startText.addEventListener("click", () => go(false));
  }

  /* ---------- buttons ---------- */
  if (btnFace) btnFace.addEventListener("click", () => setFace(!st.face));
  if (btnVoice)
    btnVoice.addEventListener("click", () => {
      setVoice(!st.voice);
      // voice off → the text panel is the only way to talk
      if (!st.voice && window.Chaeti) window.Chaeti.openText({ focus: true });
    });
  if (btnCam) btnCam.addEventListener("click", () => setCam(!st.cam));

  // pause mic/TTS when the tab goes to background (tablet lock, app switch)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopListening();
      if (SPEECH.synth) {
        try {
          SPEECH.synth.cancel();
        } catch {}
      }
      st.speaking = false;
      stopTalking();
    } else if (st.voice && !st.busy) {
      restartTimer = setTimeout(listenOnce, 500);
    }
  });

  window.ChaetiLive.onModeChange(window.Chaeti ? window.Chaeti.getMode() : "secretary");
})();
