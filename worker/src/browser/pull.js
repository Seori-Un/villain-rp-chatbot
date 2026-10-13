/**
 * Pull 모드 — 러너가 터널 없이 Worker로 일감을 받으러 온다.
 *
 *   Worker  : browserActPull(env, payload) → D1 runner_jobs에 넣고 결과를 기다림
 *   Runner  : GET  /runner/next   (long-poll, Bearer BROWSER_API_KEY) → 일감 1개
 *             POST /runner/result {id, result}
 *             POST /runner/heartbeat {runner_id, info}
 *
 * 켜는 법: Worker에 BROWSER_API_URL 대신 BROWSER_MODE=pull (vars) + D1(DB) 바인딩.
 *          러너 .env 에 WORKER_URL=https://villain-rp-chatbot.e5eeeee.workers.dev
 * 바깥으로 나가는 443만 열려 있으면 동작한다 (cloudflared 7844 / ngrok 인증이 막힌 망에서).
 */

const JOB_TIMEOUT_MS = 55000;
const POLL_MS = 600;
const RUNNER_STALE_MS = 45000;

export function isPullMode(env) {
  return String(env.BROWSER_MODE || "").toLowerCase() === "pull" && env.DB && typeof env.DB.prepare === "function";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runnerLastSeen(env) {
  try {
    const row = await env.DB.prepare(`SELECT runner_id, last_seen, info FROM runner_presence ORDER BY last_seen DESC LIMIT 1`).first();
    return row || null;
  } catch {
    return null;
  }
}

export async function runnerOnline(env) {
  const r = await runnerLastSeen(env);
  return Boolean(r && Date.now() - r.last_seen < RUNNER_STALE_MS);
}

/** Same contract as browserAct(): resolves to the runner's JSON observation. */
export async function browserActPull(env, payload) {
  if (!(await runnerOnline(env))) {
    return {
      ok: false,
      error: "runner_offline",
      message: "러너가 Worker에 접속해 있지 않아. 러너 PC에서 `npm start`(WORKER_URL 설정)가 돌고 있는지 봐 줘. (터널 불필요)",
    };
  }
  const id = crypto.randomUUID();
  const body = { action: payload.action, session_id: payload.session_id || "default", ...(payload.args || {}) };
  await env.DB.prepare(`INSERT INTO runner_jobs (id, status, payload, created_at) VALUES (?1, 'pending', ?2, ?3)`)
    .bind(id, JSON.stringify(body), Date.now())
    .run();
  const t0 = Date.now();
  while (Date.now() - t0 < JOB_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const row = await env.DB.prepare(`SELECT status, result FROM runner_jobs WHERE id = ?1`).bind(id).first();
    if (!row) break;
    if (row.status === "done" || row.status === "failed") {
      env.DB.prepare(`DELETE FROM runner_jobs WHERE id = ?1`).bind(id).run().catch(() => {});
      let data = {};
      try {
        data = JSON.parse(row.result || "{}");
      } catch {
        data = { ok: false, error: "runner_non_json" };
      }
      if (row.status === "failed" && data.ok !== false) data = { ok: false, error: "runner_error", ...data };
      return data.ok === false ? data : { ok: true, ...data };
    }
  }
  env.DB.prepare(`UPDATE runner_jobs SET status = 'failed', result = '{"ok":false,"error":"browser_timeout"}' WHERE id = ?1 AND status != 'done'`).bind(id).run().catch(() => {});
  return { ok: false, error: "browser_timeout", message: "러너 응답 시간 초과 (pull 모드)" };
}

function authed(request, env) {
  const key = String(env.BROWSER_API_KEY || "").trim();
  if (!key) return true;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${key}` || h === key;
}

/** Routes under /runner/* used by the runner process. Returns a Response or null. */
export async function handleRunnerRoute(request, env, url, json) {
  if (!url.pathname.startsWith("/runner/")) return null;
  if (!env.DB) return json({ ok: false, error: "no_db" }, 503);
  if (!authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const path = url.pathname.slice("/runner/".length);

  if (path === "heartbeat" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const rid = String(b.runner_id || "runner").slice(0, 64);
    await env.DB.prepare(
      `INSERT INTO runner_presence (runner_id, last_seen, info) VALUES (?1, ?2, ?3)
       ON CONFLICT(runner_id) DO UPDATE SET last_seen = excluded.last_seen, info = excluded.info`
    )
      .bind(rid, Date.now(), JSON.stringify(b.info || {}).slice(0, 500))
      .run();
    return json({ ok: true });
  }

  if (path === "next") {
    // long-poll up to `wait` seconds for a pending job; also counts as a heartbeat
    const rid = String(url.searchParams.get("runner_id") || "runner").slice(0, 64);
    const wait = Math.min(25, Math.max(0, Number(url.searchParams.get("wait") || 20)));
    const t0 = Date.now();
    await env.DB.prepare(
      `INSERT INTO runner_presence (runner_id, last_seen, info) VALUES (?1, ?2, '') ON CONFLICT(runner_id) DO UPDATE SET last_seen = excluded.last_seen`
    )
      .bind(rid, t0)
      .run();
    // reclaim jobs a dead runner took but never finished
    env.DB.prepare(`UPDATE runner_jobs SET status = 'failed', result = '{"ok":false,"error":"runner_lost"}' WHERE status = 'taken' AND taken_at < ?1`)
      .bind(t0 - JOB_TIMEOUT_MS)
      .run()
      .catch(() => {});
    env.DB.prepare(`DELETE FROM runner_jobs WHERE created_at < ?1`).bind(t0 - 10 * 60 * 1000).run().catch(() => {});
    while (true) {
      const job = await env.DB.prepare(`SELECT id, payload FROM runner_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`).first();
      if (job) {
        const now = Date.now();
        const r = await env.DB.prepare(`UPDATE runner_jobs SET status = 'taken', taken_at = ?2 WHERE id = ?1 AND status = 'pending'`).bind(job.id, now).run();
        if (r.meta?.changes === 0) continue; // someone else took it
        let payload = {};
        try {
          payload = JSON.parse(job.payload);
        } catch {}
        return json({ ok: true, job: { id: job.id, ...payload } });
      }
      if (Date.now() - t0 >= wait * 1000) return json({ ok: true, job: null });
      await sleep(POLL_MS);
    }
  }

  if (path === "result" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    if (!id) return json({ ok: false, error: "need_id" }, 400);
    const result = b.result && typeof b.result === "object" ? b.result : { ok: false, error: "empty_result" };
    const status = result.ok === false ? "failed" : "done";
    await env.DB.prepare(`UPDATE runner_jobs SET status = ?2, result = ?3, done_at = ?4 WHERE id = ?1`)
      .bind(id, status, JSON.stringify(result).slice(0, 1800000), Date.now())
      .run();
    return json({ ok: true });
  }

  return json({ ok: false, error: "not_found", try: ["GET /runner/next", "POST /runner/result", "POST /runner/heartbeat"] }, 404);
}
