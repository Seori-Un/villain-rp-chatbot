/**
 * 기억 화면 — 서버(D1)에 저장된 대화를 타임라인/주제/검색으로 보고, 지난 대화를 이어서 하거나 지운다.
 * Worker: /memory/{stats,timeline,conversation,topics,topic,search,delete,digest}
 * app.js 가 window.Chaeti { apiBase, getUserId, setUserId, getConvId, newConversation, continueConversation } 노출.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const panel = $("memoryPanel");
  const body = $("memoryBody");
  const status = $("memoryStatus");
  const codeEl = $("memoryCode");
  if (!panel || !window.Chaeti) return;
  const API = window.Chaeti.apiBase;

  let tab = "timeline";
  let enabled = null; // null = unknown
  let lastDigestAt = 0;

  /* ---------- api ---------- */
  async function api(path, params = {}, post = null) {
    const u = new URL(API + "/memory/" + path);
    u.searchParams.set("user_id", window.Chaeti.getUserId());
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, v);
    const res = await fetch(u, post ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...post, user_id: window.Chaeti.getUserId() }) } : {});
    const data = await res.json().catch(() => ({}));
    if (res.status === 503 && data.error === "memory_disabled") enabled = false;
    else if (res.ok) enabled = true;
    return { ok: res.ok, status: res.status, ...data };
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function setStatus(t, cls) {
    status.textContent = t || "";
    status.className = "memory-status" + (cls ? " " + cls : "");
  }
  function fmtTs(ts) {
    try {
      return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts));
    } catch {
      return "";
    }
  }

  /* ---------- open / close ---------- */
  function open(which) {
    if (which) tab = which;
    panel.hidden = false;
    codeEl.textContent = window.Chaeti.getUserId();
    for (const b of panel.querySelectorAll(".memory-tabs button")) b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
    render();
  }
  function close() {
    panel.hidden = true;
  }

  async function render() {
    body.innerHTML = '<p class="memory-empty">불러오는 중…</p>';
    if (enabled === false) {
      body.innerHTML = '<p class="memory-empty">서버에 기억 저장소(D1)가 아직 연결되지 않았어. 연결되면 여기서 지난 대화를 볼 수 있어.</p>';
      return;
    }
    try {
      if (tab === "timeline") await renderTimeline();
      else if (tab === "topics") await renderTopics();
      else await renderSearch();
    } catch (e) {
      body.innerHTML = `<p class="memory-empty err">불러오기 실패: ${esc(e.message || e)}</p>`;
    }
  }

  /* ---------- timeline ---------- */
  async function renderTimeline(before = "") {
    const data = await api("timeline", { days: 14, before });
    if (!data.ok) throw new Error(data.error || data.reply || "timeline");
    const frag = document.createDocumentFragment();
    const stats = await api("stats");
    if (stats.ok) {
      setStatus(`대화 ${stats.conversations}개 · 메시지 ${stats.messages}개 · 주제 ${stats.topics}개${stats.first_day ? ` · ${stats.first_day}부터` : ""}`);
    }
    if (!data.days.length && !before) {
      body.innerHTML = '<p class="memory-empty">아직 저장된 대화가 없어. 채팅하면 여기 쌓여.</p>';
      return;
    }
    for (const d of data.days) {
      const sec = document.createElement("section");
      sec.className = "mem-day";
      const convs = d.conversations
        .map(
          (c) => `
        <li class="mem-conv" data-conv="${esc(c.id)}">
          <button type="button" class="mem-conv-open">
            <span class="mem-time">${esc(c.time)}</span>
            <span class="mem-title">${esc(c.title)}</span>
            <span class="mem-mode">${c.message_count}개</span>
          </button>
          ${c.summary ? `<p class="mem-summary">${esc(c.summary.split("\\n")[0]).slice(0, 200)}</p>` : ""}
          <div class="mem-actions">
            <button type="button" class="linkish mem-continue">이어서 대화</button>
            <button type="button" class="linkish danger mem-del-conv">삭제</button>
          </div>
        </li>`
        )
        .join("");
      sec.innerHTML = `
        <h3><span>${esc(d.label)}</span> <small>${d.message_count}개${d.pending ? " · 정리 전" : ""}</small>
          <button type="button" class="linkish danger mem-del-day" title="이 날 기억 삭제">삭제</button></h3>
        ${d.summary ? `<p class="mem-daysum">${esc(d.summary)}</p>` : `<p class="mem-daysum muted">하루 요약은 대화가 잠잠해지면 자동으로 만들어져.</p>`}
        ${d.highlights.length ? `<ul class="mem-hl">${d.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
        <ul class="mem-convs">${convs}</ul>`;
      sec.querySelector(".mem-del-day").addEventListener("click", async () => {
        if (!confirm(`${d.label} 기억을 전부 지울까? (되돌릴 수 없어)`)) return;
        await api("delete", {}, { scope: "day", id: d.day });
        render();
      });
      for (const li of sec.querySelectorAll(".mem-conv")) {
        const id = li.dataset.conv;
        li.querySelector(".mem-conv-open").addEventListener("click", () => openConversation(id));
        li.querySelector(".mem-continue").addEventListener("click", () => continueConversation(id));
        li.querySelector(".mem-del-conv").addEventListener("click", async () => {
          if (!confirm("이 대화를 기억에서 지울까?")) return;
          await api("delete", {}, { scope: "conversation", id });
          render();
        });
      }
      frag.appendChild(sec);
    }
    if (data.next_before && data.days.length >= 14) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "live-btn mem-more";
      more.textContent = "더 보기";
      more.addEventListener("click", async () => {
        more.remove();
        await renderTimeline(data.next_before);
      });
      frag.appendChild(more);
    }
    if (!before) body.innerHTML = "";
    body.appendChild(frag);
  }

  /* ---------- conversation detail ---------- */
  async function openConversation(id) {
    open();
    body.innerHTML = '<p class="memory-empty">불러오는 중…</p>';
    const data = await api("conversation", { conv_id: id, limit: 400 });
    if (!data.ok) {
      body.innerHTML = '<p class="memory-empty err">대화를 찾을 수 없어.</p>';
      return;
    }
    const c = data.conversation;
    const wrap = document.createElement("div");
    wrap.className = "mem-detail";
    wrap.innerHTML = `
      <div class="mem-detail-head">
        <button type="button" class="linkish mem-back">← 목록</button>
        <h3>${esc(c.title)}</h3>
        <small>${esc(fmtTs(c.started_at))} · ${c.message_count}개${c.topics.length ? " · " + c.topics.map((t) => "#" + esc(t.name)).join(" ") : ""}</small>
        ${c.summary ? `<p class="mem-summary">${esc(c.summary)}</p>` : ""}
        <div class="mem-actions">
          <button type="button" class="live-btn mem-continue">이어서 대화</button>
          <button type="button" class="linkish danger mem-del-conv">이 대화 삭제</button>
        </div>
      </div>
      <div class="mem-msgs">${c.messages
        .map((m) => `<div class="mem-msg ${m.role === "user" ? "me" : "bot"}"><span class="mem-msg-time">${esc(fmtTs(m.ts))}</span>${esc(m.content)}</div>`)
        .join("")}</div>`;
    wrap.querySelector(".mem-back").addEventListener("click", () => render());
    wrap.querySelector(".mem-continue").addEventListener("click", () => {
      window.Chaeti.continueConversation(c);
      close();
    });
    wrap.querySelector(".mem-del-conv").addEventListener("click", async () => {
      if (!confirm("이 대화를 기억에서 지울까?")) return;
      await api("delete", {}, { scope: "conversation", id });
      render();
    });
    body.innerHTML = "";
    body.appendChild(wrap);
  }

  async function continueConversation(id) {
    const data = await api("conversation", { conv_id: id, limit: 400 });
    if (!data.ok) return;
    window.Chaeti.continueConversation(data.conversation);
    close();
  }

  /* ---------- topics ---------- */
  async function renderTopics() {
    const data = await api("topics");
    if (!data.ok) throw new Error(data.error || "topics");
    setStatus(`주제 ${data.topics.length}개 · 대화가 정리되면 자동으로 묶여`);
    if (!data.topics.length) {
      body.innerHTML = '<p class="memory-empty">아직 주제가 없어. 대화가 쌓이고 정리되면 생겨.</p>';
      return;
    }
    body.innerHTML = `<ul class="mem-topics">${data.topics
      .map(
        (t) => `<li class="mem-topic" data-topic="${esc(t.id)}">
          <button type="button" class="mem-topic-open"><strong># ${esc(t.name)}</strong> <small>${t.conv_count}개 대화</small></button>
          <p class="mem-summary">${esc(t.summary || t.keywords || "")}</p>
        </li>`
      )
      .join("")}</ul>`;
    for (const li of body.querySelectorAll(".mem-topic")) {
      li.querySelector(".mem-topic-open").addEventListener("click", () => openTopic(li.dataset.topic));
    }
  }

  async function openTopic(id) {
    open("topics");
    body.innerHTML = '<p class="memory-empty">불러오는 중…</p>';
    const data = await api("topic", { topic_id: id });
    if (!data.ok) {
      body.innerHTML = '<p class="memory-empty err">주제를 찾을 수 없어.</p>';
      return;
    }
    const t = data.topic;
    const wrap = document.createElement("div");
    wrap.className = "mem-detail";
    wrap.innerHTML = `
      <div class="mem-detail-head">
        <button type="button" class="linkish mem-back">← 주제 목록</button>
        <h3># ${esc(t.name)}</h3>
        <small>${esc(t.keywords)}</small>
        <p class="mem-summary">${esc(t.summary)}</p>
        <div class="mem-actions"><button type="button" class="linkish danger mem-del-topic">이 주제 삭제 (대화는 남아)</button></div>
      </div>
      <ul class="mem-convs">${t.conversations
        .map(
          (c) => `<li class="mem-conv" data-conv="${esc(c.id)}">
            <button type="button" class="mem-conv-open"><span class="mem-time">${esc(c.time)}</span><span class="mem-title">${esc(c.title)}</span></button>
            ${c.snippet ? `<p class="mem-summary">${esc(c.snippet)}</p>` : ""}
            <div class="mem-actions"><button type="button" class="linkish mem-continue">이어서 대화</button></div>
          </li>`
        )
        .join("")}</ul>`;
    wrap.querySelector(".mem-back").addEventListener("click", () => render());
    wrap.querySelector(".mem-del-topic").addEventListener("click", async () => {
      if (!confirm("이 주제를 지울까? (묶인 대화 자체는 남아)")) return;
      await api("delete", {}, { scope: "topic", id });
      render();
    });
    for (const li of wrap.querySelectorAll(".mem-conv")) {
      li.querySelector(".mem-conv-open").addEventListener("click", () => openConversation(li.dataset.conv));
      li.querySelector(".mem-continue").addEventListener("click", () => continueConversation(li.dataset.conv));
    }
    body.innerHTML = "";
    body.appendChild(wrap);
  }

  /* ---------- search ---------- */
  async function renderSearch() {
    setStatus("대화 원문에서 찾아. 단어 앞부분만 맞아도 찾아져 (예: 고양이, 회사)");
    body.innerHTML = `
      <form class="mem-search"><input type="search" placeholder="뭘 얘기했는지 찾기…" autocomplete="off" /><button type="submit" class="live-btn">찾기</button></form>
      <div class="mem-results"></div>`;
    const form = body.querySelector("form");
    const results = body.querySelector(".mem-results");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = form.querySelector("input").value.trim();
      if (!q) return;
      results.innerHTML = '<p class="memory-empty">찾는 중…</p>';
      const data = await api("search", { q, limit: 20 });
      if (!data.ok || !data.hits.length) {
        results.innerHTML = '<p class="memory-empty">없어.</p>';
        return;
      }
      results.innerHTML = `<ul class="mem-convs">${data.hits
        .map(
          (h) => `<li class="mem-conv" data-conv="${esc(h.conv_id)}">
            <button type="button" class="mem-conv-open"><span class="mem-time">${esc(h.time)}</span><span class="mem-title">${esc(h.title)}</span></button>
            <p class="mem-summary"><b>${h.role === "user" ? "나" : "채티"}:</b> ${esc(h.content)}${h.next ? `<br><b>${h.next.role === "user" ? "나" : "채티"}:</b> ${esc(h.next.content)}` : ""}</p>
            <div class="mem-actions"><button type="button" class="linkish mem-continue">이어서 대화</button></div>
          </li>`
        )
        .join("")}</ul>`;
      for (const li of results.querySelectorAll(".mem-conv")) {
        li.querySelector(".mem-conv-open").addEventListener("click", () => openConversation(li.dataset.conv));
        li.querySelector(".mem-continue").addEventListener("click", () => continueConversation(li.dataset.conv));
      }
    });
    form.querySelector("input").focus();
  }

  /* ---------- background digest (summaries/topics) ---------- */
  async function digestLoop() {
    if (enabled === false) return;
    if (Date.now() - lastDigestAt < 20 * 60 * 1000) return;
    lastDigestAt = Date.now();
    try {
      // a few bounded passes; each summarizes ≤4 conversations, ≤3 days, ≤4 topics
      for (let i = 0; i < 3; i++) {
        const r = await api("digest", {}, {});
        if (!r.ok || !r.pending) break;
      }
    } catch {}
  }

  /* ---------- wiring ---------- */
  $("memoryOpen").addEventListener("click", () => (panel.hidden ? open() : close()));
  $("memoryClose").addEventListener("click", close);
  $("memoryNew").addEventListener("click", () => {
    window.Chaeti.newConversation();
    close();
  });
  for (const b of panel.querySelectorAll(".memory-tabs button")) {
    b.addEventListener("click", () => open(b.dataset.tab));
  }
  $("memoryCopyCode").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.Chaeti.getUserId());
      setStatus("기억 코드를 복사했어. 다른 기기에서 「다른 기기 코드 입력」에 붙여 넣으면 같은 기억을 써.");
    } catch {
      setStatus("복사가 안 되면 코드를 직접 적어 둬: " + window.Chaeti.getUserId());
    }
  });
  $("memoryChangeCode").addEventListener("click", () => {
    const v = prompt("다른 기기의 기억 코드를 붙여 넣어 (6~64자, 영문/숫자/-/_).\n바꾸면 이 기기도 그 기억을 쓰게 돼.", window.Chaeti.getUserId());
    if (v == null) return;
    if (!window.Chaeti.setUserId(v)) {
      setStatus("코드 형식이 안 맞아.", "err");
      return;
    }
    codeEl.textContent = window.Chaeti.getUserId();
    window.Chaeti.newConversation();
    render();
  });
  $("memoryDeleteAll").addEventListener("click", async () => {
    if (!confirm("서버에 저장된 모든 기억(대화·요약·주제)을 지울까? 되돌릴 수 없어.")) return;
    if (!confirm("정말? 채티가 전부 잊어버려.")) return;
    await api("delete", {}, { scope: "all" });
    window.Chaeti.newConversation();
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  window.ChaetiMemory = { open, close, openConversation, openTopic, digest: digestLoop };

  // on load: check availability quietly, then run a digest pass a bit later
  api("stats").then((r) => {
    if (r.ok && r.enabled) setTimeout(digestLoop, 4000);
  });
  // after each reply, occasionally tidy up in the background
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) digestLoop();
  });
})();
