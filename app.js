'use strict';
/* =========================================================
 * やまみちナビ — フロントエンド (Vanilla JS)
 * GitHub Pages: 下の GAS_URL にウェブアプリのURLを設定
 * GAS単体ホスト: google.script.run を自動で使うため設定不要
 * ========================================================= */
const CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbz6kEa1yq5mWUIp6LLH3o7dCh-YKXFNfxddb6ySORFAOMKvQh3Qrl8B2q4FWjkxs5Ez/exec',
  CENTER: [35.625, 139.243],   // 初期表示（高尾山周辺）
  ZOOM: 12,
  MAX_POINTS: 4000,            // 保存時の最大地点数（超えたら間引く）
  REC_MIN_MOVE_M: 5,           // 記録: この距離未満の移動は無視
  REC_MAX_ACCURACY_M: 40,      // 記録: 精度がこれより悪い測位は無視
};

const ROUTE_COLOR = '#C2185B';
const REC_COLOR = '#1565C0';
const CATS = {
  camp: { label: 'キャンプ場', icon: '⛺' },
  michinoeki: { label: '道の駅', icon: '🚏' },
  onsen: { label: '温泉', icon: '♨️' },
  shop: { label: '買い物', icon: '🛒' },
  view: { label: '景色の良い場所', icon: '🏞️' },
  food: { label: 'おすすめ飲食店', icon: '🍽️' },
  souvenir: { label: '名物・お土産', icon: '🎁' },
};
const TAGS = ['平坦', '車少なめ', '狭い道', '歩道・遊歩道中心', '階段あり', '展望よし'];
const VIS = { private: '非公開', members: '会員限定', public: '公開' };
const SRC = { record: 'GPS記録', gpx: 'GPX', photo: '写真から作成', plan: '経路探索', manual: '手入力', import: '取り込み' };

/* ---------- 保存領域 ---------- */
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量超過などは無視 */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } },
};

const state = {
  token: store.get('ymn_token'),
  user: store.get('ymn_user'),
  config: { geminiEnabled: false, orsEnabled: false },
  current: null,        // 表示中の保存済みルート（getRoute の結果）
  draft: null,          // 未保存のルート
  active: null,         // スポット検索・分析の対象 { points, title }
  spotResults: [],
  plan: { points: [], candidates: [], selected: -1 },
  importResult: null,
  importNote: '',
  pickMode: null,       // 'plan' | 'spot'
  editingSpot: null,
  saveMode: 'new',
  photoFiles: [],
};

/* ---------- DOM ヘルパー ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
}
async function guard(fn, text) {
  try {
    if (text) busy(text);
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || 'エラーが発生しました', 5000);
  } finally {
    if (text) busy(false);
  }
}

/* ---------- 書式 ---------- */
const fmtKmNum = (m) => (m == null ? '--' : (m / 1000).toFixed(m < 10000 ? 2 : 1));
const fmtM = (m) => (m == null || !isFinite(m) ? '--' : Math.round(m).toLocaleString('ja-JP'));
function fmtDur(sec) {
  if (!sec) return '--';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}時間${m}分` : `${m}分`;
}
function fmtClock(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function statsHtml(s) {
  const item = (k, v, u) => `<div><dt>${k}</dt><dd>${v}${v !== '--' && u ? `<small>${u}</small>` : ''}</dd></div>`;
  return `<dl class="stats">
    ${item('距離', fmtKmNum(s.distanceM), 'km')}
    ${item('登り', fmtM(s.gainM), 'm')}
    ${item('下り', fmtM(s.lossM), 'm')}
    ${item('最高点', fmtM(s.maxEle), 'm')}
    ${item('時間', fmtDur(s.durationSec), '')}
  </dl>`;
}

/* =========================================================
 * API
 * ========================================================= */
async function api(action, data = {}) {
  const payload = { action, token: state.token, ...data };
  let res;
  if (window.google && google.script && google.script.run) {
    res = await new Promise((ok, ng) => google.script.run
      .withSuccessHandler((s) => ok(JSON.parse(s)))
      .withFailureHandler(ng)
      .apiRun(JSON.stringify(payload)));
  } else {
    if (CONFIG.GAS_URL.includes('ここに')) throw new Error('app.js の GAS_URL にウェブアプリのURLを設定してください');
    const r = await fetch(CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`通信エラー（${r.status}）`);
    res = await r.json();
  }
  if (!res.ok) {
    if (res.code === 'AUTH' && state.token) {
      setSession(null, null);
      res.error = 'ログインの有効期限が切れました。もう一度ログインしてください';
    }
    if (res.code === 'MUST_CHANGE') openAuth('change', true);
    const e = new Error(res.error || 'エラーが発生しました');
    e.code = res.code;
    throw e;
  }
  return res.data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  if (token) { store.set('ymn_token', token); store.set('ymn_user', user); }
  else { store.del('ymn_token'); store.del('ymn_user'); }
  updateAccountButton();
}
function updateAccountButton() {
  $('#account-btn').textContent = state.user ? `${state.user.nickname} さん` : 'ログイン';
}
function requireLogin() {
  if (state.user) return true;
  openAuth('login');
  toast('この操作にはログインが必要です');
  return false;
}

/* =========================================================
 * 地理計算
 * ========================================================= */
const toRad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const R = 6371008.8;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function cumDist(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
  return c;
}
const hasEle = (p) => p.ele != null && isFinite(p.ele);

function computeStats(pts, thr = 3) {
  let d = 0, gain = 0, loss = 0, maxE = null, minE = null, lastE = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    if (i) d += dist(pts[i - 1], a);
    if (hasEle(a)) {
      maxE = maxE == null ? a.ele : Math.max(maxE, a.ele);
      minE = minE == null ? a.ele : Math.min(minE, a.ele);
      if (lastE == null) lastE = a.ele;
      else if (a.ele - lastE >= thr) { gain += a.ele - lastE; lastE = a.ele; }
      else if (lastE - a.ele >= thr) { loss += lastE - a.ele; lastE = a.ele; }
    }
  }
  const t0 = pts.length ? Date.parse(pts[0].time) : NaN;
  const t1 = pts.length ? Date.parse(pts[pts.length - 1].time) : NaN;
  return {
    distanceM: d, gainM: gain, lossM: loss, maxEle: maxE, minEle: minE,
    durationSec: isFinite(t0) && isFinite(t1) ? Math.max(0, (t1 - t0) / 1000) : 0,
  };
}

function projector(lat0) {
  const kx = 111320 * Math.cos(toRad(lat0)), ky = 110540;
  return (p) => ({ x: p.lng * kx, y: p.lat * ky });
}
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y), t, len: Math.sqrt(L2) };
}
function prepLine(pts) {
  const pr = projector(pts[0].lat);
  return { pr, xy: pts.map(pr), cum: cumDist(pts) };
}
function nearestOnLine(pt, line) {
  const q = line.pr(pt);
  let best = { d: Infinity, along: 0 };
  if (line.xy.length === 1) return { d: Math.hypot(q.x - line.xy[0].x, q.y - line.xy[0].y), along: 0 };
  for (let i = 0; i < line.xy.length - 1; i++) {
    const r = segDist(q, line.xy[i], line.xy[i + 1]);
    if (r.d < best.d) best = { d: r.d, along: line.cum[i] + r.t * (line.cum[i + 1] - line.cum[i]) };
  }
  return best;
}

/** Ramer–Douglas–Peucker（反復版） */
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const pr = projector(pts[0].lat);
  const xy = pts.map(pr);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(xy[i], xy[s], xy[e]).d;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplify(pts, max = CONFIG.MAX_POINTS) {
  if (pts.length <= max) return pts;
  let eps = 2, out = pts;
  while (out.length > max && eps < 500) { out = rdp(pts, eps); eps *= 1.6; }
  return out;
}
function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc >= step) { out.push(pts[i]); acc = 0; }
  }
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}
function interpolate(a, b, step) {
  const n = Math.floor(dist(a, b) / step);
  const ta = a.time ? Date.parse(a.time) : NaN, tb = b.time ? Date.parse(b.time) : NaN;
  const out = [];
  for (let k = 1; k < n; k++) {
    const t = k / n;
    out.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      ele: hasEle(a) && hasEle(b) ? a.ele + (b.ele - a.ele) * t : null,
      time: isFinite(ta) && isFinite(tb) ? new Date(ta + (tb - ta) * t).toISOString() : null,
    });
  }
  return out;
}
function boundsOf(pts, pad = 0) {
  let s = 90, n = -90, w = 180, e = -180;
  pts.forEach((p) => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); });
  return { s: s - pad, n: n + pad, w: w - pad, e: e + pad };
}

/** 標高の欠けている地点を Open-Meteo の標高APIで補完 */
async function fillElevation(pts) {
  const idx = [];
  pts.forEach((p, i) => { if (!hasEle(p)) idx.push(i); });
  if (!idx.length) return 0;
  let target = idx;
  if (idx.length > 1500) {
    const step = Math.ceil(idx.length / 1500);
    target = idx.filter((_, k) => k % step === 0 || k === idx.length - 1);
  }
  for (let k = 0; k < target.length; k += 100) {
    const chunk = target.slice(k, k + 100);
    const lat = chunk.map((i) => pts[i].lat.toFixed(5)).join(',');
    const lng = chunk.map((i) => pts[i].lng.toFixed(5)).join(',');
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
    if (!r.ok) throw new Error('標高データを取得できませんでした');
    const j = await r.json();
    chunk.forEach((i, n) => { if (isFinite(j.elevation?.[n])) pts[i].ele = j.elevation[n]; });
    if (k + 100 < target.length) await sleep(250);
  }
  // 残りの欠損は前後の値から直線補間
  let prev = -1;
  for (let i = 0; i < pts.length; i++) {
    if (!hasEle(pts[i])) continue;
    if (prev >= 0 && i - prev > 1) {
      for (let k = prev + 1; k < i; k++) pts[k].ele = pts[prev].ele + (pts[i].ele - pts[prev].ele) * ((k - prev) / (i - prev));
    } else if (prev < 0) {
      for (let k = 0; k < i; k++) pts[k].ele = pts[i].ele;
    }
    prev = i;
  }
  if (prev >= 0) for (let k = prev + 1; k < pts.length; k++) pts[k].ele = pts[prev].ele;
  return target.length;
}

/* =========================================================
 * GPX
 * ========================================================= */
function buildGpx(name, pts, desc = '') {
  const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const seg = pts.map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">${hasEle(p) ? `<ele>${Math.round(p.ele * 10) / 10}</ele>` : ''}${p.time ? `<time>${x(p.time)}</time>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="やまみちナビ" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${x(name)}</name>${desc ? `<desc>${x(desc)}</desc>` : ''}<time>${new Date().toISOString()}</time></metadata>
  <trk><name>${x(name)}</name>
    <trkseg>
