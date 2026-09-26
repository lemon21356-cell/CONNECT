// 탭(콘텐츠 스크립트) ↔ 오프스크린(PeerJS) 중계 — 탭마다 독립 세션
let creating = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  const ctxs = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).catch(() => null);
  return !!(ctxs && ctxs.length);
}
async function pingOffscreen() {
  try { const r = await chrome.runtime.sendMessage({ ch: "bg->net", cmd: "ping" }); return !!r?.ok; } catch { return false; }
}
async function ensureOffscreen() {
  if (await pingOffscreen()) return;
  if (!(await hasOffscreen())) {
    if (!creating) creating = chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["WEB_RTC"], justification: "PeerJS WebRTC connections for real-time collaboration"
    }).catch(e => { if (!/single offscreen|already/i.test(String(e))) throw e; }).finally(() => creating = null);
    await creating;
  }
  for (let i = 0; i < 25; i++) { if (await pingOffscreen()) return; await sleep(200); }
  throw new Error("오프스크린 문서가 응답하지 않습니다");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.ch) return;
  if (msg.ch === "tab->net") {
    const tabId = sender.tab?.id;
    if (tabId == null) { sendResponse({ ok: false, error: "탭 정보 없음" }); return; }
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ ...msg, ch: "bg->net", tabId }))
      .then(r => sendResponse(r ?? { ok: false, error: "no response" }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.ch === "net->tab") {
    if (msg.tabId != null) chrome.tabs.sendMessage(msg.tabId, { ...msg, ch: "net" }).catch(() => {});
    return;
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.runtime.sendMessage({ ch: "bg->net", cmd: "leave", tabId }).catch(() => {});
});
