// Bridge dashboard client — connects to broker WS as "isko" (priority), renders stream + inject UI.
// Plain vanilla JS, no build step. Served by the broker HTTP listener at /dashboard/dashboard.js.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const WS_URL = `ws://${location.hostname}:4700`;
  const HTTP_BASE = `http://${location.hostname}:${location.port || 4701}`;
  const AGENT_ID = "isko";
  const HEARTBEAT_MS = 10000;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const TOKEN_KEY = "bridge.iskoToken";
  const STICKY_THRESHOLD_PX = 80; // within this distance from bottom = sticky

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    ws: null,
    connected: false,
    reconnectAttempt: 0,
    heartbeatTimer: null,
    reconnectTimer: null,
    seenIds: new Set(),
    threads: new Map(), // thread_id -> { id, messages: [], lastTs }
    agents: new Map(), // agent_id -> { id, state, last_heartbeat_ts }
    floorHolder: null,
    sticky: true,
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const els = {
    floorPill: $("floorPill"),
    connPill: $("connPill"),
    tokenBtn: $("tokenBtn"),
    agentList: $("agentList"),
    threadList: $("threadList"),
    stream: $("stream"),
    streamInner: $("streamInner"),
    jumpLatest: $("jumpLatest"),
    injectForm: $("injectForm"),
    injectTo: $("injectTo"),
    injectType: $("injectType"),
    injectBody: $("injectBody"),
    injectBtn: $("injectBtn"),
    forceFloorBtn: $("forceFloorBtn"),
    forceFloorHint: $("forceFloorHint"),
    modal: $("modal"),
    tokenInput: $("tokenInput"),
    tokenSave: $("tokenSave"),
    tokenCancel: $("tokenCancel"),
    toast: $("toast"),
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function uuid() {
    if (crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // Fallback (very old browsers)
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function formatTs(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  function showToast(text, kind) {
    els.toast.textContent = text;
    els.toast.className = "toast" + (kind ? " " + kind : "");
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      els.toast.hidden = true;
    }, 3500);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
      }
      return c;
    });
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle
  // ---------------------------------------------------------------------------
  function connectWs() {
    setConn(false);
    try {
      state.ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error("ws construct failed", err);
      scheduleReconnect();
      return;
    }

    state.ws.addEventListener("open", () => {
      state.reconnectAttempt = 0;
      setConn(true);
      register();
      startHeartbeat();
      // After register, replay recent history via REST.
      hydrateHistory();
    });

    state.ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });

    state.ws.addEventListener("close", () => {
      setConn(false);
      stopHeartbeat();
      scheduleReconnect();
    });

    state.ws.addEventListener("error", (e) => {
      console.error("ws error", e);
    });
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, state.reconnectAttempt++),
    );
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectWs();
    }, delay);
  }

  function setConn(ok) {
    state.connected = ok;
    els.connPill.textContent = ok ? "connected" : "disconnected";
    els.connPill.className = "conn-pill " + (ok ? "online" : "offline");
  }

  function register() {
    sendEnvelope({
      type: "register",
      to: "bridge",
      thread_id: "system",
      body: "dashboard",
      priority: true,
    });
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatTimer = setInterval(() => {
      if (!state.connected) return;
      sendEnvelope({
        type: "heartbeat",
        to: "bridge",
        thread_id: "system",
        body: "",
        priority: true,
      });
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  function sendEnvelope(partial) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    const env = {
      id: partial.id || uuid(),
      ts: partial.ts || Date.now(),
      from: AGENT_ID,
      to: partial.to,
      type: partial.type,
      thread_id: partial.thread_id || "isko-inject",
      reply_to: partial.reply_to ?? null,
      priority: partial.priority ?? true,
      body: partial.body || "",
      needs_ack: partial.needs_ack ?? false,
    };
    try {
      state.ws.send(JSON.stringify(env));
      return true;
    } catch (err) {
      console.error("ws send failed", err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound message handling
  // ---------------------------------------------------------------------------
  function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    // Floor updates from broker (best-effort UI hint).
    if (msg.type === "floor_grant") {
      state.floorHolder = msg.to;
      renderFloor();
      return;
    }
    if (msg.type === "floor_deny") {
      state.floorHolder = msg.body || state.floorHolder;
      renderFloor();
      return;
    }
    // Skip ephemera that shouldn't enter the stream.
    if (msg.type === "heartbeat" || msg.type === "ping" || msg.type === "pong") {
      return;
    }
    if (msg.type === "typing") {
      // Could surface a typing indicator; left as future polish.
      return;
    }
    if (msg.type === "register" || msg.type === "deregister") {
      // Soft-refresh agent list when presence changes.
      refreshAgents();
      // Continue: register/deregister are persisted by broker, show in stream too.
    }

    addMessage(msg);
  }

  function addMessage(msg) {
    if (!msg.id || state.seenIds.has(msg.id)) return;
    state.seenIds.add(msg.id);

    const tid = msg.thread_id || "system";
    let group = state.threads.get(tid);
    if (!group) {
      group = { id: tid, messages: [], lastTs: 0 };
      state.threads.set(tid, group);
    }
    group.messages.push(msg);
    group.lastTs = Math.max(group.lastTs, msg.ts || 0);

    renderStream();
    renderThreads();
  }

  // ---------------------------------------------------------------------------
  // History + agent hydration via REST
  // ---------------------------------------------------------------------------
  async function hydrateHistory() {
    try {
      const res = await fetch(`${HTTP_BASE}/api/messages?since=0&limit=200`);
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) {
        for (const r of rows) addMessage(r);
      }
    } catch (err) {
      console.error("history fetch failed", err);
    }
    refreshAgents();
  }

  async function refreshAgents() {
    try {
      const res = await fetch(`${HTTP_BASE}/api/agents`);
      if (!res.ok) return;
      const rows = await res.json();
      state.agents.clear();
      if (Array.isArray(rows)) {
        for (const a of rows) state.agents.set(a.id, a);
      }
      renderAgents();
      renderInjectTargets();
    } catch (err) {
      console.error("agents fetch failed", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderAgents() {
    const ul = els.agentList;
    if (state.agents.size === 0) {
      ul.innerHTML = '<li class="agent-empty">(none registered)</li>';
      return;
    }
    const items = [...state.agents.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    ul.innerHTML = items
      .map((a) => {
        const dotClass = a.state === "online" ? "online" : a.state || "offline";
        return (
          `<li class="agent-item">` +
          `<span class="agent-dot ${escapeHtml(dotClass)}"></span>` +
          `<span class="agent-id">${escapeHtml(a.id)}</span>` +
          `<span class="agent-meta">${escapeHtml(a.state || "")}</span>` +
          `</li>`
        );
      })
      .join("");
  }

  function renderInjectTargets() {
    const select = els.injectTo;
    const prev = select.value;
    const ids = [...state.agents.keys()].sort();
    select.innerHTML =
      `<option value="all">all (broadcast)</option>` +
      ids
        .filter((id) => id !== AGENT_ID)
        .map(
          (id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`,
        )
        .join("");
    if (prev && [...select.options].some((o) => o.value === prev)) {
      select.value = prev;
    }
  }

  function renderThreads() {
    const ul = els.threadList;
    if (state.threads.size === 0) {
      ul.innerHTML = '<li class="agent-empty">(no threads yet)</li>';
      return;
    }
    const items = [...state.threads.values()].sort(
      (a, b) => b.lastTs - a.lastTs,
    );
    ul.innerHTML = items
      .map(
        (t) =>
          `<li class="thread-item" data-thread="${escapeHtml(t.id)}">${escapeHtml(t.id)} <span class="agent-meta">(${t.messages.length})</span></li>`,
      )
      .join("");
  }

  function renderStream() {
    // Capture sticky state BEFORE mutation.
    captureSticky();

    const groups = [...state.threads.values()].sort(
      (a, b) => a.lastTs - b.lastTs,
    );
    const html = groups
      .map((g) => {
        const head = `<div class="thread-header">thread: ${escapeHtml(g.id)}</div>`;
        const body = g.messages
          .slice()
          .sort((a, b) => a.ts - b.ts)
          .map(renderMessage)
          .join("");
        return `<div class="thread-group" data-thread="${escapeHtml(g.id)}">${head}${body}</div>`;
      })
      .join("");
    els.streamInner.innerHTML = html;

    applyStickyScroll();
  }

  function renderMessage(m) {
    const ts = formatTs(m.ts);
    const type = (m.type || "chat").toLowerCase();
    const tagClass = [
      "chat",
      "question",
      "answer",
      "status",
      "error",
    ].includes(type)
      ? type
      : "system";
    const priorityClass = m.priority ? " priority" : "";
    return (
      `<div class="msg${priorityClass}" data-id="${escapeHtml(m.id)}">` +
      `<div class="msg-ts">${escapeHtml(ts)}</div>` +
      `<div class="msg-body">` +
      `<span class="msg-tag ${tagClass}">${escapeHtml(type)}</span>` +
      `<span class="msg-from">${escapeHtml(m.from || "?")}</span>` +
      `<span class="msg-arrow"> → </span>` +
      `<span class="msg-to">${escapeHtml(m.to || "?")}</span>: ` +
      `${escapeHtml(m.body || "")}` +
      `</div>` +
      `</div>`
    );
  }

  function renderFloor() {
    if (state.floorHolder && state.floorHolder !== AGENT_ID) {
      els.floorPill.textContent = `floor: ${state.floorHolder}`;
      els.floorPill.classList.add("held");
    } else {
      els.floorPill.textContent = "floor: free";
      els.floorPill.classList.remove("held");
    }
  }

  // ---------------------------------------------------------------------------
  // Sticky scroll (auto-follow unless user scrolled up)
  // ---------------------------------------------------------------------------
  function captureSticky() {
    const el = els.streamInner;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    state.sticky = fromBottom <= STICKY_THRESHOLD_PX;
  }

  function applyStickyScroll() {
    if (state.sticky) {
      els.streamInner.scrollTop = els.streamInner.scrollHeight;
      els.jumpLatest.hidden = true;
    } else {
      els.jumpLatest.hidden = false;
    }
  }

  els.streamInner.addEventListener("scroll", () => {
    captureSticky();
    els.jumpLatest.hidden = state.sticky;
  });

  els.jumpLatest.addEventListener("click", () => {
    state.sticky = true;
    applyStickyScroll();
  });

  // ---------------------------------------------------------------------------
  // Inject form
  // ---------------------------------------------------------------------------
  els.injectForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tok = token();
    if (!tok) {
      openTokenModal();
      showToast("Set Isko bearer token first.", "error");
      return;
    }
    const payload = {
      to: els.injectTo.value,
      type: els.injectType.value,
      body: els.injectBody.value.trim(),
      thread_id: "isko-inject",
    };
    if (!payload.body) return;
    els.injectBtn.disabled = true;
    try {
      const res = await fetch(`${HTTP_BASE}/api/inject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tok}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        showToast("Token rejected (401). Update it.", "error");
        openTokenModal();
        return;
      }
      if (res.status === 503) {
        showToast("Broker has no token configured (503).", "error");
        return;
      }
      if (!res.ok) {
        showToast(`Inject failed: ${res.status}`, "error");
        return;
      }
      els.injectBody.value = "";
      showToast("Injected.", "ok");
    } catch (err) {
      console.error(err);
      showToast("Inject error (network).", "error");
    } finally {
      els.injectBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Force-release floor
  // ---------------------------------------------------------------------------
  els.forceFloorBtn.addEventListener("click", async () => {
    const tok = token();
    if (!tok) {
      openTokenModal();
      showToast("Set Isko bearer token first.", "error");
      return;
    }
    try {
      const res = await fetch(`${HTTP_BASE}/api/floor`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (res.status === 404) {
        showToast(
          "DELETE /api/floor not implemented in broker yet (gap).",
          "error",
        );
        return;
      }
      if (!res.ok) {
        showToast(`Force release failed: ${res.status}`, "error");
        return;
      }
      state.floorHolder = null;
      renderFloor();
      showToast("Floor released.", "ok");
    } catch (err) {
      console.error(err);
      showToast("Floor release error (network).", "error");
    }
  });

  // ---------------------------------------------------------------------------
  // Token modal
  // ---------------------------------------------------------------------------
  function openTokenModal() {
    els.tokenInput.value = token();
    els.modal.hidden = false;
    setTimeout(() => els.tokenInput.focus(), 0);
  }
  function closeTokenModal() {
    els.modal.hidden = true;
  }
  els.tokenBtn.addEventListener("click", openTokenModal);
  els.tokenCancel.addEventListener("click", closeTokenModal);
  els.tokenSave.addEventListener("click", () => {
    const v = els.tokenInput.value.trim();
    if (v) sessionStorage.setItem(TOKEN_KEY, v);
    else sessionStorage.removeItem(TOKEN_KEY);
    closeTokenModal();
    showToast("Token saved (sessionStorage).", "ok");
  });
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeTokenModal();
  });

  // Periodic agent refresh as a low-cost fallback for presence changes.
  setInterval(refreshAgents, 5000);

  // Boot
  renderFloor();
  connectWs();
})();