${seg}
    </trkseg>
  </trk>
</gpx>
`;
}
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('GPXファイルを読み込めませんでした');
  const get = (tag) => [...doc.getElementsByTagNameNS('*', tag)];
  let nodes = get('trkpt');
  if (!nodes.length) nodes = get('rtept');
  if (!nodes.length) nodes = get('wpt');
  const child = (n, tag) => n.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() || null;
  const pts = nodes.map((n) => {
    const ele = child(n, 'ele');
    return { lat: parseFloat(n.getAttribute('lat')), lng: parseFloat(n.getAttribute('lon')), ele: ele == null ? null : parseFloat(ele), time: child(n, 'time') };
  }).filter((p) => isFinite(p.lat) && isFinite(p.lng));
  const nameNode = get('name')[0];
  return { name: nameNode ? nameNode.textContent.trim() : '', pts };
}
function download(name, text, type = 'application/gpx+xml') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const safeName = (s) => (s || 'route').replace(/[\\/:*?"<>|]/g, '_');

/* =========================================================
 * 地図
 * ========================================================= */
const map = L.map('map', { zoomControl: false }).setView(CONFIG.CENTER, CONFIG.ZOOM);
const gsiAttr = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const baseLayers = {
  '地理院 標準': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { maxZoom: 18, attribution: gsiAttr }),
  '地理院 淡色': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18, attribution: gsiAttr }),
  '地理院 写真': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { maxZoom: 18, attribution: gsiAttr }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
  'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)' }),
};
baseLayers['地理院 標準'].addTo(map);
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'topright' }).addTo(map);

const layers = {
  list: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  photos: L.layerGroup().addTo(map),
  plan: L.layerGroup().addTo(map),
  imp: L.layerGroup().addTo(map),
  spots: L.layerGroup().addTo(map),
  rec: L.layerGroup().addTo(map),
  me: L.layerGroup().addTo(map),
};

const sheetHeight = () => (window.innerWidth >= 900 ? 0 : $('#sheet').getBoundingClientRect().height);
function fitTo(latlngs) {
  if (!latlngs.length) return;
  const leftPad = window.innerWidth >= 900 ? 420 : 20;
  map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [leftPad, 20], paddingBottomRight: [20, sheetHeight() + 20], maxZoom: 16 });
}
function drawTrack(layer, pts, color, fit = true) {
  layer.clearLayers();
  if (!pts.length) return;
  const ll = pts.map((p) => [p.lat, p.lng]);
  L.polyline(ll, { color: '#fff', weight: 8, opacity: 0.85 }).addTo(layer);
  L.polyline(ll, { color, weight: 4.5, opacity: 1 }).addTo(layer);
  L.circleMarker(ll[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#2E7D32', fillOpacity: 1 }).bindTooltip('スタート').addTo(layer);
  L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#1C2420', fillOpacity: 1 }).bindTooltip('ゴール').addTo(layer);
  if (fit) fitTo(ll);
}
function setActive(points, title) {
  state.active = points && points.length ? { points, title } : null;
  $('#spot-target').textContent = state.active ? `対象のルート: ${title}` : 'ルートを表示すると、その沿道を探せます';
}
function showMe(lat, lng, acc) {
  layers.me.clearLayers();
  if (acc) L.circle([lat, lng], { radius: acc, color: REC_COLOR, weight: 1, fillOpacity: 0.08 }).addTo(layers.me);
  L.marker([lat, lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(layers.me);
}
function getPosition() {
  return new Promise((ok, ng) => {
    if (!navigator.geolocation) return ng(new Error('この端末では位置情報を使えません'));
    navigator.geolocation.getCurrentPosition(ok, (e) => ng(new Error('現在地を取得できませんでした: ' + e.message)), { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  });
}

map.on('click', (e) => {
  if (state.pickMode === 'plan') addPlanPoint(e.latlng);
  else if (state.pickMode === 'spot') { setPickMode(null); openSpotModal({ lat: e.latlng.lat, lng: e.latlng.lng }); }
});
function setPickMode(mode) {
  state.pickMode = mode;
  document.body.classList.toggle('picking', !!mode);
  $('#plan-pick').textContent = mode === 'plan' ? '地点の追加を終える' : '地図をタップして地点を追加';
}

$('#locate-btn').addEventListener('click', () => guard(async () => {
  const p = await getPosition();
  showMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
  map.setView([p.coords.latitude, p.coords.longitude], Math.max(map.getZoom(), 15));
}));

/* =========================================================
 * ボトムシート・タブ
 * ========================================================= */
const sheet = $('#sheet');
function setSheet(level) { sheet.dataset.level = level; }
let dragY = null, suppressClick = false;
$('#sheet-handle').addEventListener('pointerdown', (e) => { dragY = e.clientY; });
window.addEventListener('pointerup', (e) => {
  if (dragY == null) return;
  const dy = e.clientY - dragY;
  dragY = null;
  if (Math.abs(dy) < 20) return;
  suppressClick = true;
  const order = ['min', 'half', 'full'];
  let i = order.indexOf(sheet.dataset.level);
  i = dy < 0 ? Math.min(2, i + 1) : Math.max(0, i - 1);
  setSheet(order[i]);
});
$('#sheet-handle').addEventListener('click', () => {
  if (suppressClick) { suppressClick = false; return; }
  const l = sheet.dataset.level;
  setSheet(l === 'min' ? 'half' : l === 'half' ? 'full' : 'min');
});
$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => { p.hidden = p.id !== 'panel-' + name; });
  if (sheet.dataset.level === 'min') setSheet('half');
  $('.panels').scrollTop = 0;
}

/* =========================================================
 * 会員認証
 * ========================================================= */
function openAuth(view, force = false) {
  const m = $('#auth');
  m.hidden = false;
  m.dataset.force = force ? '1' : '';
  $$('[data-view]', m).forEach((v) => { v.hidden = v.dataset.view !== view; });
  $('#auth-close').hidden = force;
  $('#change-logout-wrap').hidden = !force;
  if (view === 'account' && state.user) {
    $('#acct-info').innerHTML = `<b>${esc(state.user.nickname)}</b> さん<br><span class="muted">${esc(state.user.email)}</span>`;
  }
  if (view === 'change') {
    $('#change-note').textContent = force
      ? '仮パスワードでログインしています。続けるには新しいパスワードを設定してください（英字と数字を含む8文字以上）。'
      : '英字と数字を含む8文字以上にしてください。';
  }
  const first = $(`[data-view="${view}"] input`, m);
  if (first) setTimeout(() => first.focus(), 50);
}
function closeAuth() {
  if ($('#auth').dataset.force) return;
  $('#auth').hidden = true;
}
$('#auth-close').addEventListener('click', closeAuth);
$('#account-btn').addEventListener('click', () => openAuth(state.user ? 'account' : 'login'));

document.addEventListener('click', async (e) => {
  // パスワード表示/非表示
  const t = e.target.closest('.pw-toggle');
  if (t) {
    const input = t.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    t.textContent = show ? '隠す' : '表示';
    t.setAttribute('aria-pressed', String(show));
    t.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go) {
    if (go.dataset.go === 'logout') {
      await guard(async () => { try { await api('logout'); } catch (err) { /* 失効済みでも続行 */ } });
      setSession(null, null);
      $('#auth').dataset.force = '';
      $('#auth').hidden = true;
      toast('ログアウトしました');
      refreshAfterAuth();
      return;
    }
    openAuth(go.dataset.go, $('#auth').dataset.force === '1' && go.dataset.go === 'change');
    return;
  }
  // モーダルを閉じる
  const c = e.target.closest('[data-close]');
  if (c) { const m = c.closest('.modal, .lightbox'); if (m) closeModal(m); }
});
function closeModal(m) {
  if (m.id === 'auth') return closeAuth();
  m.hidden = true;
  if (m.id === 'lightbox') $('#lightbox-body').innerHTML = '';
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = $$('.modal:not([hidden]), .lightbox:not([hidden])').pop();
  if (open) closeModal(open);
  else if (state.pickMode) setPickMode(null);
});

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  guard(async () => {
    const d = await api('login', { email: f.get('email'), password: f.get('password') });
    setSession(d.token, d.user);
    e.target.reset();
    if (d.user.mustChange) {
      openAuth('change', true);
    } else {
      $('#auth').hidden = true;
      toast(`${d.user.nickname} さん、ようこそ`);
      refreshAfterAuth();
    }
  }, 'ログインしています');
});
$('#register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  guard(async () => {
    const d = await api('register', { email: f.get('email'), nickname: f.get('nickname') });
    toast(d.message, 6000);
    openAuth('login');
    $('#login-form [name=email]').value = f.get('email');
    e.target.reset();
  }, '登録しています');
});
$('#reset-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  guard(async () => {
    const d = await api('resetPassword', { email: f.get('email') });
    toast(d.message, 6000);
    openAuth('login');
    $('#login-form [name=email]').value = f.get('email');
    e.target.reset();
  }, '送信しています');
});
$('#change-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('newPassword') !== f.get('confirm')) return toast('確認用のパスワードが一致しません');
  guard(async () => {
    const d = await api('changePassword', { current: f.get('current'), newPassword: f.get('newPassword') });
    setSession(state.token, d.user);
    e.target.reset();
    $$('.pw-field input', e.target).forEach((i) => { i.type = 'password'; });
    $$('.pw-toggle', e.target).forEach((b) => { b.textContent = '表示'; b.setAttribute('aria-pressed', 'false'); });
    $('#auth').dataset.force = '';
    $('#auth').hidden = true;
    toast('パスワードを変更しました');
    refreshAfterAuth();
  }, '変更しています');
});
function refreshAfterAuth() {
  searchRoutes();
  if (state.current) openRoute(state.current.route.routeId, false);
}

/* =========================================================
 * ルート検索・一覧
 * ========================================================= */
$('#route-filter').addEventListener('submit', (e) => { e.preventDefault(); searchRoutes(); });
$('#route-filter').addEventListener('change', (e) => { if (e.target.name !== 'keyword') searchRoutes(); });

async function searchRoutes() {
  const f = new FormData($('#route-filter'));
  const filters = {
    keyword: f.get('keyword') || '',
    maxGain: f.get('maxGain') || null,
    maxDistanceKm: f.get('maxDist') || null,
    sort: f.get('sort') || 'flat',
    pedestrian: f.get('pedestrian') === 'on',
    mine: f.get('mine') === 'on',
    tags: f.getAll('tag'),
  };
  if (filters.mine && !state.user) { requireLogin(); return; }
  $('#route-list').innerHTML = '<li class="empty">読み込んでいます</li>';
  try {
    const d = await api('listRoutes', { filters });
    renderRouteList(d.routes, d.total);
  } catch (e) {
    $('#route-list').innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
}
function renderRouteList(routes, total) {
  $('#route-count').textContent = total ? `${total}件のルート${total > routes.length ? `（上位${routes.length}件を表示）` : ''}` : '';
  layers.list.clearLayers();
  if (!routes.length) {
    $('#route-list').innerHTML = `<li class="empty">条件に合うルートがありません。${state.user ? '「記録」や「作る」から最初のルートを登録できます。' : 'ログインすると会員限定のルートも表示されます。'}</li>`;
    return;
  }
  $('#route-list').innerHTML = routes.map((r) => {
    const perKm = r.distanceM ? Math.round((r.elevGainM || 0) / Math.max(r.distanceM / 1000, 0.5)) : null;
    return `<li><button class="route-item" type="button" data-id="${esc(r.routeId)}">
      <span class="ri-title">${esc(r.title)}</span>
      <span class="ri-meta"><span><b>${fmtKmNum(r.distanceM)}</b> km</span><span>登り <b>${fmtM(r.elevGainM)}</b> m</span>${perKm != null ? `<span>1kmあたり <b>${perKm}</b> m</span>` : ''}</span>
      <span class="ri-sub"><span class="vis vis-${esc(r.visibility)}">${VIS[r.visibility] || ''}</span>${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span>${esc(r.nickname)}</span><span>いいね ${r.likeCount}</span></span>
    </button></li>`;
  }).join('');
  routes.forEach((r) => {
    if (r.startLat == null) return;
    L.circleMarker([r.startLat, r.startLng], { radius: 6, color: '#fff', weight: 2, fillColor: ROUTE_COLOR, fillOpacity: 0.9 })
      .bindTooltip(r.title).on('click', () => openRoute(r.routeId)).addTo(layers.list);
  });
}
$('#route-list').addEventListener('click', (e) => {
  const b = e.target.closest('.route-item');
  if (b) openRoute(b.dataset.id);
});

/* =========================================================
 * ルート詳細
 * ========================================================= */
async function openRoute(routeId, fit = true) {
  await guard(async () => {
    const d = await api('getRoute', { routeId });
    d.pts = d.points.map((p) => ({ lat: p.lat, lng: p.lng, ele: p.ele, time: p.time }));
    state.current = d;
    showTab('routes');
    $('#route-browse').hidden = true;
    $('#route-detail').hidden = false;
    layers.list.clearLayers();
    drawTrack(layers.route, d.pts, ROUTE_COLOR, fit);
    drawMediaPins(d.media);
    setActive(d.pts, d.route.title);
    renderRouteDetail();
  }, 'ルートを読み込んでいます');
}
function closeRoute() {
  state.current = null;
  $('#route-detail').hidden = true;
  $('#route-browse').hidden = false;
  layers.route.clearLayers();
  layers.photos.clearLayers();
  if (state.draft) { drawTrack(layers.route, state.draft.points, ROUTE_COLOR, false); setActive(state.draft.points, state.draft.title || '作成中のルート'); }
  else setActive(null);
  searchRoutes();
}
function drawMediaPins(media) {
  layers.photos.clearLayers();
  (media || []).filter((m) => m.lat != null && m.mimeType.startsWith('image/')).forEach((m) => {
    L.marker([m.lat, m.lng], { icon: L.divIcon({ className: 'photo-pin', html: `<img src="${esc(m.thumbUrl)}" alt="">`, iconSize: [36, 36], iconAnchor: [18, 18] }) })
      .on('click', () => openLightbox(m)).addTo(layers.photos);
  });
}
function renderRouteDetail() {
  const d = state.current, r = d.route;
  const mine = r.mine;
  const pr = r.pedestrianRatio != null ? `<p class="muted">歩行者向けの道の割合: ${Math.round(r.pedestrianRatio * 100)}%</p>` : '';
  $('#route-detail').innerHTML = `
    <button class="link back" type="button" data-act="back">一覧に戻る</button>
    <h2 class="detail-title">${esc(r.title)}</h2>
    <p class="ri-sub"><span class="vis vis-${esc(r.visibility)}">${VIS[r.visibility]}</span><span>${esc(r.nickname)} さん</span><span>${fmtDate(r.updatedAt)}</span><span>${SRC[r.source] || ''}</span></p>
    ${statsHtml({ distanceM: r.distanceM, gainM: r.elevGainM, lossM: r.elevLossM, maxEle: r.maxEleM, durationSec: r.durationSec })}
    <div class="profile-wrap" id="detail-profile"></div>
    ${r.tags.length ? `<div class="tags">${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${pr}
    ${r.description ? `<p class="desc">${esc(r.description).replace(/\n/g, '<br>')}</p>` : ''}
    <div class="row wrap">
      <button class="btn like ${d.likedByMe ? 'on' : ''}" type="button" data-act="like" aria-pressed="${d.likedByMe}">いいね ${d.likeCount}</button>
      <button class="btn" type="button" data-act="gpx">GPXで書き出す</button>
      <button class="btn" type="button" data-act="spots">沿道のスポット</button>
      ${mine ? '<button class="btn" type="button" data-act="edit">編集</button><button class="btn ghost danger" type="button" data-act="delete">削除</button>' : ''}
    </div>
    <h3>写真・動画</h3>
    ${d.media.length ? `<div class="gallery">${d.media.map(mediaHtml).join('')}</div>` : '<p class="muted">まだ写真・動画はありません。</p>'}
    ${mine ? '<label class="btn ghost file-btn">写真・動画を追加<input type="file" accept="image/*,video/*" multiple data-act="upload" hidden></label>' : ''}
    <h3>コメント（${d.commentCount}）</h3>
    ${state.user ? `
      <ul class="comment-list">${d.comments.map(commentHtml).join('') || '<li class="empty">まだコメントはありません。</li>'}</ul>
      <form id="comment-form" class="comment-form">
        <label>コメントを書く<textarea name="content" rows="2" maxlength="1000" required></textarea></label>
        <button class="btn primary" type="submit">投稿する</button>
      </form>` : '<p class="muted">コメントを読んだり書いたりするには<button class="link" type="button" data-go="login">ログイン</button>してください。</p>'}
  `;
  drawProfile($('#detail-profile'), d.pts);
}
function mediaHtml(m) {
  const video = m.mimeType.startsWith('video/');
  return `<figure class="media">
    <button class="thumb" type="button" data-act="view" data-id="${esc(m.mediaId)}" aria-label="${video ? '動画' : '写真'}を開く">
      <img src="${esc(m.thumbUrl)}" alt="${esc(m.caption || m.fileName)}" loading="lazy" onerror="this.style.visibility='hidden'">${video ? '<span class="play">▶</span>' : ''}
    </button>
    ${m.mine ? `<button class="link danger" type="button" data-act="del-media" data-id="${esc(m.mediaId)}">削除</button>` : ''}
  </figure>`;
}
function commentHtml(c) {
  return `<li data-cid="${esc(c.commentId)}">
    <div class="comment-head"><b>${esc(c.nickname)}</b><span>${fmtDate(c.createdAt)}${c.updatedAt ? '（編集済み）' : ''}</span></div>
    <div class="comment-body">${esc(c.content)}</div>
    ${c.mine ? '<div class="comment-actions"><button class="link" type="button" data-act="edit-comment">編集</button><button class="link danger" type="button" data-act="del-comment">削除</button></div>' : ''}
  </li>`;
}

$('#route-detail').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT') return;
  const d = state.current;
  if (!d) return;
  const r = d.route;
  switch (b.dataset.act) {
    case 'back': closeRoute(); break;
    case 'like':
      if (!requireLogin()) return;
      await guard(async () => {
        const x = await api('toggleLike', { routeId: r.routeId });
        d.likedByMe = x.liked; d.likeCount = x.likeCount;
        renderRouteDetail();
      });
      break;
    case 'gpx':
      await guard(async () => { const x = await api('exportGpx', { routeId: r.routeId }); download(x.filename, x.gpx); }, 'GPXを作成しています');
      break;
    case 'spots': showTab('spots'); spotsAlongRoute(); break;
    case 'edit': openSaveModal('edit'); break;
    case 'delete':
      if (!confirm(`「${r.title}」を削除します。写真・動画・コメントも削除され、元に戻せません。よろしいですか？`)) return;
      await guard(async () => { await api('deleteRoute', { routeId: r.routeId }); toast('ルートを削除しました'); closeRoute(); }, '削除しています');
      break;
    case 'view': openLightbox(d.media.find((m) => m.mediaId === b.dataset.id)); break;
    case 'del-media':
      if (!confirm('このファイルを削除しますか？')) return;
      await guard(async () => { await api('deleteMedia', { mediaId: b.dataset.id }); await openRoute(r.routeId, false); toast('削除しました'); }, '削除しています');
      break;
    case 'edit-comment': {
      const li = b.closest('li'), c = d.comments.find((x) => x.commentId === li.dataset.cid);
      li.querySelector('.comment-body').innerHTML = `<textarea rows="3" maxlength="1000">${esc(c.content)}</textarea>
        <div class="row"><button class="btn primary" type="button" data-act="save-comment">保存する</button><button class="btn ghost" type="button" data-act="cancel-comment">やめる</button></div>`;
      li.querySelector('.comment-actions').hidden = true;
      break;
    }
    case 'cancel-comment': renderRouteDetail(); break;
    case 'save-comment': {
      const li = b.closest('li');
      const content = li.querySelector('textarea').value.trim();
      if (!content) return toast('コメントを入力してください');
      await guard(async () => {
        const x = await api('editComment', { commentId: li.dataset.cid, content });
        const i = d.comments.findIndex((c) => c.commentId === li.dataset.cid);
        d.comments[i] = x.comment;
        renderRouteDetail();
        toast('コメントを保存しました');
      });
      break;
    }
    case 'del-comment': {
      if (!confirm('このコメントを削除しますか？')) return;
      const li = b.closest('li');
      await guard(async () => {
        const x = await api('deleteComment', { commentId: li.dataset.cid });
        d.comments = d.comments.filter((c) => c.commentId !== li.dataset.cid);
        d.commentCount = x.commentCount;
        renderRouteDetail();
      });
      break;
    }
  }
});
$('#route-detail').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'upload') return;
  const files = [...e.target.files];
  if (!files.length) return;
  const routeId = state.current.route.routeId;
  await uploadMany(files, { routeId });
  await openRoute(routeId, false);
});
$('#route-detail').addEventListener('submit', async (e) => {
  if (e.target.id !== 'comment-form') return;
  e.preventDefault();
  const content = new FormData(e.target).get('content').trim();
  if (!content) return;
  const d = state.current;
  await guard(async () => {
    const x = await api('addComment', { routeId: d.route.routeId, content });
    d.comments.push(x.comment);
    d.commentCount = x.commentCount;
    renderRouteDetail();
    toast('コメントを投稿しました');
  }, '投稿しています');
});

