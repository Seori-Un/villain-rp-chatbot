/**
 * Minimal Playwright HTTP runner for 채티 browser agent.
 * Contract expected by worker/src/browser/client.js:
 *   POST /act  { action, session_id, ...args }  → JSON observation
 *   GET  /health
 *
 * Auth: Authorization: Bearer $BROWSER_API_KEY (skipped if env key empty — local only)
 */

import http from "node:http";
import { chromium } from "playwright";
import { loadEnv } from "./env.js";
import { SessionPool } from "./sessions.js";

const env = loadEnv();
const pool = new SessionPool({ headless: env.HEADLESS !== "false" });

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "chaeti-browser-runner",
      sessions: pool.size(),
      headless: env.HEADLESS !== "false",
    });
  }

  if (req.method === "POST" && url.pathname === "/act") {
    if (!authorize(req, env)) {
      return send(res, 401, { ok: false, error: "unauthorized" });
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { ok: false, error: "invalid_json" });
    }
    try {
      const result = await pool.act(body);
      return send(res, result.ok === false ? 422 : 200, result);
    } catch (e) {
      return send(res, 500, {
        ok: false,
        error: "runner_error",
        message: String(e && e.message ? e.message : e).slice(0, 300),
      });
    }
  }

  send(res, 404, { ok: false, error: "not_found", try: ["/health", "POST /act"] });
});

server.listen(env.PORT, env.HOST, () => {
  console.log(`[browser-runner] http://${env.HOST}:${env.PORT}  (Playwright chromium)`);
});

function authorize(req, env) {
  const key = env.BROWSER_API_KEY;
  if (!key) return true; // local unlock
  const h = req.headers.authorization || "";
  return h === `Bearer ${key}` || h === key;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Eager check playwright import path works; browser launches lazily in SessionPool
void chromium;
