/**
 * Per-session Playwright pages. Skeleton — enough for open/click/type/scroll/screenshot.
 * Safety (payment/login) is enforced primarily on the Worker; runner still refuses file:// etc.
 */

import { chromium } from "playwright";

export class SessionPool {
  constructor({ headless = true } = {}) {
    this.headless = headless;
    /** @type {Map<string, { context: any, page: any, touched: number }>} */
    this.map = new Map();
    this.browser = null;
  }

  size() {
    return this.map.size;
  }

  async ensureBrowser() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
    }
    return this.browser;
  }

  async get(sessionId) {
    const id = sessionId || "default";
    if (this.map.has(id)) {
      const row = this.map.get(id);
      row.touched = Date.now();
      return row;
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (compatible; ChaetiBrowserRunner/0.1; +https://github.com/Seori-Un/villain-rp-chatbot)",
    });
    const page = await context.newPage();
    const row = { context, page, touched: Date.now() };
    this.map.set(id, row);
    // simple GC
    if (this.map.size > 20) {
      let oldest = null;
      let t = Infinity;
      for (const [k, v] of this.map) {
        if (v.touched < t) {
          t = v.touched;
          oldest = k;
        }
      }
      if (oldest && oldest !== id) await this.close(oldest);
    }
    return row;
  }

  async close(sessionId) {
    const row = this.map.get(sessionId);
    if (!row) return;
    this.map.delete(sessionId);
    try {
      await row.context.close();
    } catch {
      /* ignore */
    }
  }

  async act(body) {
    const action = body.action || body.tool;
    const session_id = body.session_id || body.sessionId || "default";

    if (action === "close") {
      await this.close(session_id);
      return { ok: true, closed: true };
    }

    const { page } = await this.get(session_id);

    switch (action) {
      case "open": {
        const target = String(body.url || "");
        if (!/^https?:\/\//i.test(target)) {
          return { ok: false, error: "bad_url", message: "http(s) only" };
        }
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
        return await this.observe(page, true);
      }
      case "screenshot": {
        return await this.observe(page, true);
      }
      case "click": {
        if (body.selector) {
          await page.click(String(body.selector), { timeout: 10000 });
        } else if (typeof body.x === "number" && typeof body.y === "number") {
          await page.mouse.click(body.x, body.y);
        } else {
          return { ok: false, error: "need_selector_or_xy" };
        }
        await page.waitForTimeout(300);
        return await this.observe(page, false);
      }
      case "type": {
        const selector = String(body.selector || "");
        const text = String(body.text ?? "");
        if (!selector) return { ok: false, error: "need_selector" };
        await page.fill(selector, text, { timeout: 10000 });
        if (body.submit) await page.press(selector, "Enter");
        await page.waitForTimeout(300);
        return await this.observe(page, false);
      }
      case "scroll": {
        const dir = String(body.direction || "down");
        const amount = Number(body.amount) || 600;
        const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
        const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
        await page.mouse.wheel(dx, dy);
        await page.waitForTimeout(200);
        return await this.observe(page, false);
      }
      default:
        return { ok: false, error: "unknown_action", message: String(action) };
    }
  }

  async observe(page, withScreenshot) {
    const url = page.url();
    const title = await page.title().catch(() => "");
    let text = "";
    try {
      text = await page.innerText("body", { timeout: 5000 });
    } catch {
      text = "";
    }
    text = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);

    let screenshot_b64;
    if (withScreenshot) {
      try {
        const buf = await page.screenshot({ type: "png", fullPage: false });
        screenshot_b64 = buf.toString("base64");
      } catch {
        screenshot_b64 = undefined;
      }
    }
    return { ok: true, url, title, text, screenshot_b64 };
  }
}