/* ---------- 写真・動画 ---------- */
function openLightbox(m) {
  if (!m) return;
  const body = $('#lightbox-body');
  body.innerHTML = m.mimeType.startsWith('video/')
    ? `<iframe src="${esc(m.viewUrl)}" allow="autoplay; fullscreen" allowfullscreen title="動画"></iframe>`
    : `<img src="${esc(m.viewUrl)}" alt="${esc(m.caption || m.fileName)}">`;
  $('#lightbox').hidden = false;
}
function fileToBase64(file) {
  return new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => ng(new Error('ファイルを読み込めませんでした'));
    r.readAsDataURL(file);
  });
}
async function imageToJpegBase64(file, max = 2000, q = 0.85) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { return null; }
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', q).split(',')[1];
}
async function readPhotoMeta(file) {
  let m = null;
  try { m = await exifr.parse(file, { gps: true, exif: true, tiff: true }); } catch (e) { m = null; }
  let t = m?.DateTimeOriginal || m?.CreateDate || null;
  if (!(t instanceof Date) || isNaN(t)) t = new Date(file.lastModified);
  return {
    file,
    lat: isFinite(m?.latitude) ? m.latitude : null,
    lng: isFinite(m?.longitude) ? m.longitude : null,
    ele: isFinite(m?.GPSAltitude) ? m.GPSAltitude : null,
    time: t,
    estimated: false,
    url: URL.createObjectURL(file),
  };
}
async function uploadFile(file, meta = {}) {
  let data = null, mimeType = file.type || 'application/octet-stream', fileName = file.name || 'file';
  const extra = { ...meta };
  if (mimeType.startsWith('image/')) {
    if (extra.lat == null) {
      const pm = await readPhotoMeta(file);
      if (pm.lat != null) { extra.lat = pm.lat; extra.lng = pm.lng; }
      extra.takenAt = extra.takenAt || pm.time.toISOString();
      URL.revokeObjectURL(pm.url);
    }
    const b = await imageToJpegBase64(file);
    if (b) { data = b; mimeType = 'image/jpeg'; fileName = fileName.replace(/\.\w+$/, '') + '.jpg'; }
  }
  if (!data) {
    if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} は25MBを超えているためアップロードできません`);
    data = await fileToBase64(file);
  }
  return api('uploadMedia', { data, mimeType, fileName, ...extra });
}
async function uploadMany(files, meta, perFile = () => ({})) {
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    busy(`アップロードしています（${i + 1}/${files.length}）`);
    try { await uploadFile(files[i], { ...meta, ...perFile(i) }); ok++; }
    catch (e) { toast(e.message, 5000); }
  }
  busy(false);
  if (ok) toast(`${ok}件アップロードしました`);
  return ok;
}

/* =========================================================
 * 標高プロファイル（等高線の段で塗る）
 * ========================================================= */
let profileSeq = 0;
function niceStep(raw) {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  return steps.find((s) => s >= raw) || 1000;
}
function drawProfile(el, pts) {
  if (!el) return;
  const cum = cumDist(pts);
  let data = [];
  pts.forEach((p, i) => { if (hasEle(p)) data.push([cum[i], p.ele]); });
  if (data.length < 2) {
    el.innerHTML = '<p class="muted">標高データがありません。</p>';
    return;
  }
  if (data.length > 500) { const k = Math.ceil(data.length / 500); data = data.filter((_, i) => i % k === 0 || i === data.length - 1); }
  const W = 600, H = 150, L0 = 40, R0 = 10, T0 = 10, B0 = 22;
  const maxD = data[data.length - 1][0] || 1;
  let minE = Math.min(...data.map((q) => q[1])), maxE = Math.max(...data.map((q) => q[1]));
  if (maxE - minE < 30) { const mid = (maxE + minE) / 2; minE = mid - 15; maxE = mid + 15; }
  const X = (d) => L0 + (d / maxD) * (W - L0 - R0);
  const Y = (e) => T0 + (1 - (e - minE) / (maxE - minE)) * (H - T0 - B0);
  const line = data.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)} ${Y(q[1]).toFixed(1)}`).join('');
  const area = `${line}L${X(maxD).toFixed(1)} ${H - B0}L${X(0)} ${H - B0}Z`;
  const step = niceStep((maxE - minE) / 5);
  const id = 'pclip' + (++profileSeq);
  let contours = '', labels = '';
  for (let e = Math.ceil(minE / step) * step; e <= maxE; e += step) {
    const y = Y(e).toFixed(1);
    contours += `<line class="contour" x1="${L0}" x2="${W - R0}" y1="${y}" y2="${y}"/>`;
    labels += `<text x="${L0 - 6}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${e}</text>`;
  }
  el.innerHTML = `<svg class="profile" viewBox="0 0 ${W} ${H}" role="img" aria-label="標高プロファイル。最低${Math.round(minE)}m、最高${Math.round(maxE)}m、距離${fmtKmNum(maxD)}km">
    <defs><clipPath id="${id}"><path d="${area}"/></clipPath></defs>
    <path class="area" d="${area}"/>
    <g clip-path="url(#${id})">${contours}</g>
    <path class="ridge" d="${line}"/>
    <line class="base" x1="${L0}" x2="${W - R0}" y1="${H - B0}" y2="${H - B0}"/>
    ${labels}
    <text x="${L0}" y="${H - 5}">0</text>
    <text x="${W - R0}" y="${H - 5}" text-anchor="end">${fmtKmNum(maxD)} km</text>
  </svg>`;
}

