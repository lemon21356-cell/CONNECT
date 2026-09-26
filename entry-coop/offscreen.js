// PeerJS 허브 — 탭(세션)마다 독립된 Peer. 방장: 참가자들과 직접 연결 / 참가자: 방장하고만 연결
const sessions = new Map(); // tabId → { peer, role, conns: Map, hostConn }
const toTab = (tabId, msg) => chrome.runtime.sendMessage({ ch: "net->tab", tabId, ...msg }).catch(() => {});

const PEER_OPTS = {
  debug: 1,
  config: { iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: "stun:openrelay.metered.ca:80" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
  ] }
};

function destroy(tabId) {
  const s = sessions.get(tabId); if (!s) return;
  try { s.peer?.destroy(); } catch {}
  sessions.delete(tabId);
}

function makePeer(tabId, id) {
  return new Promise((resolve, reject) => {
    let done = false;
    const p = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    p.on("open", () => { done = true; resolve(p); });
    p.on("error", e => {
      const type = e?.type || String(e);
      toTab(tabId, { ev: "error", error: type, detail: String(e?.message || e) });
      if (!done) { done = true; reject(new Error(type)); }
    });
    p.on("disconnected", () => { try { if (!p.destroyed) p.reconnect(); } catch {} });
    setTimeout(() => { if (!done) { done = true; reject(new Error("signaling-timeout")); } }, 12000);
  });
}

async function host(tabId, code) {
  destroy(tabId);
  const peer = await makePeer(tabId, code);
  const s = { peer, role: "host", conns: new Map(), hostConn: null };
  sessions.set(tabId, s);
  peer.on("connection", c => {
    c.on("open", () => { s.conns.set(c.peer, c); toTab(tabId, { ev: "peer-open", peer: c.peer }); });
    c.on("data", d => receive(d, data => toTab(tabId, { ev: "data", from: c.peer, data })));
    c.on("close", () => { s.conns.delete(c.peer); toTab(tabId, { ev: "peer-close", peer: c.peer }); });
    c.on("error", () => { s.conns.delete(c.peer); toTab(tabId, { ev: "peer-close", peer: c.peer }); });
  });
  return { ok: true, id: peer.id };
}

async function join(tabId, code) {
  destroy(tabId);
  const peer = await makePeer(tabId);
  const s = { peer, role: "guest", conns: new Map(), hostConn: null };
  sessions.set(tabId, s);
  return new Promise((resolve) => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const c = peer.connect(code, { reliable: true });
    peer.on("error", e => { if (/peer-unavailable/.test(e?.type)) finish({ ok: false, error: "peer-unavailable" }); });
    c.on("open", () => { s.hostConn = c; toTab(tabId, { ev: "joined", id: peer.id }); finish({ ok: true, id: peer.id }); });
    c.on("data", d => receive(d, data => toTab(tabId, { ev: "data", from: c.peer, data }), (got, n) => toTab(tabId, { ev: "progress", got, n })));
    c.on("close", () => { s.hostConn = null; toTab(tabId, { ev: "host-close" }); });
    c.on("error", e => finish({ ok: false, error: String(e?.type || e?.message || e) }));
    setTimeout(() => finish({ ok: false, error: "timeout", ice: c.peerConnection?.iceConnectionState || null }), 20000);
  });
}

// 큰 메시지는 조각내서 보냄 (수신 측에서 조립)
const CHUNK = 60000;
function sendOn(c, data) {
  const str = JSON.stringify(data);
  if (str.length <= CHUNK) { c.send({ __ec: 1, s: str }); return; }
  const id = Math.random().toString(36).slice(2);
  const n = Math.ceil(str.length / CHUNK);
  for (let i = 0; i < n; i++) c.send({ __ec: 2, id, i, n, s: str.slice(i * CHUNK, (i + 1) * CHUNK) });
}
const parts = new Map();
function receive(raw, cb, onProgress) {
  if (!raw || typeof raw !== "object") return;
  if (raw.__ec === 1) { try { cb(JSON.parse(raw.s)); } catch {} return; }
  if (raw.__ec === 2) {
    let p = parts.get(raw.id); if (!p) { p = { n: raw.n, got: 0, arr: new Array(raw.n), t: Date.now() }; parts.set(raw.id, p); }
    if (!p.arr[raw.i]) { p.arr[raw.i] = raw.s; p.got++; onProgress?.(p.got, p.n); }
    if (p.got === p.n) { parts.delete(raw.id); try { cb(JSON.parse(p.arr.join(""))); } catch {} }
    return;
  }
  cb(raw); // 구버전 호환
}
setInterval(() => { const now = Date.now(); for (const [k, p] of parts) if (now - p.t > 60000) parts.delete(k); }, 30000);

function send(tabId, to, data) {
  const s = sessions.get(tabId); if (!s) return false;
  if (s.role === "host") {
    if (to === "all" || to == null) for (const c of s.conns.values()) c.open && sendOn(c, data);
    else if (Array.isArray(to)) to.forEach(id => { const c = s.conns.get(id); c?.open && sendOn(c, data); });
    else { const c = s.conns.get(to); c?.open && sendOn(c, data); }
    return true;
  }
  if (s.hostConn?.open) { sendOn(s.hostConn, data); return true; }
  return false;
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.ch !== "bg->net") return;
  (async () => {
    const t = msg.tabId;
    switch (msg.cmd) {
      case "ping": return { ok: true };
      case "host": return host(t, msg.code);
      case "join": return join(t, msg.code);
      case "send": return { ok: send(t, msg.to, msg.data) };
      case "kick": { const s = sessions.get(t); const c = s?.conns.get(msg.peer); c?.close(); s?.conns.delete(msg.peer); return { ok: true }; }
      case "leave": destroy(t); return { ok: true };
      case "status": { const s = sessions.get(t); return { ok: true, role: s?.role || null, id: s?.peer?.id || null, open: !!s?.peer?.open, peers: s ? [...s.conns.keys()] : [], hostOpen: !!s?.hostConn?.open, sessions: sessions.size }; }
      default: return { ok: false, error: "unknown" };
    }
  })().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
