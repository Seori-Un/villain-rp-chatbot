import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Tiny .env loader (no dependency). Does not override existing process.env. */
export function loadEnv() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
  return {
    PORT: Number(process.env.PORT || 8788),
    HOST: process.env.HOST || "0.0.0.0",
    BROWSER_API_KEY: process.env.BROWSER_API_KEY || "",
    HEADLESS: process.env.HEADLESS || "true",
  };
}