/* =========================================================
 * GPS記録
 * ========================================================= */
const rec = { status: 'idle', points: [], watchId: null, movingMs: 0, resumedAt: 0, startedAt: 0, timer: null, wakeLock: null, lastSave: 0, line: null };

function recSnapshot() {
  if (!rec.points.length) return;
  store.set('ymn_rec', { points: rec.points, movingMs: recMovingMs(), startedAt: rec.startedAt });
}
const recMovingMs = () => rec.movingMs + (rec.status === 'rec' ? Date.now() - rec.resumedAt : 0);

function recDrawLine() {
  layers.rec.clearLayers();
  rec.line = L.polyline(rec.points.map((p) => [p.lat, p.lng]), { color: REC_COLOR, weight: 5, opacity: 0.95 }).addTo(layers.rec);
}
function recBegin() {
  if (!navigator.geolocation) return toast('この端末では位置情報を使えません');
  rec.points = [];
  rec.movingMs = 0;
  rec.startedAt = Date.now();
  recDrawLine();
  recResume();
}
function recResume() {
  rec.status = 'rec';
  rec.resumedAt = Date.now();
  if (rec.watchId == null) {
    rec.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  acquireWakeLock();
  clearInterval(rec.timer);
  rec.timer = setInterval(updateRecUI, 1000);
  updateRecUI();
}
function recPause() {
  rec.movingMs += Date.now() - rec.resumedAt;
  rec.status = 'paused';
  clearInterval(rec.timer);
  recSnapshot();
  updateRecUI();
}
function recStop() {
  if (rec.status === 'rec') rec.movingMs += Date.now() - rec.resumedAt;
  rec.status = 'idle';
  if (rec.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
  rec.watchId = null;
  clearInterval(rec.timer);
  releaseWakeLock();
  layers.rec.clearLayers();
  store.del('ymn_rec');
  updateRecUI();
  if (rec.points.length < 2) { toast('記録された地点が少ないため、ルートは作成しませんでした'); return; }
  const d = new Date(rec.startedAt);
  setDraft(rec.points.slice(), 'record', {
    title: `${d.getMonth() + 1}月${d.getDate()}日の記録`,
    durationSec: Math.round(rec.movingMs / 1000),
  });
  showTab('create');
}
function onPos(pos) {
  const c = pos.coords;
  showMe(c.latitude, c.longitude, c.accuracy);
  $('#rec-acc').textContent = `GPSの精度 ±${Math.round(c.accuracy)}m${c.accuracy > CONFIG.REC_MAX_ACCURACY_M ? '（精度が低いため記録を待っています）' : ''}`;
  if (rec.status !== 'rec' || c.accuracy > CONFIG.REC_MAX_ACCURACY_M) return;
  const p = { lat: c.latitude, lng: c.longitude, ele: c.altitude == null ? null : c.altitude, time: new Date(pos.timestamp).toISOString() };
  const last = rec.points[rec.points.length - 1];
  if (last && dist(last, p) < CONFIG.REC_MIN_MOVE_M) return;
  rec.points.push(p);
  if (!rec.line) recDrawLine(); else rec.line.addLatLng([p.lat, p.lng]);
  if (rec.points.length === 1) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16));
  else if (!map.getBounds().pad(-0.15).contains([p.lat, p.lng])) map.panTo([p.lat, p.lng]);
  if (Date.now() - rec.lastSave > 10000) { recSnapshot(); rec.lastSave = Date.now(); }
  updateRecStats();
  if (rec.points.length % 15 === 0) drawProfile($('#rec-profile'), rec.points);
}
function onPosErr(err) {
  const msg = { 1: '位置情報の利用が許可されていません。ブラウザの設定を確認してください', 2: '現在地を取得できません', 3: 'GPSの応答がありません' }[err.code] || err.message;
  $('#rec-acc').textContent = msg;
  if (err.code === 1) { toast(msg, 6000); if (rec.status !== 'idle') recPause(); }
}
function updateRecUI() {
  const st = rec.status;
  $('#rec-start').hidden = st !== 'idle';
  $('#rec-pause').hidden = st !== 'rec';
  $('#rec-resume').hidden = st !== 'paused';
  $('#rec-stop').hidden = st === 'idle';
  $('#rec-badge').hidden = st === 'idle';
  $('#rec-badge').textContent = st === 'paused' ? '一時停止中' : '記録中';
  $('#rec-time').textContent = fmtClock(recMovingMs() / 1000);
  updateRecStats();
}
function updateRecStats() {
  const s = computeStats(rec.points, 5);
  $('#rec-dist').textContent = (s.distanceM / 1000).toFixed(2);
  $('#rec-gain').textContent = Math.round(s.gainM);
  const last = rec.points[rec.points.length - 1];
  $('#rec-ele').textContent = last && hasEle(last) ? Math.round(last.ele) : '--';
}
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) rec.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 非対応端末は無視 */ }
}
function releaseWakeLock() { try { rec.wakeLock?.release(); } catch (e) { } rec.wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec.status === 'rec') acquireWakeLock();
  if (document.visibilityState === 'hidden' && rec.status !== 'idle') recSnapshot();
});
window.addEventListener('beforeunload', (e) => {
  if (rec.status === 'idle') return;
  recSnapshot();
  e.preventDefault();
  e.returnValue = '';
});

