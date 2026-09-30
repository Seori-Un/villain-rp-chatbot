#!/usr/bin/env node
/**
 * Regression self-check for classifyIntent.
 * Run: node scripts/intent-check.js
 * Optional live: LIVE_URL=https://... node scripts/intent-check.js --live
 */
import { classifyIntent } from "../src/intent.js";

const CASES = [
  // reject
  ["우리 연락 좀 줄이자", "reject"],
  ["연락 줄이자", "reject"],
  ["연락 줄여", "reject"],
  ["연락 좀 줄이자", "reject"],
  ["연락을 좀 줄이자", "reject"],
  ["그만 연락", "reject"],
  ["그만 연락해", "reject"],
  ["연락하지 마", "reject"],
  ["거리 두자", "reject"],
  ["좀 떨어져", "reject"],
  ["차단할게", "reject"],
  ["헤어지자", "reject"],
  // ask_me
  ["오늘은 뭐했어?", "ask_me"],
  ["오늘 뭐했어", "ask_me"],
  ["뭐했어?", "ask_me"],
  ["어제 어떻게 지냈어", "ask_me"],
  ["너는 뭐해", "ask_me"],
  // warm (explicit only — bare 좋아 is NOT warm)
  ["좋아해", "warm"],
  ["사랑해", "warm"],
  ["보고 싶어", "warm"],
  ["너 좋아", "warm"],
  ["난 네가 좋아", "warm"],
  // not warm
  ["좋아", "chat"],
  ["좋아 보이네", "chat"],
  ["좋은 하루", "chat"],
  // rival
  ["친구랑 밥 먹었어", "rival"],
  ["남친이랑 카페 갔어", "rival"],
  ["다른 애랑 저녁", "rival"],
  // late
  ["늦게 와서 미안", "late"],
  ["바빴어", "late"],
  ["읽씹했어?", "late"],
  // silence
  ["", "silence"],
  ["   ", "silence"],
];

let failed = 0;
console.log("=== local classifyIntent ===");
for (const [text, expect] of CASES) {
  const got = classifyIntent(text);
  const ok = got === expect;
  if (!ok) failed += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${JSON.stringify(text)} -> ${got} (want ${expect})`);
}

const live = process.argv.includes("--live");
const base = (process.env.LIVE_URL || "https://villain-rp-chatbot.e5eeeee.workers.dev").replace(/\/$/, "");

async function liveCheck() {
  console.log("\n=== live /chat samples ===");
  const samples = [
    ["우리 연락 좀 줄이자", "reject"],
    ["오늘은 뭐했어?", "ask_me"],
    ["좋아해", "warm"],
    ["좋아", "chat"],
    ["친구랑 저녁 먹었어", "rival"],
  ];
  for (const [message, expect] of samples) {
    const sid = `intent-check-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session_id: sid }),
    });
    const data = await res.json();
    const got = data.intent;
    const ok = got === expect;
    if (!ok) failed += 1;
    const reply = String(data.reply || "").slice(0, 60);
    console.log(
      `${ok ? "OK" : "FAIL"} live ${JSON.stringify(message)} intent=${got} (want ${expect}) mode=${data.mode} reply=${reply}…`
    );
  }
}

(async () => {
  if (live) await liveCheck();
  console.log(failed ? `\nFAILED: ${failed}` : "\nAll passed.");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
