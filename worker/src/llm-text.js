/**
 * Generic one-shot text completion: Claude → Gemini → Groq.
 * Used by think.js (plan stage). Keeps RP generator in index.js untouched.
 * @returns {Promise<{text:string, provider:string, model:string}>}
 */

const CLAUDE_MODELS = ["claude-sonnet-5", "claude-sonnet-5-5", "claude-sonnet-4-6"];
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
const GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"];

function anthropicKey(env) {
  return (
    (env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim()) ||
    (env.CLAUDE_API_KEY && String(env.CLAUDE_API_KEY).trim()) ||
    ""
  );
}

export async function completeText(env, { system, user, maxTokens = 600, temperature = 0.3, timeoutMs = 25000 }) {
  const errors = [];
  const key = anthropicKey(env);
  if (key) {
    try {
      return await claudeText(key, { system, user, maxTokens, temperature, timeoutMs });
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  if (env.GEMINI_API_KEY) {
    try {
      return await geminiText(env.GEMINI_API_KEY, { system, user, maxTokens, temperature, timeoutMs });
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  if (env.GROQ_API_KEY) {
    try {
      return await groqText(env.GROQ_API_KEY, { system, user, maxTokens, temperature, timeoutMs });
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  throw new Error("no_llm:" + errors.join("|").slice(0, 200));
}

function timed(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function claudeText(key, { system, user, maxTokens, temperature, timeoutMs }) {
  let lastErr = "claude_failed";
  for (const model of CLAUDE_MODELS) {
    const { signal, clear } = timed(timeoutMs);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: user }] }),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = `claude_${res.status}`;
        continue;
      }
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (text) return { text, provider: "claude", model };
    } catch (e) {
      lastErr = String(e.message || e);
    } finally {
      clear();
    }
  }
  throw new Error(lastErr);
}

async function geminiText(key, { system, user, maxTokens, temperature, timeoutMs }) {
  let lastErr = "gemini_failed";
  for (const model of GEMINI_MODELS) {
    const { signal, clear } = timed(timeoutMs);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature },
          }),
          signal,
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = `gemini_${res.status}`;
        continue;
      }
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (text) return { text, provider: "gemini", model };
    } catch (e) {
      lastErr = String(e.message || e);
    } finally {
      clear();
    }
  }
  throw new Error(lastErr);
}

async function groqText(key, { system, user, maxTokens, temperature, timeoutMs }) {
  let lastErr = "groq_failed";
  for (const model of GROQ_MODELS) {
    const { signal, clear } = timed(timeoutMs);
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = `groq_${res.status}`;
        continue;
      }
      const text = String(data.choices?.[0]?.message?.content || "").trim();
      if (text) return { text, provider: "groq", model };
    } catch (e) {
      lastErr = String(e.message || e);
    } finally {
      clear();
    }
  }
  throw new Error(lastErr);
}