$('#rec-start').addEventListener('click', recBegin);
$('#rec-pause').addEventListener('click', recPause);
$('#rec-resume').addEventListener('click', recResume);
$('#rec-stop').addEventListener('click', () => { if (confirm('記録を終えますか？')) recStop(); });

function checkRecovery() {
  const s = store.get('ymn_rec');
  $('#rec-recover').hidden = !(s && s.points && s.points.length);
}
$('#rec-recover-go').addEventListener('click', () => {
  const s = store.get('ymn_rec');
  if (!s) return;
  rec.points = s.points;
  rec.movingMs = s.movingMs || 0;
  rec.startedAt = s.startedAt || Date.now();
  recDrawLine();
  fitTo(rec.points.map((p) => [p.lat, p.lng]));
  $('#rec-recover').hidden = true;
  recResume();
});
$('#rec-recover-draft').addEventListener('click', () => {
  const s = store.get('ymn_rec');
  if (!s) return;
  store.del('ymn_rec');
  $('#rec-recover').hidden = true;
  const d = new Date(s.startedAt || Date.now());
  setDraft(s.points, 'record', { title: `${d.getMonth() + 1}月${d.getDate()}日の記録`, durationSec: Math.round((s.movingMs || 0) / 1000) });
  showTab('create');
});
$('#rec-recover-discard').addEventListener('click', () => {
  if (!confirm('前回の記録を破棄しますか？')) return;
  store.del('ymn_rec');
  $('#rec-recover').hidden = true;
});

/* =========================================================
 * 下書き（未保存ルート）
 * ========================================================= */
function setDraft(points, source, extra = {}) {
  state.draft = { points, source, title: extra.title || '', durationSec: extra.durationSec ?? null, photos: extra.photos || [], analysis: null };
  if (state.current) { state.current = null; $('#route-detail').hidden = true; $('#route-browse').hidden = false; }
  layers.list.clearLayers();
  drawTrack(layers.route, points, ROUTE_COLOR, true);
  setActive(points, state.draft.title || '作成中のルート');
  renderDraft();
}
function renderDraft() {
  const el = $('#draft');
  const d = state.draft;
  if (!d) { el.hidden = true; el.innerHTML = ''; return; }
  const s = computeStats(d.points, d.source === 'record' ? 5 : 3);
  const eleMissing = d.points.some((p) => !hasEle(p));
  el.hidden = false;
  el.innerHTML = `
    <div class="draft-head"><h3>${esc(d.title || '新しいルート')}</h3><span class="muted">${SRC[d.source] || ''}（未保存）</span></div>
    ${statsHtml({ distanceM: s.distanceM, gainM: s.gainM, lossM: s.lossM, maxEle: s.maxEle, durationSec: d.durationSec ?? s.durationSec })}
    <div id="draft-profile" class="profile-wrap"></div>
    ${d.analysis ? analysisHtml(d.analysis) : ''}
    <div class="row wrap">
      <button class="btn primary" type="button" data-draft="save">保存する</button>
      <button class="btn" type="button" data-draft="gpx">GPXで書き出す</button>
      ${eleMissing ? '<button class="btn" type="button" data-draft="ele">標高を補完</button>' : ''}
      <button class="btn" type="button" data-draft="roads">道の種類を調べる</button>
      <button class="btn" type="button" data-draft="spots">沿道のスポット</button>
      <button class="btn ghost danger" type="button" data-draft="discard">破棄</button>
    </div>`;
  drawProfile($('#draft-profile'), d.points);
}
function clearDraft() {
  state.draft?.photos?.forEach((p) => URL.revokeObjectURL(p.url));
  state.draft = null;
  layers.route.clearLayers();
  layers.photos.clearLayers();
  setActive(null);
  renderDraft();
}
$('#draft').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-draft]');
  const d = state.draft;
  if (!b || !d) return;
  switch (b.dataset.draft) {
    case 'save': openSaveModal('new'); break;
    case 'gpx': download(safeName(d.title || 'route') + '.gpx', buildGpx(d.title || 'route', d.points)); break;
    case 'ele':
      await guard(async () => { const n = await fillElevation(d.points); toast(`${n}地点の標高を補完しました`); renderDraft(); }, '標高を取得しています');
      break;
    case 'roads':
      await guard(async () => { d.analysis = await analyzeRoads(d.points); renderDraft(); }, '道の種類を調べています');
      break;
    case 'spots': showTab('spots'); spotsAlongRoute(); break;
    case 'discard':
      if (confirm('作成中のルートを破棄しますか？')) clearDraft();
      break;
  }
});

/* ---------- 道の種類の分析（OpenStreetMap） ---------- */
async function overpass(q) {
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let last = null;
  for (const u of endpoints) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(q) });
      if (r.ok) return await r.json();
      last = new Error(`OpenStreetMapの検索に失敗しました（${r.status}）。少し時間をおいてお試しください`);
    } catch (e) { last = e; }
  }
  throw last;
}
function classifyWay(t) {
  const h = t.highway || '';
  const foot = ['footway', 'path', 'pedestrian', 'steps', 'track', 'bridleway', 'corridor', 'cycleway'].includes(h);
  const busy = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/.test(h);
  const w = parseFloat(t.width || t.est_width || '');
  const narrow = foot || h === 'living_street' || (isFinite(w) && w < 4) || t.lanes === '1' || (h === 'service' && t.service === 'alley');
  return { kind: foot ? 'foot' : busy ? 'busy' : 'quiet', narrow, steps: h === 'steps' };
}
async function analyzeRoads(pts) {
  const samples = resample(pts, 40).slice(0, 800);
  const b = boundsOf(samples, 0.0015);
  if ((b.n - b.s) * (b.e - b.w) > 0.05) throw new Error('範囲が広すぎるため調べられません（目安: 20km四方まで）');
  const j = await overpass(`[out:json][timeout:30];way["highway"](${b.s},${b.w},${b.n},${b.e});out tags geom;`);
  const pr = projector(samples[0].lat);
  const segs = [];
  (j.elements || []).forEach((w) => {
    if (!w.geometry) return;
    const cls = classifyWay(w.tags || {});
    const g = w.geometry.map((q) => pr({ lat: q.lat, lng: q.lon }));
    for (let i = 0; i < g.length - 1; i++) {
      const a = g[i], c = g[i + 1];
      segs.push({ a, c, cls, x0: Math.min(a.x, c.x) - 30, x1: Math.max(a.x, c.x) + 30, y0: Math.min(a.y, c.y) - 30, y1: Math.max(a.y, c.y) + 30 });
    }
  });
  const cnt = { foot: 0, quiet: 0, busy: 0, none: 0, narrow: 0, steps: 0 };
  samples.forEach((p) => {
    const q = pr(p);
    let best = null, bd = 25;
    for (const s of segs) {
      if (q.x < s.x0 || q.x > s.x1 || q.y < s.y0 || q.y > s.y1) continue;
      const d = segDist(q, s.a, s.c).d;
      if (d < bd) { bd = d; best = s.cls; }
    }
    if (!best) { cnt.none++; return; }
    cnt[best.kind]++;
    if (best.narrow) cnt.narrow++;
    if (best.steps) cnt.steps++;
  });
  const matched = cnt.foot + cnt.quiet + cnt.busy;
  if (!matched) throw new Error('ルート上の道をOpenStreetMapで見つけられませんでした');
  const r = (n) => n / matched;
  const st = computeStats(pts);
  const gainPerKm = st.gainM / Math.max(st.distanceM / 1000, 0.5);
  const a = {
    foot: r(cnt.foot), quiet: r(cnt.quiet), busy: r(cnt.busy), narrow: r(cnt.narrow),
    coverage: matched / samples.length, pedestrianRatio: r(cnt.foot + cnt.quiet), tags: [],
  };
  if (a.foot >= 0.5) a.tags.push('歩道・遊歩道中心');
  if (a.busy <= 0.1) a.tags.push('車少なめ');
  if (a.narrow >= 0.4) a.tags.push('狭い道');
  if (cnt.steps / matched >= 0.03) a.tags.push('階段あり');
  if (hasEle(pts[0]) && gainPerKm < 20) a.tags.push('平坦');
  return a;
}
function analysisHtml(a) {
  const pc = (x) => Math.round(x * 100);
  return `<div class="card">
    <p><b>道の種類</b>（OpenStreetMapと照合できた区間 ${pc(a.coverage)}%）</p>
    <div class="road-bar" aria-hidden="true"><span class="c-foot" style="width:${pc(a.foot)}%"></span><span class="c-quiet" style="width:${pc(a.quiet)}%"></span><span class="c-busy" style="width:${pc(a.busy)}%"></span></div>
    <div class="road-legend"><span><i class="c-foot"></i>歩道・山道 ${pc(a.foot)}%</span><span><i class="c-quiet"></i>生活道路 ${pc(a.quiet)}%</span><span><i class="c-busy"></i>幹線道路 ${pc(a.busy)}%</span><span>狭い道 ${pc(a.narrow)}%</span></div>
    ${a.tags.length ? `<p class="muted">保存時に付ける特徴の候補: ${a.tags.map(esc).join('、')}</p>` : ''}
  </div>`;
}

