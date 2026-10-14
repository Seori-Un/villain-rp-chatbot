/**
 * Pull 모드 — 터널 없이 Worker에 붙는다.
 * .env: WORKER_URL=https://villain-rp-chatbot.e5eeeee.workers.dev  BROWSER_API_KEY=... (Worker 시크릿과 동일)
 * 바깥으로 나가는 HTTPS(443)만 되면 동작. cloudflared/ngrok 필요 없음.
 */
import os from "node:os";

export function startPullLoop({ workerUrl, apiKey, pool, log = console.log }) {
  const base = String(workerUrl || "").replace(/\/$/, "");
  if (!base) return null;
  const runnerId = (os.hostname() || "runner").slice(0, 40) + "-" + process.pid;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  let stopped = false;
  let backoff = 1000;
  // watchdog: if the loop makes no progress for 3 min, exit so the supervisor restarts us
  let lastTick = Date.now();
  const touch = () => {
    lastTick = Date.now();
  };
  setInterval(() => {
    if (Date.now() - lastTick > 180000) {
      log("[pull] watchdog: loop stuck >180s — exiting for restart");
      process.exit(1);
    }
  }, 15000).unref();

  async function post(path, body) {
    const res = await fetch(base + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  /** fetch + body read with hard deadline; AbortSignal alone can hang on half-open CF long-polls */
  async function pollNext(waitSec = 20) {
    const ms = 35000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const raced = await Promise.race([
        (async () => {
          const res = await fetch(
            `${base}/runner/next?wait=${waitSec}&runner_id=${encodeURIComponent(runnerId)}`,
            { headers, signal: controller.signal }
          );
          if (res.status === 401) return { status: 401, data: null };
          if (!res.ok) throw new Error("next → HTTP " + res.status);
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data };
        })(),
        new Promise((_, rej) => {
          setTimeout(() => rej(new Error("poll_timeout")), ms);
        }),
      ]);
      return raced;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loop() {
    log(`[pull] connecting to ${base} as ${runnerId} (no tunnel)`);
    try {
      await post("/runner/heartbeat", {
        runner_id: runnerId,
        info: { node: process.version, headless: pool.headless, sessions: pool.size() },
      });
      log("[pull] heartbeat ok — Worker can reach this runner now");
      touch();
    } catch (e) {
      log(`[pull] first heartbeat failed: ${e.message} (will keep trying)`);
      touch();
    }
    while (!stopped) {
      touch();
      try {
        const { status, data } = await pollNext(20);
        touch();
        backoff = 1000;
        if (status === 401) {
          log("[pull] 401 — BROWSER_API_KEY가 Worker 시크릿과 달라. 60초 후 재시도");
          await sleep(60000);
          touch();
          continue;
        }
        const job = data && data.job;
        if (!job) continue; // long-poll timed out, loop again
        const { id, ...payload } = job;
        const t0 = Date.now();
        let result;
        try {
          const JOB_MS = Number(process.env.JOB_TIMEOUT_MS || 60000);
          let jt;
          result = await Promise.race([
            pool.act(payload),
            new Promise((_, rej) => {
              jt = setTimeout(() => rej(new Error(`job_timeout ${JOB_MS}ms`)), JOB_MS);
            }),
          ]).finally(() => clearTimeout(jt));
        } catch (e) {
          result = {
            ok: false,
            error: "runner_error",
            message: String(e && e.message ? e.message : e).slice(0, 300),
          };
        }
        touch();
        log(
          `[pull] ${payload.action} ${
            payload.url || payload.ref != null ? "#" + payload.ref : ""
          } → ${result.ok === false ? "FAIL " + (result.error || "") : "ok"} (${Date.now() - t0}ms)`
        );
        try {
          await post("/runner/result", { id, result });
        } catch (e) {
          log(`[pull] result post failed: ${e.message}`);
        }
        touch();
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        log(`[pull] ${msg} — retry in ${backoff}ms`);
        touch();
        await sleep(backoff);
        touch();
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }
  loop();
  return { stop: () => (stopped = true), runnerId };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
