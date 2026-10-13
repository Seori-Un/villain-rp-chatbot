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
      viewport: { width: 1280, height: 800 },
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      // a normal desktop UA gets fewer bot walls than a self-declared runner UA
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    // dialogs would otherwise hang the action
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    const row = { context, page, touched: Date.now(), refs: new Map() };
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

    const row = await this.get(session_id);
    const { page } = row;
    /** resolve ref (from last observe) | selector | text → locator */
    const target = () => {
      if (body.ref != null && row.refs.has(String(body.ref))) return page.locator(row.refs.get(String(body.ref))).first();
      if (body.selector) return page.locator(String(body.selector)).first();
      if (body.text_match) return page.getByText(String(body.text_match), { exact: false }).first();
      return null;
    };

    switch (action) {
      case "open": {
        const url = String(body.url || "");
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, error: "bad_url", message: "http(s) only" };
        }
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await this.settle(page);
        return await this.observe(page, true, row);
      }
      case "screenshot": {
        return await this.observe(page, true, row);
      }
      case "click": {
        const loc = target();
        if (loc) {
          try {
            await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
            await loc.click({ timeout: 8000 });
          } catch (e) {
            // overlays / cookie banners: try a forced click once
            await loc.click({ timeout: 6000, force: true });
          }
        } else if (typeof body.x === "number" && typeof body.y === "number") {
          await page.mouse.click(body.x, body.y);
        } else {
          return { ok: false, error: "need_ref_selector_or_xy" };
        }
        await this.settle(page);
        return await this.observe(page, true, row);
      }
      case "type": {
        const loc = target();
        const text = String(body.text ?? "");
        if (!loc) return { ok: false, error: "need_ref_or_selector" };
        await loc.click({ timeout: 6000 }).catch(() => {});
        await loc.fill(text, { timeout: 8000 });
        if (body.submit) await loc.press("Enter");
        await this.settle(page);
        return await this.observe(page, Boolean(body.submit), row);
      }
      case "press": {
        await page.keyboard.press(String(body.key || "Enter"));
        await this.settle(page);
        return await this.observe(page, true, row);
      }
      case "select": {
        const loc = target();
        if (!loc) return { ok: false, error: "need_ref_or_selector" };
        await loc.selectOption(String(body.value ?? body.label ?? ""), { timeout: 8000 });
        return await this.observe(page, false, row);
      }
      case "back": {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await this.settle(page);
        return await this.observe(page, true, row);
      }
      case "find": {
        // text search in page → where is it, and which clickable is near it
        const q = String(body.query || "");
        const hits = await page.evaluate((q) => {
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode()) && out.length < 8) {
            const t = (n.textContent || "").trim();
            if (t && t.toLowerCase().includes(q.toLowerCase())) {
              const el = n.parentElement;
              const r = el.getBoundingClientRect();
              out.push({ text: t.slice(0, 120), tag: el.tagName.toLowerCase(), y: Math.round(r.top + window.scrollY), visible: r.width > 0 && r.height > 0 });
            }
          }
          return out;
        }, q);
        return { ok: true, url: page.url(), query: q, hits };
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
      case "read": {
        // Full main text (no screenshot) for research; Worker caps what it feeds the LLM.
        const url = page.url();
        const title = await page.title().catch(() => "");
        let text = "";
        try {
          text = await page.evaluate(() => {
            const pick = document.querySelector("article, main, [role=main]") || document.body;
            for (const sel of ["script", "style", "noscript", "nav", "footer", "header", "aside", "iframe", "svg"]) {
              pick.querySelectorAll(sel).forEach((el) => el.remove());
            }
            return pick.innerText || "";
          });
        } catch {
          text = await page.innerText("body", { timeout: 5000 }).catch(() => "");
        }
        text = String(text || "")
          .split("\n")
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter((l) => l.length > 1)
          .join("\n")
          .slice(0, Number(body.max_chars) || 12000);
        let links = [];
        try {
          links = await page.evaluate(() =>
            Array.from(document.querySelectorAll("a[href]"))
              .map((a) => ({ text: (a.innerText || "").trim().slice(0, 80), href: a.href }))
              .filter((l) => l.text && /^https?:/.test(l.href))
              .slice(0, 40)
          );
        } catch {
          links = [];
        }
        return { ok: true, url, title, text, links };
      }
      case "wait": {
        if (body.selector) {
          await page.waitForSelector(String(body.selector), { timeout: Math.min(20000, Number(body.ms) || 8000) }).catch(() => {});
        } else if (body.text_match) {
          await page.getByText(String(body.text_match)).first().waitFor({ timeout: Math.min(20000, Number(body.ms) || 8000) }).catch(() => {});
        } else {
          await page.waitForTimeout(Math.min(10000, Number(body.ms) || 1000));
        }
        return await this.observe(page, true, row);
      }
      default:
        return { ok: false, error: "unknown_action", message: String(action) };
    }
  }

  /** let SPA navigations / network settle a bit without hanging */
  async settle(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(250);
  }

  /**
   * Observation = url, title, visible text, numbered interactive elements (refs the agent can click/type by),
   * and a small JPEG screenshot (for vision-capable planners).
   */
  async observe(page, withScreenshot, row) {
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

    let elements = [];
    try {
      elements = await page.evaluate(() => {
        const items = [];
        const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [contenteditable="true"], summary, [onclick]';
        const seen = new Set();
        const vw = window.innerWidth, vh = window.innerHeight;
        for (const el of document.querySelectorAll(sel)) {
          if (items.length >= 70) break;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          if (r.bottom < -vh || r.top > vh * 2) continue; // roughly current + next screen
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute("type") || "").toLowerCase();
          if (tag === "input" && type === "hidden") continue;
          const name =
            (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || el.innerText || el.value || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 60);
          const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? type || "text" : tag);
          // build a reasonably unique selector
          let s = "";
          if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) s = "#" + el.id;
          else if (el.getAttribute("data-testid")) s = `[data-testid="${el.getAttribute("data-testid")}"]`;
          else if (el.getAttribute("name")) s = `${tag}[name="${el.getAttribute("name")}"]`;
          else if (el.getAttribute("aria-label")) s = `${tag}[aria-label="${el.getAttribute("aria-label").replace(/"/g, '\\"')}"]`;
          else {
            // nth-of-type path, 3 levels
            const parts = [];
            let cur = el;
            for (let d = 0; cur && d < 3 && cur !== document.body; d++) {
              const t = cur.tagName.toLowerCase();
              const idx = Array.from(cur.parentElement ? cur.parentElement.children : []).filter((c) => c.tagName === cur.tagName).indexOf(cur) + 1;
              parts.unshift(`${t}:nth-of-type(${idx})`);
              cur = cur.parentElement;
            }
            s = parts.join(" > ");
          }
          if (seen.has(s)) continue;
          seen.add(s);
          items.push({
            role,
            name,
            selector: s,
            href: tag === "a" ? (el.getAttribute("href") || "").slice(0, 120) : undefined,
            value: tag === "input" || tag === "textarea" ? String(el.value || "").slice(0, 40) : undefined,
            inview: r.top >= 0 && r.bottom <= vh,
          });
        }
        return items;
      });
    } catch {
      elements = [];
    }
    if (row) {
      row.refs = new Map();
      elements.forEach((e, i) => {
        e.ref = i + 1;
        row.refs.set(String(e.ref), e.selector);
      });
    }

    let screenshot_b64;
    if (withScreenshot) {
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false, scale: "css" });
        screenshot_b64 = buf.toString("base64");
      } catch {
        screenshot_b64 = undefined;
      }
    }
    const scroll = await page.evaluate(() => ({ y: Math.round(window.scrollY), max: Math.max(0, document.body.scrollHeight - window.innerHeight) })).catch(() => ({ y: 0, max: 0 }));
    return { ok: true, url, title, text, elements, scroll, screenshot_b64, screenshot_mime: screenshot_b64 ? "image/jpeg" : undefined };
  }
}