/* ---------- 保存モーダル ---------- */
function buildTagChips(container, checked = []) {
  container.querySelectorAll('.chip').forEach((c) => c.remove());
  container.insertAdjacentHTML('beforeend', TAGS.map((t) => `<label class="chip"><input type="checkbox" name="tags" value="${esc(t)}" ${checked.includes(t) ? 'checked' : ''}>${esc(t)}</label>`).join(''));
}
function openSaveModal(mode) {
  if (!requireLogin()) return;
  state.saveMode = mode;
  const f = $('#save-form');
  f.reset();
  if (mode === 'edit') {
    const r = state.current.route;
    $('#save-title').textContent = 'ルートを編集';
    f.elements['title'].value = r.title;
    f.elements['description'].value = r.description || '';
    f.querySelector(`[name=visibility][value="${r.visibility}"]`).checked = true;
    buildTagChips($('#save-tags'), r.tags);
    $('#save-photos-wrap').hidden = true;
  } else {
    const d = state.draft;
    $('#save-title').textContent = 'ルートを保存';
    f.elements['title'].value = d.title || '';
    f.elements['description'].value = state.importNote || '';
    f.querySelector('[name=visibility][value="private"]').checked = true;   // 既定は非公開
    buildTagChips($('#save-tags'), d.analysis ? d.analysis.tags : []);
    $('#save-photos-wrap').hidden = !d.photos.length;
  }
  $('#save-modal').hidden = false;
  f.elements['title'].focus();
}
$('#save-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const meta = {
    title: f.get('title').trim(),
    description: f.get('description').trim(),
    visibility: f.get('visibility') || 'private',
    tags: f.getAll('tags'),
  };
  guard(async () => {
    if (state.saveMode === 'edit') {
      const r = state.current.route;
      await api('saveRoute', { route: { routeId: r.routeId, ...meta } });
      $('#save-modal').hidden = true;
      toast('保存しました');
      await openRoute(r.routeId, false);
      return;
    }
    const d = state.draft;
    const pts = simplify(d.points).map((p) => [
      +p.lat.toFixed(6), +p.lng.toFixed(6), hasEle(p) ? Math.round(p.ele * 10) / 10 : null, p.time || null,
    ]);
    const x = await api('saveRoute', {
      route: { ...meta, source: d.source, durationSec: d.durationSec, pedestrianRatio: d.analysis ? d.analysis.pedestrianRatio : null },
      points: pts,
    });
    $('#save-modal').hidden = true;
    const routeId = x.route.routeId;
    if (d.photos.length && f.get('uploadPhotos') === 'on') {
      await uploadMany(d.photos.map((p) => p.file), { routeId }, (i) => ({
        lat: d.photos[i].lat, lng: d.photos[i].lng, takenAt: d.photos[i].time.toISOString(),
      }));
    }
    state.importNote = '';
    clearDraft();
    toast('保存しました');
    await openRoute(routeId);
  }, '保存しています');
});

/* =========================================================
 * 作る: GPX / 写真 / 経路探索 / 取り込み
 * ========================================================= */
$('#gpx-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  guard(async () => {
    const { name, pts } = parseGpx(await file.text());
    if (pts.length < 2) throw new Error('GPXに経路の地点が見つかりませんでした');
    setDraft(simplify(pts, 8000), 'gpx', { title: name || file.name.replace(/\.gpx$/i, '') });
    toast(`${pts.length}地点を読み込みました`);
  }, 'GPXを読み込んでいます');
  e.target.value = '';
});

$('#photo-files').addEventListener('change', (e) => {
  state.photoFiles = [...e.target.files];
  $('#photo-picked').textContent = state.photoFiles.length ? `${state.photoFiles.length}枚を選びました` : '';
});
$('#photo-run').addEventListener('click', () => guard(async () => {
  const files = state.photoFiles;
  if (!files.length) throw new Error('写真を選んでください');
  const snap = $('#photo-snap').checked, ai = $('#photo-ai').checked;
  const items = [];
  for (let i = 0; i < files.length; i++) {
    busy(`写真の情報を読み取っています（${i + 1}/${files.length}）`);
    items.push(await readPhotoMeta(files[i]));
  }
  const missing = items.filter((x) => x.lat == null);
  let estimated = 0;
  if (missing.length && ai) {
    if (!state.config.geminiEnabled) toast('AI機能が設定されていないため、位置情報のない写真は除外します');
    else if (requireLogin()) {
      for (let i = 0; i < missing.length; i++) {
        busy(`AIで撮影地を推定しています（${i + 1}/${missing.length}）`);
        const known = items.filter((x) => x.lat != null && !x.estimated);
        const hint = known.length
          ? `同じ日に撮影した他の写真はおよそ 緯度${known[0].lat.toFixed(3)} 経度${known[0].lng.toFixed(3)} 付近。撮影日時 ${missing[i].time.toLocaleString('ja-JP')}`
          : `撮影日時 ${missing[i].time.toLocaleString('ja-JP')}`;
        const b64 = await imageToJpegBase64(missing[i].file, 1024, 0.8);
        if (!b64) continue;
        try {
          const r = await api('estimatePhotoLocation', { image: b64, mimeType: 'image/jpeg', hint });
          if (r.lat != null && r.confidence >= 0.4) {
            Object.assign(missing[i], { lat: r.lat, lng: r.lng, estimated: true, placeName: r.placeName });
            estimated++;
          }
        } catch (err) { console.warn(err); }
      }
    }
  }
  const located = items.filter((x) => x.lat != null).sort((a, b) => a.time - b.time);
  if (located.length < 2) throw new Error(`位置が分かる写真が2枚以上必要です（現在 ${located.length}枚）`);

  let pts;
  if (snap) {
    if (!state.config.orsEnabled) throw new Error('経路探索が設定されていないため「道に沿って線を引く」は使えません');
    if (!requireLogin()) return;
    busy('道に沿った経路を探しています');
    let wps = located;
    if (wps.length > 50) { const k = Math.ceil(wps.length / 49); wps = wps.filter((_, i) => i % k === 0 || i === wps.length - 1); }
    const r = await api('planRoute', { coords: wps.map((x) => [x.lat, x.lng]), preference: 'recommended' });
    if (!r.candidates.length) throw new Error('経路が見つかりませんでした');
    pts = r.candidates[0].points.map((q) => ({ lat: q[0], lng: q[1], ele: q[2], time: null }));
  } else {
    pts = [];
    located.forEach((x, i) => {
      const a = { lat: x.lat, lng: x.lng, ele: x.ele, time: x.time.toISOString() };
      pts.push(a);
      const n = located[i + 1];
      if (n) pts.push(...interpolate(a, { lat: n.lat, lng: n.lng, ele: n.ele, time: n.time.toISOString() }, 50));
    });
  }
  if (pts.some((p) => !hasEle(p))) {
    busy('標高を取得しています');
    try { await fillElevation(pts); } catch (err) { console.warn(err); }
  }
  const first = located[0].time;
  setDraft(pts, 'photo', { title: `${first.getMonth() + 1}月${first.getDate()}日の写真ルート`, photos: located });
  layers.photos.clearLayers();
  located.forEach((x) => {
    L.marker([x.lat, x.lng], { icon: L.divIcon({ className: 'photo-pin' + (x.estimated ? ' estimated' : ''), html: `<img src="${x.url}" alt="">`, iconSize: [36, 36], iconAnchor: [18, 18] }) })
      .bindTooltip(`${x.time.toLocaleString('ja-JP')}${x.estimated ? `（AI推定: ${esc(x.placeName || '')}）` : ''}`)
      .addTo(layers.photos);
  });
  const skipped = items.length - located.length;
  toast(`${located.length}枚の写真から経路を作りました${estimated ? `（うち${estimated}枚はAI推定）` : ''}${skipped ? `。位置が分からない${skipped}枚は除外しました` : ''}`, 6000);
}));

