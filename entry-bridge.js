// (MAIN world) 엔트리 워크스페이스 API에 접근해 프로젝트 내보내기/불러오기, 실행 상태를 알린다.
(() => {
  const TAG = "ECOOP";
  const post = (m) => window.postMessage({ __ecoop: true, ...m }, "*");
  const E = () => (typeof Entry !== "undefined" && Entry) ? Entry : null;
  const ready = () => { try { const e = E(); return !!(e && e.container && e.playground); } catch { return false; } };

  function exportProject() {
    try {
      const p = Entry.exportProject();
      // 함수·순환 참조 제거: postMessage로 복제 가능한 순수 JSON 문자열로
      const seen = new WeakSet();
      return JSON.stringify(p, (k, v) => {
        if (typeof v === "function" || typeof v === "symbol") return undefined;
        if (v && typeof v === "object") { if (seen.has(v)) return undefined; seen.add(v); }
        return v;
      });
    } catch (e) { console.warn("[Connect] export 실패:", e && e.message || e); return null; }
  }
  function loadProject(data) {
    try {
      const project = typeof data === "string" ? JSON.parse(data) : data;
      Entry.clearProject();
      Entry.loadProject(project);
      return true;
    } catch (e) { console.warn("[Connect] loadProject 실패:", e && e.message || e); return false; }
  }

  const isRunning = () => { try { const e = E(); return !!(e && e.engine && e.engine.isState && e.engine.isState("run")); } catch { return false; } };

  // 편집 감지: 엔트리의 모든 편집은 Entry.do(명령)를 거치므로 그걸 감싸서 '변경됨' 신호만 보낸다 (직렬화 없음)
  let dirtyTimer = null;
  function markDirty() {
    if (isRunning()) return;
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => post({ type: "dirty" }), 900); // 연속 편집은 묶어서 한 번만
  }
  function hookChanges() {
    try { if (!ready() || typeof Entry.do !== "function") return setTimeout(hookChanges, 500); } catch { return setTimeout(hookChanges, 500); }
    if (Entry.__ecoopHooked) return;
    Entry.__ecoopHooked = true;
    const odo = Entry.do;
    Entry.do = function () { const r = odo.apply(this, arguments); markDirty(); return r; };
    for (const ev of ["entryBlocklyChanged", "blockChanged", "changeLanguage", "loadComplete"]) {
      try { Entry.addEventListener(ev, () => { if (ev !== "loadComplete") markDirty(); }); } catch {}
    }
    // 실행 취소/다시 실행도 do를 거치지 않을 수 있어 별도 훅
    try {
      const sm = Entry.stateManager;
      if (sm) for (const fn of ["undo", "redo"]) { const o = sm[fn]; if (typeof o === "function") sm[fn] = function () { const r = o.apply(this, arguments); markDirty(); return r; }; }
    } catch {}
  }
  hookChanges();

  // 실행(테스트) 상태 감지
  let lastRun = false;
  function watchRun() {
    try { if (!ready()) return setTimeout(watchRun, 500); } catch { return setTimeout(watchRun, 500); }
    try {
      Entry.addEventListener("run", () => post({ type: "run", running: true }));
      Entry.addEventListener("stop", () => post({ type: "run", running: false }));
    } catch {}
    setInterval(() => {
      try {
        const r = isRunning();
        if (r !== lastRun) { lastRun = r; post({ type: "run", running: r }); }
      } catch {}
    }, 500);
    post({ type: "ready" });
  }
  watchRun();

  // ── '저장되지 않은 작품' 류 경고 자동 처리 (방 참여/활동 중에만 켬) ──
  let autoConfirm = false;
  const SAVE_RE = /저장되지 않|저장하지 않|unsaved|leave|나가시겠|이동하시겠/i;
  const oConfirm = window.confirm;
  window.confirm = function (msg) { if (autoConfirm && SAVE_RE.test(String(msg))) return true; return oConfirm.apply(this, arguments); };
  window.addEventListener("beforeunload", e => { if (autoConfirm) { e.stopImmediatePropagation(); } }, true);
  Object.defineProperty(window, "onbeforeunload", { configurable: true, get() { return null; }, set(fn) { if (!autoConfirm && typeof fn === "function") window.addEventListener("beforeunload", fn); } });
  // 사이트 자체 모달(저장되지 않은 작품 …)의 확인 버튼 자동 클릭
  new MutationObserver(() => {
    if (!autoConfirm) return;
    for (const el of document.querySelectorAll("div, section, p, span")) {
      if (el.children.length > 12 || !SAVE_RE.test(el.textContent || "")) continue;
      const box = el.closest("[class*=modal], [class*=popup], [class*=dialog], [role=dialog]") || el.parentElement;
      const btn = box && [...box.querySelectorAll("button, a")].find(b => /^\s*(확인|예|이동|네|계속|나가기|OK)\s*$/i.test(b.textContent || ""));
      if (btn) { btn.click(); break; }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("message", ev => {
    if (ev.source !== window || !ev.data?.__ecoop_req) return;
    const { id, cmd, data } = ev.data;
    let result = null;
    try {
      if (cmd === "export") result = ready() && !isRunning() ? exportProject() : null;        // 실행 중엔 내보내지 않음 (JSON 문자열)
      else if (cmd === "load") result = !ready() ? false : isRunning() ? "running" : loadProject(data);
      else if (cmd === "ready") result = ready();
      else if (cmd === "running") result = isRunning();
      else if (cmd === "autoConfirm") { autoConfirm = !!data; result = autoConfirm; }
      else if (cmd === "projectId") { const m = location.pathname.match(/^\/ws\/([0-9a-f]{24})/); result = m ? m[1] : null; }
      else if (cmd === "nickname") {
        const nd = document.getElementById("__NEXT_DATA__");
        const m = (nd ? nd.textContent : "").match(/"nickname":"([^"]+)"/);
        result = m ? m[1] : null;
      }
    } catch (e) { console.warn("[Connect] 명령 실패:", cmd, e && e.message || e); result = null; }
    // 항상 복제 가능한 값만 보냄
    if (result !== null && typeof result === "object") { try { result = JSON.parse(JSON.stringify(result)); } catch { result = null; } }
    try { post({ type: "res", id, result }); }
    catch (e) { console.warn("[Connect] 응답 전송 실패:", cmd, e && e.message || e); post({ type: "res", id, result: null }); }
  });
})();
