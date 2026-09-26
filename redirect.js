// 어떤 엔트리 페이지든 #coop=코드 가 붙어 있으면 새 작품 화면으로 보내 방장 작품을 받아온다
(() => {
  const m = location.hash.match(/coop=([^&]+)/);
  if (!m) return;
  const code = decodeURIComponent(m[1]);
  sessionStorage.setItem("ecoop-invite", code);
  if (!/^\/ws\/new\/?$/.test(location.pathname)) location.replace("https://playentry.org/ws/new#coop=" + encodeURIComponent(code));
})();