/* ---------- 経路探索 ---------- */
$('#plan-pick').addEventListener('click', () => {
  if (state.pickMode === 'plan') { setPickMode(null); return; }
  setPickMode('plan');
  setSheet('min');
  toast('地図をタップして、出発地・経由地・目的地の順に追加してください');
});
$('#plan-clear').addEventListener('click', () => {
  state.plan = { points: [], candidates: [], selected: -1 };
  setPickMode(null);
  layers.plan.clearLayers();
  renderPlan();
});
function addPlanPoint(ll) {
  if (state.plan.points.length >= 50) return toast('地点は50か所までです');
  state.plan.points.push({ lat: ll.lat, lng: ll.lng });
  state.plan.candidates = [];
  renderPlan();
}
function renderPlan() {
  const pts = state.plan.points;
  layers.plan.clearLayers();
  state.plan.candidates.forEach((c, i) => {
    if (i === state.plan.selected) return;
    L.polyline(c.points.map((q) => [q[0], q[1]]), { color: '#5B675F', weight: 4, opacity: 0.55, dashArray: '6 6' })
      .on('click', () => selectCandidate(i)).addTo(layers.plan);
  });
  pts.forEach((p, i) => {
    const label = i === 0 ? 'S' : i === pts.length - 1 && pts.length > 1 ? 'G' : String(i);
    L.marker([p.lat, p.lng], { draggable: true, icon: L.divIcon({ className: 'plan-pin', html: `<span>${label}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .on('dragend', (e) => { const ll = e.target.getLatLng(); pts[i] = { lat: ll.lat, lng: ll.lng }; state.plan.candidates = []; renderPlan(); })
      .addTo(layers.plan);
  });
  $('#plan-points').innerHTML = pts.map((p, i) => {
    const label = i === 0 ? '出発地' : i === pts.length - 1 && pts.length > 1 ? '目的地' : `経由地${i}`;
    return `<li><span class="n">${i === 0 ? 'S' : i === pts.length - 1 && pts.length > 1 ? 'G' : i}</span>${label}（${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}）<button class="link danger" type="button" data-rm="${i}">外す</button></li>`;
  }).join('');
  $('#plan-candidates').innerHTML = state.plan.candidates.map((c, i) => `
    <button class="cand" type="button" data-cand="${i}" aria-pressed="${i === state.plan.selected}">
      候補${i + 1}　<b>${fmtKmNum(c.distanceM)}</b> km　登り <b>${fmtM(c.ascentM)}</b> m　下り <b>${fmtM(c.descentM)}</b> m　約${fmtDur(c.durationSec)}
    </button>`).join('');
}
$('#plan-points').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  state.plan.points.splice(+b.dataset.rm, 1);
  state.plan.candidates = [];
  renderPlan();
});
$('#plan-candidates').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cand]');
  if (b) selectCandidate(+b.dataset.cand);
});
function selectCandidate(i) {
  state.plan.selected = i;
  const c = state.plan.candidates[i];
  setDraft(c.points.map((q) => ({ lat: q[0], lng: q[1], ele: q[2], time: null })), 'plan', { title: '探索した経路', durationSec: c.durationSec });
  renderPlan();
}
$('#plan-run').addEventListener('click', () => guard(async () => {
  if (!state.config.orsEnabled) throw new Error('経路探索が設定されていません（ORS_API_KEY）');
  if (!requireLogin()) return;
  if (state.plan.points.length < 2) throw new Error('出発地と目的地を地図で指定してください');
  setPickMode(null);
  const d = await api('planRoute', {
    coords: state.plan.points.map((p) => [p.lat, p.lng]),
    preference: $('#plan-pref').value,
    avoidSteps: $('#plan-steps').checked,
  });
  if (!d.candidates.length) throw new Error('経路が見つかりませんでした');
  state.plan.candidates = d.candidates;
  selectCandidate(0);
  showTab('create');
  if (d.candidates.length > 1) toast(`${d.candidates.length}件の候補が見つかりました。${$('#plan-pref').value === 'flat' ? '登りが少ない順に並べています' : ''}`);
}, '経路を探しています'));

/* ---------- 記事・Webページから取り込み（Gemini） ---------- */
$('#import-run').addEventListener('click', () => guard(async () => {
  const url = $('#import-url').value.trim(), text = $('#import-text').value.trim();
  if (!url && !text) throw new Error('URLを入力するか、本文を貼り付けてください');
  if (!state.config.geminiEnabled) throw new Error('AI機能が設定されていません（GEMINI_API_KEY）');
  if (!requireLogin()) return;
  const d = await api('extractFromUrl', { url, text });
  d.spots.forEach((s) => { s.checked = true; s.geo = null; s.geoTried = false; });
  state.importResult = d;
  layers.imp.clearLayers();
  renderImport();
}, 'ページを読み取っています'));

function renderImport() {
  const d = state.importResult;
  if (!d) { $('#import-result').innerHTML = ''; return; }
  const c = d.course || {};
  const fact = (k, v) => (v == null || v === '' ? '' : `<dt>${k}</dt><dd>${esc(v)}</dd>`);
  $('#import-result').innerHTML = `
    <div class="card">
      <h3>${esc(c.title || 'タイトル不明のコース')}</h3>
      ${c.area ? `<p class="muted">${esc(c.area)}</p>` : ''}
      ${c.summary ? `<p>${esc(c.summary)}</p>` : ''}
      <dl class="facts">
        ${fact('距離', c.distanceKm != null ? `${c.distanceKm} km` : null)}
        ${fact('登り', c.elevationGainM != null ? `${c.elevationGainM} m` : null)}
        ${fact('高低差', c.elevationDiff)}
        ${fact('所要時間', c.durationMin != null ? fmtDur(c.durationMin * 60) : null)}
        ${fact('難易度', c.difficulty)}
        ${fact('スタート', c.start)}
        ${fact('ゴール', c.goal)}
        ${fact('アクセス', c.access)}
      </dl>
      <button class="btn ghost" type="button" data-imp="note">この内容をルートの説明に使う</button>
    </div>
    ${d.specialties.length ? `<h3>名物・お土産</h3><ul class="import-spots">${d.specialties.map((s) => `<li><b>${esc(s.name)}</b>${s.where ? `<span class="muted">（${esc(s.where)}）</span>` : ''}<br><span class="muted">${esc(s.description)}</span></li>`).join('')}</ul>` : ''}
    <h3>立ち寄りスポット（${d.spots.length}件）</h3>
    ${d.spots.length ? `<ul class="import-spots">${d.spots.map((s, i) => `
      <li>
        <label class="check"><input type="checkbox" data-i="${i}" ${s.checked ? 'checked' : ''}><span>${CATS[s.category]?.icon || ''} <b>${esc(s.name)}</b></span></label>
        <span class="spot-meta">${CATS[s.category]?.label || ''}${s.specialty ? `　名物: ${esc(s.specialty)}` : ''}　${s.geo ? '位置が見つかりました' : s.geoTried ? '位置が見つかりません' : '位置は未検索'}</span>
        ${s.description ? `<br><span class="muted">${esc(s.description)}</span>` : ''}
      </li>`).join('')}</ul>
      <div class="row wrap">
        <button class="btn" type="button" data-imp="geocode">位置を検索する</button>
        <button class="btn primary" type="button" data-imp="save">選んだスポットを登録</button>
      </div>` : '<p class="muted">スポットは見つかりませんでした。</p>'}
    ${d.sourceUrl ? `<p class="hint">出典: <a href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">${esc(d.sourceUrl)}</a></p>` : ''}
  `;
}
$('#import-result').addEventListener('change', (e) => {
  const i = e.target.dataset.i;
  if (i != null) state.importResult.spots[+i].checked = e.target.checked;
});
$('#import-result').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-imp]');
  const d = state.importResult;
  if (!b || !d) return;
  if (b.dataset.imp === 'note') {
    const c = d.course || {};
    state.importNote = [c.title, c.summary, c.access ? `アクセス: ${c.access}` : '', d.sourceUrl ? `出典: ${d.sourceUrl}` : ''].filter(Boolean).join('\n');
    toast('次に保存するルートの説明に入れます');
  }
  if (b.dataset.imp === 'geocode') await geocodeImportSpots();
  if (b.dataset.imp === 'save') await saveImportSpots();
});
async function geocode(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(q)}`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}
async function geocodeImportSpots() {
  const d = state.importResult;
  const area = d.course?.area || '';
  const targets = d.spots.filter((s) => s.checked && !s.geo);
  try {
    for (let i = 0; i < targets.length; i++) {
      busy(`位置を検索しています（${i + 1}/${targets.length}）`);
      const s = targets[i];
      s.geo = await geocode(`${s.name} ${s.addressHint || area}`.trim());
      if (!s.geo && (s.addressHint || area)) { await sleep(1100); s.geo = await geocode(s.name); }
      s.geoTried = true;
      await sleep(1100);   // Nominatim の利用規約（1秒に1回まで）
    }
  } finally { busy(false); }
  layers.imp.clearLayers();
  const found = d.spots.filter((s) => s.geo);
  found.forEach((s) => L.marker([s.geo.lat, s.geo.lng], { icon: spotIcon(s.category, true) }).bindTooltip(s.name).addTo(layers.imp));
  if (found.length) fitTo(found.map((s) => [s.geo.lat, s.geo.lng]));
  renderImport();
  toast(`${found.length}件の位置が見つかりました`);
}
async function saveImportSpots() {
  if (!requireLogin()) return;
  const d = state.importResult;
  const targets = d.spots.filter((s) => s.checked && s.geo);
  if (!targets.length) return toast('位置が見つかったスポットを選んでください。先に「位置を検索する」を押してください');
  let ok = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      busy(`登録しています（${i + 1}/${targets.length}）`);
      const s = targets[i];
      try {
        await api('saveSpot', { spot: { name: s.name, category: s.category, lat: s.geo.lat, lng: s.geo.lng, description: s.description, specialty: s.specialty, url: d.sourceUrl, visibility: 'private', source: 'import' } });
        ok++;
      } catch (e) { toast(e.message); }
    }
  } finally { busy(false); }
  toast(`${ok}件のスポットを非公開で登録しました。公開範囲はスポットの編集で変えられます`, 6000);
}

/* =========================================================
 * スポット
 * ========================================================= */
function spotIcon(cat, osm = false) {
  return L.divIcon({ className: 'spot-pin' + (osm ? ' osm' : ''), html: `<span>${CATS[cat]?.icon || '📍'}</span>`, iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -26] });
}
const selectedCats = () => $$('#spot-cats input:checked').map((i) => i.value);
$('#spot-cats').addEventListener('change', () => renderSpots());

async function spotsInView() {
  const b = map.getBounds();
  const d = await api('listSpots', { bbox: { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() } });
  state.spotResults = d.spots.map((s) => ({ ...s, from: 'db' }));
  renderSpots();
  toast(`${state.spotResults.length}件見つかりました`);
}
async function spotsAlongRoute() {
  const pts = state.active?.points;
  if (!pts || pts.length < 2) return toast('先にルートを表示するか作成してください');
  const radius = +$('#spot-radius').value;
  await guard(async () => {
    const pad = radius / 100000 + 0.002;
    const b = boundsOf(pts, pad);
    const line = prepLine(pts);
    const d = await api('listSpots', { bbox: b });
    let list = d.spots.map((s) => ({ ...s, from: 'db', ...nearestOnLine(s, line) })).filter((s) => s.d <= radius);
    if ($('#spot-osm').checked) {
      try {
        const osm = await osmSpots(pts, radius);
        const names = new Set(list.map((s) => s.name));
        list = list.concat(osm.filter((s) => !names.has(s.name)).map((s) => ({ ...s, ...nearestOnLine(s, line) })));
      } catch (e) { toast(e.message, 5000); }
    }
    list.sort((a, b2) => a.along - b2.along);
    state.spotResults = list;
    renderSpots();
    toast(`ルートから${radius >= 1000 ? radius / 1000 + 'km' : radius + 'm'}以内に${list.length}件見つかりました`);
  }, 'ルート沿いを探しています');
}
function osmCategory(t) {
  if (t.tourism === 'camp_site') return 'camp';
  if (/道の駅/.test(t.name || '')) return 'michinoeki';
  if (t.amenity === 'public_bath' || t.natural === 'hot_spring') return 'onsen';
  if (t.tourism === 'viewpoint') return 'view';
  if (['restaurant', 'cafe', 'fast_food'].includes(t.amenity)) return 'food';
  if (['gift', 'confectionery'].includes(t.shop)) return 'souvenir';
  if (t.shop) return 'shop';
  return null;
}
async function osmSpots(pts, radius) {
  const total = cumDist(pts).pop();
  const line = resample(pts, Math.max(100, total / 70)).slice(0, 90).map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(',');
  const a = `(around:${radius},${line})`;
  const q = `[out:json][timeout:30];(
    nwr["tourism"="camp_site"]${a};
    nwr["amenity"="public_bath"]${a};
    nwr["natural"="hot_spring"]${a};
    nwr["tourism"="viewpoint"]${a};
    nwr["amenity"~"^(restaurant|cafe|fast_food)$"]${a};
    nwr["shop"~"^(convenience|supermarket|gift|confectionery)$"]${a};
    nwr["name"~"道の駅"]${a};
  );out center 300;`;
  const j = await overpass(q);
  return (j.elements || []).map((e) => {
    const t = e.tags || {};
    const cat = osmCategory(t);
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    const name = t.name || (cat === 'view' ? '展望スポット' : cat === 'onsen' ? '温泉' : null);
    if (!cat || lat == null || !name) return null;
    return { spotId: `osm_${e.type}${e.id}`, name, category: cat, lat, lng, description: t.description || (t.opening_hours ? `営業時間: ${t.opening_hours}` : ''), specialty: '', url: t.website || '', from: 'osm' };
  }).filter(Boolean);
}
function renderSpots() {
  const cats = selectedCats();
  const shown = state.spotResults.filter((s) => !cats.length || cats.includes(s.category));
  layers.spots.clearLayers();
  shown.forEach((s) => {
    L.marker([s.lat, s.lng], { icon: spotIcon(s.category, s.from === 'osm') })
      .bindPopup(`<b>${esc(s.name)}</b><br>${CATS[s.category]?.label || ''}${s.specialty ? `<br>名物: ${esc(s.specialty)}` : ''}${s.description ? `<br>${esc(s.description)}` : ''}${s.url ? `<br><a href="${esc(s.url)}" target="_blank" rel="noopener">Webサイト</a>` : ''}`)
      .addTo(layers.spots);
  });
  $('#spot-list').innerHTML = shown.length ? shown.map((s) => `
    <li data-sid="${esc(s.spotId)}">
      <div class="spot-name">${CATS[s.category]?.icon || ''} ${esc(s.name)} ${s.from === 'osm' ? '<span class="src-osm">OSM</span>' : `<span class="vis vis-${esc(s.visibility)}">${VIS[s.visibility] || ''}</span>`}</div>
      <div class="spot-meta">${CATS[s.category]?.label || ''}${s.along != null ? `　スタートから約${fmtKmNum(s.along)}km・ルートから${Math.round(s.d)}m` : ''}${s.specialty ? `　名物: ${esc(s.specialty)}` : ''}</div>
      ${s.description ? `<div class="muted">${esc(s.description)}</div>` : ''}
      <div class="spot-actions">
        <button class="link" type="button" data-sp="show">地図で見る</button>
        ${s.from === 'db' ? '<button class="link" type="button" data-sp="media">写真</button>' : ''}
        ${s.mine ? '<button class="link" type="button" data-sp="edit">編集</button>' : ''}
        ${s.from === 'osm' ? '<button class="link" type="button" data-sp="adopt">スポットとして登録</button>' : ''}
      </div>
    </li>`).join('') : '<li class="empty">見つかりませんでした。距離を広げるか、地図をタップして登録してください。</li>';
}
$('#spot-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sp]');
  if (!b) return;
  const s = state.spotResults.find((x) => x.spotId === b.closest('li').dataset.sid);
  if (!s) return;
  if (b.dataset.sp === 'show') {
    setSheet('min');
    map.setView([s.lat, s.lng], Math.max(map.getZoom(), 16));
    layers.spots.eachLayer((m) => { const ll = m.getLatLng?.(); if (ll && ll.lat === s.lat && ll.lng === s.lng) m.openPopup(); });
  }
  if (b.dataset.sp === 'edit') openSpotModal(s);
  if (b.dataset.sp === 'adopt') openSpotModal({ lat: s.lat, lng: s.lng, name: s.name, category: s.category, description: s.description, url: s.url, source: 'osm' });
  if (b.dataset.sp === 'media') {
    if (!requireLogin()) return;
    await guard(async () => {
      const d = await api('listMedia', { spotId: s.spotId });
      if (!d.media.length) return toast('このスポットの写真はまだありません');
      $('#lightbox-body').innerHTML = `<div class="gallery">${d.media.map((m) => `<button class="thumb" type="button" data-view='${esc(JSON.stringify({ viewUrl: m.viewUrl, mimeType: m.mimeType, fileName: m.fileName }))}'><img src="${esc(m.thumbUrl)}" alt="">${m.mimeType.startsWith('video/') ? '<span class="play">▶</span>' : ''}</button>`).join('')}</div>`;
      $('#lightbox').hidden = false;
    }, '読み込んでいます');
  }
});
$('#lightbox-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) openLightbox(JSON.parse(b.dataset.view));
});

