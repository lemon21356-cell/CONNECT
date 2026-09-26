// 엔트리 협업 — 콘텐츠 스크립트(isolated world)
(() => {
  if (window.__ecoopLoaded) return; window.__ecoopLoaded = true;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── 엔트리 브리지 (MAIN world) ──
  const pending = new Map();
  let bridgeReady = false;
  const onRun = [];
  let dirty = false;
  window.addEventListener("message", ev => {
    if (ev.source !== window || !ev.data?.__ecoop) return;
    const m = ev.data;
    if (m.type === "res") { pending.get(m.id)?.(m.result); pending.delete(m.id); }
    else if (m.type === "ready") bridgeReady = true;
    else if (m.type === "run") { onRun.forEach(f => f(m.running)); if (!m.running) flushQueued(); }
    else if (m.type === "dirty") { dirty = true; syncSoon(); }
  });
  const bridge = (cmd, data) => new Promise(res => {
    const id = uid(); pending.set(id, res);
    window.postMessage({ __ecoop_req: true, id, cmd, data }, "*");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res(null); } }, 8000);
  });

  // ── 네트워크 (background → offscreen) ──
  const net = (cmd, extra = {}) => chrome.runtime.sendMessage({ ch: "tab->net", cmd, ...extra }).catch(e => ({ ok: false, error: String(e) }));
  const send = (data, to = null) => net("send", { data, to });

  // ── 상태 ──
  const S = {
    role: null, myId: null, code: null,
    me: { name: "", cursor: { shape: "arrow", color: "#2e6ff2", emoji: "🙂" } },
    room: { name: "", max: 4, hostId: null, members: {}, chat: [], checklist: [], testing: {} },
    images: [],
    lastHash: null, lastAppliedAt: 0, applying: false,
  };
  const COLORS = ["#2e6ff2", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#0091ff", "#e93d82", "#12a594"];

  // ── 저장된 커서 스타일 ──
  S.anonymous = false;
  chrome.storage.local.get(["cursor", "anonymous"]).then(r => { if (r.cursor) S.me.cursor = { ...S.me.cursor, ...r.cursor }; S.anonymous = !!r.anonymous; renderRoom(); });

  // ── UI 뼈대 ──
  const root = document.createElement("div");
  root.id = "ecoop";
  root.innerHTML = `
    <button id="ec-fab" type="button" title="Connect"><span class="ec-fab-icon"></span><span class="ec-fab-text">Connect</span></button>
    <div id="ec-panel" hidden>
      <div class="ec-head">
        <b id="ec-title">Connect</b>
        <span id="ec-sub"></span>
        <button id="ec-close" type="button" class="ec-icon" title="닫기">✕</button>
      </div>
      <div class="ec-tabs">
        <button data-tab="room" class="on">방</button>
        <button data-tab="chat">메시지 <i id="ec-badge-chat"></i></button>
        <button data-tab="plan">체크리스트</button>
        <button data-tab="photo">사진</button>
        <button data-tab="cursor">커서</button>
      </div>
      <div class="ec-body">
        <section data-tab="room" class="on"></section>
        <section data-tab="chat">
          <div id="ec-chat-log"></div>
          <div class="ec-row"><input id="ec-chat-in" type="text" placeholder="메시지 입력" maxlength="500"><button id="ec-chat-send" class="ec-primary">보내기</button></div>
        </section>
        <section data-tab="plan">
          <div class="ec-row"><input id="ec-plan-in" type="text" placeholder="할 일 추가 (Enter)" maxlength="200"><button id="ec-plan-add" class="ec-primary">추가</button></div>
          <div class="ec-progress"><div class="ec-bar"><i id="ec-bar-fill"></i></div><span id="ec-progress-text">0 / 0</span></div>
          <ul id="ec-plan-list"></ul>
          <button id="ec-plan-clear" class="ec-ghost-btn" hidden>완료 항목 지우기</button>
        </section>
        <section data-tab="photo">
          <div class="ec-row"><label class="ec-primary ec-file">사진 올리기<input id="ec-photo-in" type="file" accept="image/*" multiple hidden></label><span class="ec-muted">최대 4MB · 자동 축소</span></div>
          <div id="ec-photo-grid"></div>
        </section>
        <section data-tab="cursor"></section>
      </div>
    </div>
    <div id="ec-cursors"></div>
    <div id="ec-toasts"></div>
    <div id="ec-testbar" hidden></div>
    <div id="ec-namebox" hidden><div class="ec-load-box ec-name-box"><b>익명으로 참여</b><p class="ec-muted">방에서 쓸 닉네임을 입력하세요. 엔트리 닉네임은 공개되지 않습니다.</p><input id="ec-name-in" type="text" maxlength="20" placeholder="닉네임"><div class="ec-row"><button id="ec-name-ok" class="ec-primary">입장</button><button id="ec-name-cancel" class="ec-ghost-btn">취소</button></div></div></div>
    <div id="ec-loading" hidden><div class="ec-load-box"><div class="ec-spin"></div><p>잠시만 기다려주세요</p><small></small><div class="ec-lbar"><i id="ec-lbar-fill"></i></div><em id="ec-lbar-pct">0%</em></div></div>`;
  document.documentElement.appendChild(root);
  const $ = s => root.querySelector(s);
  const $$ = s => [...root.querySelectorAll(s)];

  // ── 툴바(파일 아이콘 옆)에 버튼 심기 ──
  const getFab = () => document.getElementById("ec-fab");
  function findFileButton() {
    // 상단 120px 안의 원형/알약 버튼 중 가장 왼쪽 것 = 파일 아이콘
    const btns = [...document.querySelectorAll("a, button, [role=button], div")].filter(b => {
      if (b.id === "ec-fab" || b.closest("#ec-fab") || root.contains(b)) return false;
      const r = b.getBoundingClientRect();
      if (!(r.top >= 0 && r.top < 120 && r.width >= 28 && r.width <= 90 && r.height >= 28 && r.height <= 60)) return false;
      const cs = getComputedStyle(b);
      return parseFloat(cs.borderRadius) >= 12 && cs.backgroundColor !== "rgba(0, 0, 0, 0)"; // 둥글고 배경 있는 버튼만
    });
    if (btns.length < 3) return null;
    btns.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    // 가장 왼쪽 버튼의 '가장 바깥' 버튼 요소(부모도 같은 버튼이면 부모)
    let first = btns[0];
    while (first.parentElement && btns.includes(first.parentElement)) first = first.parentElement;
    return first;
  }
  let mounted = false, anchorEl = null, trackRaf = null;
  function mountFab() {
    const existing = getFab();
    if (existing && mounted && document.contains(existing) && anchorEl && document.contains(anchorEl)) return true;
    const fab = existing || Object.assign(document.createElement("button"), { id: "ec-fab", type: "button", title: "Connect" });
    if (!fab.parentElement) root.appendChild(fab);
    const first = findFileButton();
    if (first) {
      anchorEl = first;
      const cs = getComputedStyle(first);
      fab.className = "ec-toolbar-fab" + (fab.classList.contains("live") ? " live" : "");
      fab.innerHTML = `<span class="ec-fab-text">CONNECT</span>`;
      for (const k of ["borderRadius", "backgroundColor", "border", "boxShadow"]) fab.style[k] = cs[k];
      root.classList.add("ec-in-toolbar"); mounted = true;
      trackFab();
      return true;
    }
    fab.className = "ec-floating"; fab.innerHTML = `<span class="ec-fab-text">CONNECT</span>`;
    root.classList.remove("ec-in-toolbar"); anchorEl = null;
    return false;
  }
  // 파일 버튼 왼쪽, 같은 Y·같은 높이로 계속 따라붙음 (문서 흐름에 끼지 않아 레이아웃을 밀지 않음)
  function trackFab() {
    cancelAnimationFrame(trackRaf);
    const step = () => {
      const fab = getFab();
      if (!fab || !anchorEl || !document.contains(anchorEl)) { mounted = false; return; }
      const r = anchorEl.getBoundingClientRect();
      if (r.width && r.height) {
        fab.style.position = "fixed";
        fab.style.top = `${r.top}px`;
        fab.style.height = `${r.height}px`;
        fab.style.left = `${r.left - fab.offsetWidth - 8}px`;
        fab.style.zIndex = "2147483000";
        fab.style.visibility = "visible";
      } else fab.style.visibility = "hidden";
      trackRaf = requestAnimationFrame(step);
    };
    step();
  }
  function placePanel() {
    const panel = $("#ec-panel"), fab = getFab();
    if (!fab || !root.classList.contains("ec-in-toolbar")) { panel.style.cssText = ""; return; }
    const r = fab.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.left = `${Math.max(8, Math.round(r.left))}px`;
    panel.style.right = "auto"; panel.style.bottom = "auto";
    panel.style.maxHeight = `calc(100vh - ${Math.round(r.bottom + 24)}px)`;
  }
  document.addEventListener("click", e => {
    if (!e.target.closest("#ec-fab")) return;
    e.preventDefault(); e.stopPropagation();
    const p = $("#ec-panel"); p.hidden = !p.hidden;
    if (!p.hidden) { renderAll(); placePanel(); }
  }, true);
  // 툴바가 늦게 그려질 수 있으니 재시도 + 사라지면 다시 심기 (중복 생성 금지)
  let fabTries = 0;
  const fabTimer = setInterval(() => { if (mountFab() || ++fabTries > 15) clearInterval(fabTimer); }, 1000);
  let remountT = null;
  new MutationObserver(() => {
    const f = getFab();
    if (f && document.contains(f)) return;
    clearTimeout(remountT);
    remountT = setTimeout(() => { const g = getFab(); if (!g || !document.contains(g)) { g?.remove(); mounted = false; mountFab(); } }, 500);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", placePanel);
  $("#ec-close").addEventListener("click", () => $("#ec-panel").hidden = true);
  $$(".ec-tabs button").forEach(b => b.addEventListener("click", () => {
    $$(".ec-tabs button").forEach(x => x.classList.toggle("on", x === b));
    $$(".ec-body > section").forEach(s => s.classList.toggle("on", s.dataset.tab === b.dataset.tab));
    if (b.dataset.tab === "chat") { unread = 0; $("#ec-badge-chat").textContent = ""; }
  }));
  // 패널 안 키 입력이 엔트리 단축키로 새지 않게
  root.addEventListener("keydown", e => e.stopPropagation());

  function toast(text, ms = 3500) {
    const t = document.createElement("div"); t.className = "ec-toast"; t.textContent = text;
    $("#ec-toasts").appendChild(t); setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
  }
  // 단계별 예상 진행률: 0 준비 → 15 서버 → 35 방 연결 → 45 작품 수신 시작 → 85 수신 완료 → 100 반영
  let loadingGuard = null, pct = 0, creep = null;
  function setPct(v) { pct = Math.max(pct, Math.min(100, v)); $("#ec-lbar-fill").style.width = pct + "%"; $("#ec-lbar-pct").textContent = Math.round(pct) + "%"; }
  function loading(show, sub = "", p = null) {
    const el = $("#ec-loading");
    if (show && el.hidden) { pct = 0; setPct(0); }
    el.hidden = !show; $("#ec-loading small").textContent = sub;
    if (p != null) setPct(p);
    clearTimeout(loadingGuard); clearInterval(creep);
    if (show) {
      // 다음 단계 신호가 늦으면 조금씩 기어가듯 올라가 '멈춘 느낌'을 줄임 (단계 상한 -3까지만)
      const cap = p != null ? p + 9 : pct + 9;
      creep = setInterval(() => { if (pct < cap) setPct(pct + 0.4); }, 200);
      loadingGuard = setTimeout(() => { el.hidden = true; toast("응답이 늦어 로딩을 닫았습니다. 다시 시도해 보세요", 5000); }, 30000);
    } else { setPct(100); }
  }

  // 익명이면 닉네임을 물어보고, 아니면 엔트리 닉네임 사용
  function askNickname() {
    return new Promise(res => {
      const box = $("#ec-namebox"), input = $("#ec-name-in");
      box.hidden = false; input.value = ""; setTimeout(() => input.focus(), 0);
      const done = v => { box.hidden = true; cleanup(); res(v); };
      const ok = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } done(v); };
      const cancel = () => done(null);
      const key = e => { if (e.key === "Enter") ok(); if (e.key === "Escape") cancel(); };
      function cleanup() { $("#ec-name-ok").removeEventListener("click", ok); $("#ec-name-cancel").removeEventListener("click", cancel); input.removeEventListener("keydown", key); }
      $("#ec-name-ok").addEventListener("click", ok); $("#ec-name-cancel").addEventListener("click", cancel); input.addEventListener("keydown", key);
    });
  }
  async function resolveName() {
    if (S.anonymous) return await askNickname();
    return (await bridge("nickname")) || "엔트리 사용자";
  }

  // ── 방 탭 ──
  function renderRoom() {
    const sec = $('section[data-tab="room"]');
    if (!S.role) {
      sec.innerHTML = `
        <label class="ec-switch"><input id="ec-anon" type="checkbox" ${S.anonymous ? "checked" : ""}><span class="ec-slider"></span><b>익명</b><small class="ec-muted">${S.anonymous ? "입장 전에 닉네임을 입력합니다" : "엔트리 닉네임으로 참여합니다"}</small></label>
        <h4>방 만들기 <span class="ec-muted">(작품 만들기에서만 가능)</span></h4>
        <input id="ec-r-name" type="text" placeholder="방 이름" maxlength="40" value="${esc(S.room.name)}">
        <label>최대 인원 <input id="ec-r-max" type="number" min="2" max="20" value="${S.room.max}"></label>
        <button id="ec-host" class="ec-primary">방 열기</button>
        <hr>
        <h4>초대 코드로 참여</h4>
        <input id="ec-j-code" type="text" placeholder="초대 코드" spellcheck="false">
        <button id="ec-join" class="ec-primary">참여하기</button>
        <p class="ec-muted">참여하면 지금 열려 있는 작품이 방장의 작품으로 바뀝니다. 저장 안 한 작업은 먼저 저장하세요.</p>
        <button id="ec-diag" class="ec-ghost-btn">연결 진단</button><pre id="ec-diag-out" class="ec-diag" hidden></pre>`;
      $("#ec-diag").addEventListener("click", async () => {
        const out = $("#ec-diag-out"); out.hidden = false; out.textContent = "확인 중…";
        const t0 = Date.now(); const st = await net("status");
        const ready = await bridge("ready"); const pid = await bridge("projectId");
        out.textContent = `오프스크린: ${st?.ok ? "응답함" : "실패 — " + (st?.error || "")} (${Date.now() - t0}ms)\nPeer: ${st?.id || "없음"} open=${st?.open} role=${st?.role || "-"} peers=${(st?.peers || []).length} hostOpen=${st?.hostOpen} 세션=${st?.sessions}\n엔트리 준비: ${ready}\n작품 id: ${pid || "(저장 안 됨)"}\n주소: ${location.pathname}`;
      });
      $("#ec-anon").addEventListener("change", e => { S.anonymous = e.target.checked; chrome.storage.local.set({ anonymous: S.anonymous }); renderRoom(); });
      $("#ec-host").addEventListener("click", hostRoom);
      $("#ec-join").addEventListener("click", () => joinRoom($("#ec-j-code").value.trim()));
      return;
    }
    const link = `https://playentry.org/ws/new#coop=${encodeURIComponent(S.code)}`;
    const members = Object.values(S.room.members);
    sec.innerHTML = `
      <h4>${esc(S.room.name || "방")} <span class="ec-muted">${members.length}/${S.room.max}명 · ${S.role === "host" ? "방장" : "참가자"}</span></h4>
      <p class="ec-muted">참가자는 새 작품 화면으로 들어와 방장의 작품 내용을 그대로 받습니다(엔트리가 남의 작품 주소는 열어 주지 않기 때문).</p>
      <label>초대 링크</label>
      <div class="ec-row"><input type="text" readonly value="${esc(link)}" id="ec-link"><button id="ec-copy-link">복사</button></div>
      <label>초대 코드</label>
      <div class="ec-row"><input type="text" readonly value="${esc(S.code)}" id="ec-code"><button id="ec-copy-code">복사</button></div>
      <ul class="ec-members">${members.map(m => `
        <li><span class="ec-swatch" style="background:${esc(m.cursor?.color || "#999")}"></span>
          <b>${esc(m.name)}</b>${m.id === S.room.hostId ? ' <em>방장</em>' : ""}${m.id === S.myId ? ' <em>나</em>' : ""}
          ${S.room.testing[m.id] ? ' <i class="ec-testing">테스트 중</i>' : ""}
          ${S.role === "host" && m.id !== S.myId ? `<button class="ec-icon ec-kick" data-id="${esc(m.id)}" title="내보내기">✕</button>` : ""}</li>`).join("")}</ul>
      <button id="ec-leave" class="ec-danger">${S.role === "host" ? "방 닫기" : "나가기"}</button>`;
    $("#ec-copy-link").addEventListener("click", () => navigator.clipboard.writeText(link).then(() => toast("초대 링크를 복사했습니다")));
    $("#ec-copy-code").addEventListener("click", () => navigator.clipboard.writeText(S.code).then(() => toast("초대 코드를 복사했습니다")));
    $("#ec-leave").addEventListener("click", leaveRoom);
    $$(".ec-kick").forEach(b => b.addEventListener("click", () => kick(b.dataset.id)));
  }

  // ── 채팅 ──
  let unread = 0;
  function renderChat() {
    const log = $("#ec-chat-log");
    log.innerHTML = S.room.chat.map(m => `<div class="ec-msg ${m.from === S.myId ? "me" : ""}"><b style="color:${esc(m.color || "#555")}">${esc(m.name)}</b><span>${esc(m.text)}</span><time>${new Date(m.ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time></div>`).join("");
    log.scrollTop = log.scrollHeight;
  }
  function sendChat() {
    const text = $("#ec-chat-in").value.trim(); if (!text || !S.role) return;
    $("#ec-chat-in").value = "";
    dispatch({ t: "chat", text });
  }
  $("#ec-chat-send").addEventListener("click", sendChat);
  $("#ec-chat-in").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

  // ── 계획(체크리스트) ──
  function renderPlan() {
    const list = S.room.checklist, done = list.filter(c => c.done).length;
    const sorted = [...list.filter(c => !c.done), ...list.filter(c => c.done)];
    $("#ec-plan-list").innerHTML = sorted.map(c => `
      <li class="${c.done ? "done" : ""}"><label><input type="checkbox" data-id="${esc(c.id)}" ${c.done ? "checked" : ""}> <span>${esc(c.text)}</span></label><small>${esc(c.by)}</small><button class="ec-icon ec-plan-del" data-id="${esc(c.id)}" title="삭제">✕</button></li>`).join("")
      || `<li class="ec-muted">아직 항목이 없습니다. 위에서 할 일을 추가하세요.</li>`;
    $("#ec-bar-fill").style.width = list.length ? `${Math.round(done / list.length * 100)}%` : "0%";
    $("#ec-progress-text").textContent = `${done} / ${list.length}` + (list.length && done === list.length ? " 완료 🎉" : "");
    $("#ec-plan-clear").hidden = done === 0;
    $$("#ec-plan-list input").forEach(i => i.addEventListener("change", () => dispatch({ t: "check-toggle", id: i.dataset.id })));
    $$(".ec-plan-del").forEach(b => b.addEventListener("click", () => dispatch({ t: "check-del", id: b.dataset.id })));
  }
  $("#ec-plan-clear").addEventListener("click", () => { if (confirm("완료된 항목을 모두 지울까요?")) dispatch({ t: "check-clear-done" }); });
  const addPlan = () => { const t = $("#ec-plan-in").value.trim(); if (!t || !S.role) return; $("#ec-plan-in").value = ""; dispatch({ t: "check-add", text: t }); };
  $("#ec-plan-add").addEventListener("click", addPlan);
  $("#ec-plan-in").addEventListener("keydown", e => { if (e.key === "Enter") addPlan(); });

  // ── 사진 ──
  function renderPhotos() {
    $("#ec-photo-grid").innerHTML = S.images.map(im => `
      <figure><img src="${im.dataUrl}" alt="${esc(im.name)}"><figcaption><span>${esc(im.name)}</span><small>${esc(im.by)}</small>
        <a href="${im.dataUrl}" download="${esc(im.name)}" class="ec-dl">다운로드</a></figcaption></figure>`).join("")
      || `<p class="ec-muted">공유된 사진이 없습니다.</p>`;
  }
  $("#ec-photo-in").addEventListener("change", async e => {
    for (const f of e.target.files) {
      if (!S.role) { toast("먼저 방에 참여하세요"); return; }
      const dataUrl = await shrinkImage(f, 1600, 4 * 1024 * 1024);
      if (!dataUrl) { toast(`${f.name}: 너무 큽니다`); continue; }
      dispatch({ t: "image", img: { id: uid(), name: f.name, dataUrl } });
    }
    e.target.value = "";
  });
  function shrinkImage(file, maxW, maxBytes) {
    return new Promise(res => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        let q = 0.9, out;
        do { out = c.toDataURL("image/jpeg", q); q -= 0.15; } while (out.length > maxBytes && q > 0.2);
        res(out.length > maxBytes ? null : out);
      };
      img.onerror = () => res(null);
      img.src = url;
    });
  }

  // ── 커서 디자인 ──
  const SHAPES = { arrow: "화살표", circle: "동그라미", ring: "링", hand: "손", star: "별", emoji: "이모지" };
  function renderCursorTab() {
    const c = S.me.cursor;
    $('section[data-tab="cursor"]').innerHTML = `
      <h4>내 커서 <span class="ec-muted">(상대방에게 보이는 모양)</span></h4>
      <div class="ec-preview">${cursorSVG(c, S.me.name || "나")}</div>
      <label>모양</label>
      <div class="ec-shapes">${Object.entries(SHAPES).map(([k, v]) => `<button data-shape="${k}" class="${c.shape === k ? "on" : ""}">${v}</button>`).join("")}</div>
      <label>색</label>
      <div class="ec-colors">${COLORS.map(col => `<button data-color="${col}" style="background:${col}" class="${c.color === col ? "on" : ""}"></button>`).join("")}
        <input type="color" id="ec-color-custom" value="${esc(c.color)}" title="직접 선택"></div>
      <label>이모지 <span class="ec-muted">(이모지 모양일 때)</span></label>
      <input id="ec-emoji" type="text" value="${esc(c.emoji)}" maxlength="4">`;
    const save = () => { chrome.storage.local.set({ cursor: S.me.cursor }); renderCursorTab(); if (S.role) dispatch({ t: "cursor-style", cursor: S.me.cursor }); };
    $$("[data-shape]").forEach(b => b.addEventListener("click", () => { S.me.cursor.shape = b.dataset.shape; save(); }));
    $$("[data-color]").forEach(b => b.addEventListener("click", () => { S.me.cursor.color = b.dataset.color; save(); }));
    $("#ec-color-custom").addEventListener("input", e => { S.me.cursor.color = e.target.value; save(); });
    $("#ec-emoji").addEventListener("change", e => { S.me.cursor.emoji = e.target.value || "🙂"; save(); });
  }
  function cursorSVG(c, name) {
    const col = esc(c.color || "#2e6ff2");
    let body;
    switch (c.shape) {
      case "circle": body = `<circle cx="12" cy="12" r="8" fill="${col}" stroke="#fff" stroke-width="2"/>`; break;
      case "ring": body = `<circle cx="12" cy="12" r="8" fill="none" stroke="${col}" stroke-width="4"/><circle cx="12" cy="12" r="2" fill="${col}"/>`; break;
      case "star": body = `<path d="M12 2l3 7h7l-5.5 4.5 2 7.5L12 17l-6.5 4 2-7.5L2 9h7z" fill="${col}" stroke="#fff" stroke-width="1.5"/>`; break;
      case "hand": return `<span class="ec-cur-emoji">✋</span><span class="ec-cur-name" style="background:${col}">${esc(name)}</span>`;
      case "emoji": return `<span class="ec-cur-emoji">${esc(c.emoji || "🙂")}</span><span class="ec-cur-name" style="background:${col}">${esc(name)}</span>`;
      default: body = `<path d="M4 2l16 9-7 1.5L9.5 20z" fill="${col}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`;
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24">${body}</svg><span class="ec-cur-name" style="background:${col}">${esc(name)}</span>`;
  }

  // ── 원격 커서 렌더 ──
  const cursorEls = new Map();
  function moveRemoteCursor(id, x, y) {
    const m = S.room.members[id]; if (!m || id === S.myId) return;
    let el = cursorEls.get(id);
    if (!el) { el = document.createElement("div"); el.className = "ec-cursor"; $("#ec-cursors").appendChild(el); cursorEls.set(id, el); el.dataset.style = ""; }
    const key = JSON.stringify([m.cursor, m.name]);
    if (el.dataset.style !== key) { el.innerHTML = cursorSVG(m.cursor || {}, m.name); el.dataset.style = key; }
    el.style.transform = `translate(${x * innerWidth}px, ${y * innerHeight}px)`;
    el.classList.add("show"); clearTimeout(el._hide); el._hide = setTimeout(() => el.classList.remove("show"), 4000);
  }
  function dropCursor(id) { cursorEls.get(id)?.remove(); cursorEls.delete(id); }
  let lastMove = 0;
  document.addEventListener("mousemove", e => {
    if (!S.role) return;
    const now = Date.now(); if (now - lastMove < 40) return; lastMove = now;
    dispatch({ t: "cursor", x: e.clientX / innerWidth, y: e.clientY / innerHeight }, true);
  }, { passive: true });

  // ── 테스트 중 배너 ──
  function renderTestBar() {
    const names = Object.entries(S.room.testing).filter(([, v]) => v).map(([id]) => S.room.members[id]?.name).filter(Boolean);
    const bar = $("#ec-testbar");
    bar.hidden = names.length === 0;
    bar.textContent = names.length ? `${names.join(", ")} 님이 테스트 중입니다.` : "";
  }
  onRun.push(running => { if (S.role) dispatch({ t: "run", running }); if (!running && S.role) { dirty = true; syncSoon(); } });

  function renderAll() { renderRoom(); renderChat(); renderPlan(); renderPhotos(); renderCursorTab(); renderTestBar(); $("#ec-sub").textContent = S.role ? (S.role === "host" ? "방장" : "참가 중") : ""; getFab()?.classList.toggle("live", !!S.role); }

  // ══════════════ 방 로직 ══════════════
  // 참가자 → 방장에게, 방장 → 자기 자신에게 적용 후 전파
  function dispatch(msg, relayOnly = false) {
    if (!S.role) return;
    if (S.role === "host") handleAsHost(msg, S.myId);
    else send(msg);
  }

  function broadcastState() {
    const state = { name: S.room.name, max: S.room.max, hostId: S.room.hostId, wsPath: S.room.wsPath, members: S.room.members, chat: S.room.chat.slice(-200), checklist: S.room.checklist, testing: S.room.testing };
    send({ t: "state", state }, "all");
  }

  async function handleAsHost(msg, from) {
    const m = S.room.members[from];
    switch (msg.t) {
      case "hello": {
        if (Object.keys(S.room.members).length >= S.room.max) { send({ t: "full" }, from); net("kick", { peer: from }); return; }
        S.room.members[from] = { id: from, name: msg.name || "참가자", cursor: msg.cursor || {} };
        const project = await bridge("export"); // JSON 문자열 (방장이 테스트 중이면 null → 정지 후 첫 편집 때 동기화)
        send({ t: "welcome", project, images: S.images, myId: from }, from);
        broadcastState(); toast(`${S.room.members[from].name} 님이 참여했습니다`); renderAll(); return;
      }
      case "cursor": {
        const others = Object.keys(S.room.members).filter(id => id !== from && id !== S.myId);
        if (others.length) send({ t: "cursor", id: from, x: msg.x, y: msg.y }, others);
        if (from !== S.myId) moveRemoteCursor(from, msg.x, msg.y);
        return;
      }
      case "cursor-style": if (m) { m.cursor = msg.cursor; broadcastState(); renderAll(); } return;
      case "chat": S.room.chat.push({ id: uid(), from, name: m?.name || "?", color: m?.cursor?.color, text: msg.text, ts: Date.now() }); broadcastState(); applyChatNotice(from); renderAll(); return;
      case "check-add": S.room.checklist.push({ id: uid(), text: msg.text, done: false, by: m?.name || "?" }); broadcastState(); renderAll(); return;
      case "check-toggle": { const c = S.room.checklist.find(c => c.id === msg.id); if (c) c.done = !c.done; broadcastState(); renderAll(); return; }
      case "check-del": S.room.checklist = S.room.checklist.filter(c => c.id !== msg.id); broadcastState(); renderAll(); return;
      case "check-clear-done": S.room.checklist = S.room.checklist.filter(c => !c.done); broadcastState(); renderAll(); return;
      case "image": { const img = { ...msg.img, by: m?.name || "?" }; S.images.push(img); if (S.images.length > 30) S.images.shift(); send({ t: "image-add", img }, "all"); renderPhotos(); return; }
      case "run": { const was = !!S.room.testing[from]; S.room.testing[from] = !!msg.running; if (msg.running && !was) toastAll(`${m?.name || "?"} 님이 테스트 중입니다.`); broadcastState(); renderTestBar(); renderRoom(); return; }
      case "project": {
        if (from !== S.myId) await applyRemoteProject(msg.data, msg.hash);
        const others = Object.keys(S.room.members).filter(id => id !== from && id !== S.myId);
        if (others.length) send({ t: "project", data: msg.data, hash: msg.hash }, others);
        return;
      }
    }
  }
  function toastAll(text) { toast(text); send({ t: "toast", text }, "all"); }
  function applyChatNotice(from) { if (from !== S.myId && !$('.ec-tabs button[data-tab="chat"]').classList.contains("on")) { unread++; $("#ec-badge-chat").textContent = unread; } }

  // 참가자 수신 처리
  async function handleAsGuest(msg) {
    switch (msg.t) {
      case "welcome": {
        welcomed = true;
        S.myId = msg.myId; S.images = msg.images || [];
        if (msg.project) { loading(true, "작품을 화면에 반영하는 중", 88); await applyRemoteProject(msg.project, hashOf(msg.project)); }
        else toast("방장이 테스트 중이라 작품은 정지 후 받아옵니다");
        loading(false); renderAll(); toast("방에 참여했습니다"); return;
      }
      case "state": {
        const prevTesting = S.room.testing;
        Object.assign(S.room, msg.state);
        for (const id of Object.keys(prevTesting)) if (!S.room.members[id]) dropCursor(id);
        applyChatNotice("remote"); renderAll(); return;
      }
      case "cursor": moveRemoteCursor(msg.id, msg.x, msg.y); return;
      case "image-add": S.images.push(msg.img); renderPhotos(); return;
      case "project": await applyRemoteProject(msg.data, msg.hash); return;
      case "toast": toast(msg.text); return;
      case "full": toast("방이 가득 찼습니다"); resetRoom(); return;
      case "closed": toast("방장이 방을 닫았습니다"); resetRoom(); return;
      case "kick": toast("방에서 내보내졌습니다"); resetRoom(); return;
    }
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.ch !== "net") return;
    if (msg.ev === "data") { S.role === "host" ? handleAsHost(msg.data, msg.from) : handleAsGuest(msg.data); }
    else if (msg.ev === "peer-close" && S.role === "host") {
      const name = S.room.members[msg.peer]?.name; delete S.room.members[msg.peer]; delete S.room.testing[msg.peer]; dropCursor(msg.peer);
      if (name) toast(`${name} 님이 나갔습니다`); broadcastState(); renderAll();
    }
    else if (msg.ev === "progress") { if (S.role === "guest" && !welcomed) loading(true, `방장의 작품을 받는 중 (${msg.got}/${msg.n})`, 45 + 40 * msg.got / msg.n); }
    else if (msg.ev === "host-close") { toast("방장과 연결이 끊겼습니다"); resetRoom(); }
    else if (msg.ev === "error") { console.warn("[Connect] peer error:", JSON.stringify(msg)); if (/unavailable-id/.test(msg.error)) toast("이미 사용 중인 코드입니다"); else if (/peer-unavailable/.test(msg.error)) { toast("방을 찾을 수 없습니다. 코드를 확인하세요"); loading(false); } else if (/network|server|socket/.test(msg.error)) toast("PeerJS 서버 연결 오류: " + msg.error, 5000); }
  });

  // ── 프로젝트 동기화 ──
  function hashOf(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ":" + s.length; }
  let queued = null; // 내가 테스트 중일 때 도착한 원격 변경은 정지 후 반영
  let queueNoticeShown = false;
  async function applyRemoteProject(data, hash) {
    if (await bridge("running")) {
      queued = { data, hash };
      if (!queueNoticeShown) { queueNoticeShown = true; toast("테스트 중이라 상대의 변경은 정지 후 반영됩니다"); }
      return;
    }
    S.applying = true;
    const ok = await bridge("load", data);
    S.lastHash = hash; S.lastAppliedAt = Date.now(); S.applying = false; dirty = false;
    if (ok === "running") { queued = { data, hash }; return; }
    if (!ok) toast("작품 반영에 실패했습니다");
  }
  async function flushQueued() {
    queueNoticeShown = false;
    if (!queued) return;
    const q = queued; queued = null;
    await sleep(300);
    await applyRemoteProject(q.data, q.hash);
  }
  // 편집이 있었을 때만(dirty) 내보내기 — 실행 중이거나 원격 반영 직후엔 보류
  let syncTimer = null;
  function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 400); }
  async function syncNow() {
    if (!S.role || !dirty || S.applying) return;
    if (Date.now() - S.lastAppliedAt < 1500) { syncSoon(); return; }
    if (await bridge("running")) return; // 정지되면 다시 dirty 신호가 옴
    const s = await bridge("export"); if (!s) return;
    dirty = false;
    const h = hashOf(s);
    if (h === S.lastHash) return;
    S.lastHash = h;
    dispatch({ t: "project", data: s, hash: h });
  }

  function describeErr(r) {
    const e = r?.error || "";
    if (/peer-unavailable/.test(e)) return "그 코드의 방이 없습니다 (코드 확인, 방장이 방을 열어 두었는지 확인)";
    if (/unavailable-id/.test(e)) return "이미 사용 중인 코드입니다. 다시 열어 보세요";
    if (/signaling-timeout|server-error|socket/.test(e)) return "PeerJS 서버(0.peerjs.com)에 접속하지 못했습니다. 네트워크/방화벽을 확인하세요";
    if (/timeout/.test(e)) return `방장 응답 없음 (ICE: ${r.ice || "?"}) — 양쪽 네트워크가 P2P를 막고 있을 수 있습니다`;
    if (/오프스크린/.test(e)) return e;
    return e || "알 수 없는 오류";
  }
  // ── 방 열기 / 참여 / 나가기 ──
  async function hostRoom() {
    if (!/^\/ws(\/|$)/.test(location.pathname)) { toast("작품 만들기 화면에서만 방을 열 수 있습니다"); return; }
    if (!(await bridge("export"))) { toast("작품 데이터를 읽지 못했습니다. 콘솔의 [Connect] 로그를 확인하세요"); return; }
    const name = $("#ec-r-name").value.trim() || "협업 방";
    const max = Math.min(20, Math.max(2, parseInt($("#ec-r-max").value) || 4));
    const nick = await resolveName(); if (!nick) return;
    const code = "ec-" + Math.random().toString(36).slice(2, 8);
    loading(true, "서버에 방을 등록하는 중", 20);
    const r = await net("host", { code });
    loading(false);
    if (!r?.ok) { toast("방을 열지 못했습니다: " + describeErr(r), 6000); console.warn("[Connect] host 실패:", JSON.stringify(r)); return; }
    S.role = "host"; S.code = code; S.myId = r.id; S.me.name = nick; bridge("autoConfirm", true);
    const pid = await bridge("projectId");
    S.room = { name, max, hostId: r.id, wsPath: pid ? `/ws/${pid}` : null, members: { [r.id]: { id: r.id, name: nick, cursor: S.me.cursor } }, chat: [], checklist: [], testing: {} };
    S.images = [];
    const p = await bridge("export"); if (p) S.lastHash = hashOf(p);
    renderAll(); toast("방을 열었습니다. 초대 링크를 공유하세요");
  }
  let welcomed = false;
  async function joinRoom(code, nick) {
    if (!code) { toast("초대 코드를 입력하세요"); return; }
    if (!nick) { nick = await resolveName(); if (!nick) return; }
    bridge("autoConfirm", true);
    loading(true, "서버에 연결하는 중", 5);
    // 엔트리 준비와 서버 연결을 동시에 진행
    const readyP = (async () => { for (let i = 0; i < 200 && !(await bridge("ready")); i++) await sleep(150); })();
    const r = await net("join", { code });
    if (!r?.ok) { loading(false); bridge("autoConfirm", false); toast("연결 실패: " + describeErr(r), 6000); console.warn("[Connect] join 실패:", JSON.stringify(r)); return; }
    loading(true, "방에 연결됨 · 엔트리 준비 중", 35);
    await readyP;
    S.role = "guest"; S.code = code; S.myId = r.id; S.me.name = nick;
    S.room.hostId = code;
    welcomed = false;
    send({ t: "hello", name: nick, cursor: S.me.cursor });
    loading(true, "방장의 작품을 기다리는 중", 45);
    setTimeout(async () => {
      if (S.role === "guest" && !welcomed) {
        const st = await net("status");
        loading(false);
        toast(`방장 응답이 없습니다 (연결 ${st?.hostOpen ? "열림" : "닫힘"}). 방장 화면이 켜져 있고 방이 열려 있는지 확인하세요`, 6000);
        console.warn("[Connect] welcome 없음:", JSON.stringify(st));
      }
    }, 20000);
  }
  async function leaveRoom() {
    if (S.role === "host") { send({ t: "closed" }, "all"); await sleep(200); }
    await net("leave"); resetRoom(); toast("방을 나갔습니다");
  }
  function kick(id) { send({ t: "kick" }, id); net("kick", { peer: id }); }
  function resetRoom() {
    net("leave"); bridge("autoConfirm", false);
    S.role = null; S.myId = null; S.code = null;
    S.room = { name: S.room.name, max: S.room.max, hostId: null, members: {}, chat: [], checklist: [], testing: {} };
    S.images = []; for (const id of [...cursorEls.keys()]) dropCursor(id);
    loading(false); renderAll();
  }

  // ── 초대 링크로 들어온 경우 ──
  let hm = location.hash.match(/coop=([^&]+)/);
  if (hm) sessionStorage.setItem("ecoop-invite", decodeURIComponent(hm[1]));
  const invite = sessionStorage.getItem("ecoop-invite");
  if (invite) {
    const code = invite; sessionStorage.removeItem("ecoop-invite");
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    loading(true, "초대 링크로 방에 연결하는 중");
    (async () => {
      await new Promise(r => chrome.storage.local.get("anonymous", v => { S.anonymous = !!v.anonymous; r(); }));
      const nick = await resolveName(); if (!nick) { toast("참여를 취소했습니다"); return; }
      loading(true, "엔트리 준비 중", 3); bridge("autoConfirm", true);
      for (let i = 0; i < 200 && !(await bridge("ready")); i++) await sleep(150);
      await joinRoom(code, nick);
      $("#ec-panel").hidden = false;
    })();
  }
  renderAll();
})();