$('#spot-view').addEventListener('click', () => guard(spotsInView, '探しています'));
$('#spot-along').addEventListener('click', spotsAlongRoute);
$('#spot-add-tap').addEventListener('click', () => {
  if (!requireLogin()) return;
  setPickMode('spot');
  setSheet('min');
  toast('登録したい場所を地図でタップしてください');
});
$('#spot-add-here').addEventListener('click', () => {
  if (!requireLogin()) return;
  guard(async () => {
    const p = await getPosition();
    showMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
    openSpotModal({ lat: p.coords.latitude, lng: p.coords.longitude });
  }, '現在地を取得しています');
});

function openSpotModal(s) {
  if (!requireLogin()) return;
  state.editingSpot = s;
  const f = $('#spot-form');
  f.reset();
  const editing = !!(s.spotId && s.mine);
  $('#spot-modal-title').textContent = editing ? 'スポットを編集' : 'スポットを登録';
  $('#spot-pos').textContent = `位置: ${(+s.lat).toFixed(5)}, ${(+s.lng).toFixed(5)}`;
  f.elements['name'].value = s.name || '';
  f.elements['category'].value = s.category || 'view';
  f.elements['description'].value = s.description || '';
  f.elements['specialty'].value = s.specialty || '';
  f.elements['url'].value = s.url || '';
  f.querySelector(`[name=visibility][value="${editing ? s.visibility : 'private'}"]`).checked = true;
  $('#spot-delete').hidden = !editing;
  $('#spot-modal').hidden = false;
  f.elements['name'].focus();
}
$('#spot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const s = state.editingSpot;
  const editing = !!(s.spotId && s.mine);
  const files = [...e.target.elements['files'].files];
  guard(async () => {
    const d = await api('saveSpot', {
      spot: {
        spotId: editing ? s.spotId : undefined,
        name: f.get('name'), category: f.get('category'), lat: s.lat, lng: s.lng,
        description: f.get('description'), specialty: f.get('specialty'), url: f.get('url'),
        visibility: f.get('visibility'), source: s.source || 'manual',
      },
    });
    $('#spot-modal').hidden = true;
    if (files.length) await uploadMany(files, { spotId: d.spot.spotId, lat: s.lat, lng: s.lng });
    const saved = { ...d.spot, from: 'db', d: s.d, along: s.along };
    const i = state.spotResults.findIndex((x) => x.spotId === (editing ? s.spotId : '__none__'));
    if (i >= 0) state.spotResults[i] = saved;
    else state.spotResults = state.spotResults.filter((x) => !(x.from === 'osm' && x.name === saved.name)).concat(saved);
    renderSpots();
    toast(editing ? 'スポットを保存しました' : 'スポットを登録しました');
  }, '保存しています');
});
$('#spot-delete').addEventListener('click', () => {
  const s = state.editingSpot;
  if (!s || !confirm(`「${s.name}」を削除しますか？写真・動画も削除されます。`)) return;
  guard(async () => {
    await api('deleteSpot', { spotId: s.spotId });
    $('#spot-modal').hidden = true;
    state.spotResults = state.spotResults.filter((x) => x.spotId !== s.spotId);
    renderSpots();
    toast('スポットを削除しました');
  }, '削除しています');
});

/* =========================================================
 * 初期化
 * ========================================================= */
function buildStaticUI() {
  $('#spot-cats').insertAdjacentHTML('beforeend', Object.entries(CATS).map(([k, v]) =>
    `<label class="chip"><input type="checkbox" value="${k}">${v.icon} ${v.label}</label>`).join(''));
  $('#spot-category').innerHTML = Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('');
  setActive(null);
}

async function init() {
  buildStaticUI();
  updateAccountButton();
  updateRecUI();
  checkRecovery();
  try { state.config = await api('getConfig'); } catch (e) { toast(e.message, 6000); }
  if (state.token) {
    try {
      const d = await api('me');
      setSession(state.token, d.user);
      if (d.user.mustChange) openAuth('change', true);
    } catch (e) { /* 期限切れはapi()内で処理済み */ }
  }
  searchRoutes();
}
init();
