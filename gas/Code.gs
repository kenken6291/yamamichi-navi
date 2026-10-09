/**
 * やまみちナビ — ハイキング向けナビゲーション / バックエンド (Google Apps Script)
 *
 * 初回手順:
 *  1. このファイルを貼り付けて保存し、関数 setup を実行（権限を承認）
 *     → スプレッドシート「やまみちナビ DB」とDriveフォルダ「やまみちナビ Media」が自動作成されます
 *  2. プロジェクトの設定 > スクリプト プロパティ に GEMINI_API_KEY などを設定
 *  3. デプロイ > 新しいデプロイ > 種類: ウェブアプリ（実行: 自分 / アクセス: 全員）
 *  ※ コードを変更したら「デプロイを管理」→ 編集 → バージョン「新バージョン」で再デプロイすること
 *
 * スクリプト プロパティ:
 *  SPREADSHEET_ID   setup() が自動設定
 *  DRIVE_FOLDER_ID  setup() が自動設定
 *  PEPPER           setup() が自動設定（変更するとすべてのパスワードが無効になります）
 *  GEMINI_API_KEY   Google AI Studio で取得したAPIキー
 *  GEMINI_MODEL     使用するモデルID（未設定時 gemini-2.5-flash）
 *  ORS_API_KEY      openrouteservice のAPIキー（経路探索・写真の道路沿い補間で使用。任意）
 *  APP_URL          公開URL（メール本文に記載。例 https://kenken6291.github.io/yamamichi-navi/）
 */

const APP_NAME = 'やまみちナビ';
const SESSION_TTL = 21600;               // セッション有効期間（秒）。CacheService の上限は6時間
const HASH_ROUNDS = 1000;                // パスワードハッシュのストレッチ回数
const MAX_POINTS = 5000;                 // 1ルートあたりの最大地点数
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const LOCK_LIMIT = 5;                    // ログイン失敗でロックする回数
const LOCK_MINUTES = 15;
const VISIBILITY = ['private', 'members', 'public'];
const CATEGORIES = ['camp', 'michinoeki', 'onsen', 'shop', 'view', 'food', 'souvenir'];

const SHEETS = {
  Users: ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'mustChange', 'failCount', 'lockedUntil',
    'role', 'status', 'createdAt', 'lastLoginAt'],
  Routes: ['routeId', 'userId', 'title', 'description', 'visibility', 'tags', 'source', 'distanceM', 'elevGainM',
    'elevLossM', 'maxEleM', 'minEleM', 'durationSec', 'pointCount', 'startLat', 'startLng', 'minLat', 'minLng',
    'maxLat', 'maxLng', 'pedestrianRatio', 'gpxFileId', 'likeCount', 'commentCount', 'createdAt', 'updatedAt'],
  Waypoints: ['routeId', 'seq', 'lat', 'lng', 'ele', 'time'],
  Spots: ['spotId', 'userId', 'name', 'category', 'lat', 'lng', 'description', 'specialty', 'url', 'visibility',
    'source', 'createdAt', 'updatedAt'],
  Media: ['mediaId', 'userId', 'routeId', 'spotId', 'fileId', 'mimeType', 'fileName', 'thumbUrl', 'viewUrl',
    'lat', 'lng', 'takenAt', 'caption', 'createdAt'],
  Interactions: ['interactionId', 'type', 'routeId', 'userId', 'nickname', 'content', 'createdAt', 'updatedAt']
};

/* =========================================================
 * 初期セットアップ（エディタから1回実行）
 * ========================================================= */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('SPREADSHEET_ID');
  const ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.create(APP_NAME + ' DB');
  props.setProperty('SPREADSHEET_ID', ss.getId());

  Object.keys(SHEETS).forEach(function (name) {
    const s = ss.getSheetByName(name) || ss.insertSheet(name);
    const h = SHEETS[name];
    if (s.getMaxColumns() < h.length) s.insertColumnsAfter(s.getMaxColumns(), h.length - s.getMaxColumns());
    s.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#E6EBE3');
    s.setFrozenRows(1);
    s.getRange(1, 1, s.getMaxRows(), h.length).setNumberFormat('@');
  });
  ['Sheet1', 'シート1'].forEach(function (n) {
    const d = ss.getSheetByName(n);
    if (d && ss.getSheets().length > 1) ss.deleteSheet(d);
  });

  const folderId = props.getProperty('DRIVE_FOLDER_ID');
  const root = folderId ? DriveApp.getFolderById(folderId) : DriveApp.createFolder(APP_NAME + ' Media');
  props.setProperty('DRIVE_FOLDER_ID', root.getId());
  ['photos', 'videos', 'gpx'].forEach(function (n) {
    if (!root.getFoldersByName(n).hasNext()) root.createFolder(n);
  });

  if (!props.getProperty('PEPPER')) props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());

  Logger.log('スプレッドシート: ' + ss.getUrl());
  Logger.log('Driveフォルダ: ' + root.getUrl());
  Logger.log('次に GEMINI_API_KEY などをスクリプトプロパティに設定し、ウェブアプリとしてデプロイしてください');
}

/* =========================================================
 * エントリポイント
 * ========================================================= */
function doGet(e) {
  if (e && e.parameter && e.parameter.api) {
    return json_({ ok: true, app: APP_NAME, time: nowIso_() });
  }
  // GAS単体でホストする場合: index / style / app の3つのHTMLファイルを結合して返す
  try {
    const read = function (n) { return HtmlService.createHtmlOutputFromFile(n).getContent(); };
    let html = read('index');
    const css = read('style');
    const js = read('app');
    html = html
      .replace('<link rel="stylesheet" href="style.css">', function () { return '<style>\n' + css + '\n</style>'; })
      .replace('<script src="app.js"></script>', function () { return '<script>\n' + js + '\n</script>'; });
    return HtmlService.createHtmlOutput(html)
      .setTitle(APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return json_({ ok: true, app: APP_NAME, mode: 'api' });
  }
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  return json_(dispatch_(p));
}

/** GAS単体ホスト時に google.script.run から呼ばれる */
function apiRun(payload) {
  let p;
  try { p = JSON.parse(payload); } catch (err) { return JSON.stringify({ ok: false, error: 'リクエストの形式が正しくありません' }); }
  return JSON.stringify(dispatch_(p));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

const PUBLIC_ACTIONS = {
  ping: function () { return { pong: true, time: nowIso_() }; },
  getConfig: getConfig_,
  register: register_,
  login: login_,
  resetPassword: resetPassword_,
  listRoutes: listRoutes_,
  getRoute: getRoute_,
  exportGpx: exportGpx_,
  listSpots: listSpots_
};

const AUTH_ACTIONS = {
  me: function (p, u) { return { user: publicUser_(u) }; },
  logout: logout_,
  changePassword: changePassword_,
  saveRoute: saveRoute_,
  deleteRoute: deleteRoute_,
  saveSpot: saveSpot_,
  deleteSpot: deleteSpot_,
  uploadMedia: uploadMedia_,
  listMedia: listMedia_,
  deleteMedia: deleteMedia_,
  toggleLike: toggleLike_,
  addComment: addComment_,
  editComment: editComment_,
  deleteComment: deleteComment_,
  extractFromUrl: extractFromUrl_,
  estimatePhotoLocation: estimatePhotoLocation_,
  planRoute: planRoute_
};

function dispatch_(p) {
  try {
    if (!P_('SPREADSHEET_ID')) throw new Error('初期設定が済んでいません。GASエディタで setup を実行してください');
    const action = String(p.action || '');
    const user = p.token ? userFromToken_(String(p.token)) : null;
    if (PUBLIC_ACTIONS[action]) return { ok: true, data: PUBLIC_ACTIONS[action](p, user) };
    if (!AUTH_ACTIONS[action]) return { ok: false, error: '不明な操作です: ' + action };
    if (!user) return { ok: false, code: 'AUTH', error: 'ログインしてください' };
    if (user.mustChange === '1' && ['me', 'logout', 'changePassword'].indexOf(action) < 0) {
      return { ok: false, code: 'MUST_CHANGE', error: '仮パスワードのままです。新しいパスワードを設定してください' };
    }
    return { ok: true, data: AUTH_ACTIONS[action](p, user) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function getConfig_() {
  return {
    appName: APP_NAME,
    geminiEnabled: !!P_('GEMINI_API_KEY'),
    orsEnabled: !!P_('ORS_API_KEY'),
    categories: CATEGORIES
  };
}

/* =========================================================
 * 会員認証
 * ========================================================= */
function register_(p) {
  const email = normEmail_(p.email);
  const nickname = cleanText_(p.nickname, 20);
  if (!isEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');
  if (!nickname) throw new Error('ニックネームを入力してください');
  return withLock_(function () {
    if (findBy_('Users', 'email', email)) {
      throw new Error('このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワード再発行」から手続きしてください');
    }
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    sendMail_(email, '仮パスワードのお知らせ',
      nickname + ' さん\n\n' + APP_NAME + ' へのご登録ありがとうございます。\n\n' +
      '仮パスワード: ' + temp + '\n\n' +
      'ログインすると新しいパスワードの設定画面が表示されます。\n' + (P_('APP_URL') || '') + '\n\n' +
      '※このメールに心当たりがない場合は破棄してください。');
    appendRows_('Users', [{
      userId: newId_('u'), email: email, nickname: nickname,
      passwordHash: hash_(temp, salt), salt: salt, mustChange: '1', failCount: '0', lockedUntil: '',
      role: 'member', status: 'active', createdAt: nowIso_(), lastLoginAt: ''
    }]);
    return { message: '仮パスワードをメールで送信しました。メールに記載のパスワードでログインしてください' };
  });
}

function login_(p) {
  const email = normEmail_(p.email);
  const pw = String(p.password || '');
  const bad = 'メールアドレスまたはパスワードが違います';
  return withLock_(function () {
    const u = findBy_('Users', 'email', email);
    if (!u) throw new Error(bad);
    if (u.status === 'suspended') throw new Error('このアカウントは利用停止中です');
    if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) {
      throw new Error('ログインに' + LOCK_LIMIT + '回失敗したため一時的にロックしています。' + LOCK_MINUTES + '分ほどおいて再度お試しください');
    }
    if (hash_(pw, u.salt) !== u.passwordHash) {
      const n = Number(u.failCount || 0) + 1;
      if (n >= LOCK_LIMIT) {
        u.failCount = '0';
        u.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        updateRow_('Users', u);
        throw new Error('ログインに' + LOCK_LIMIT + '回失敗したため、' + LOCK_MINUTES + '分間ロックしました');
      }
      u.failCount = String(n);
      updateRow_('Users', u);
      throw new Error(bad + '（あと' + (LOCK_LIMIT - n) + '回失敗するとロックされます）');
    }
    u.failCount = '0';
    u.lockedUntil = '';
    u.lastLoginAt = nowIso_();
    updateRow_('Users', u);
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    CacheService.getScriptCache().put('s_' + token, u.userId, SESSION_TTL);
    return { token: token, user: publicUser_(u) };
  });
}

function logout_(p) {
  CacheService.getScriptCache().remove('s_' + String(p.token || ''));
  return { message: 'ログアウトしました' };
}

function changePassword_(p, u) {
  const current = String(p.current || '');
  const np = String(p.newPassword || '');
  if (hash_(current, u.salt) !== u.passwordHash) throw new Error('現在のパスワードが違います');
  if (np.length < 8 || !/[A-Za-z]/.test(np) || !/\d/.test(np)) {
    throw new Error('新しいパスワードは英字と数字を含む8文字以上にしてください');
  }
  if (np === current) throw new Error('現在と同じパスワードは使えません');
  return withLock_(function () {
    const row = findBy_('Users', 'userId', u.userId);
    row.salt = Utilities.getUuid();
    row.passwordHash = hash_(np, row.salt);
    row.mustChange = '0';
    updateRow_('Users', row);
    return { user: publicUser_(row), message: 'パスワードを変更しました' };
  });
}

function resetPassword_(p) {
  const email = normEmail_(p.email);
  if (!isEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');
  const msg = { message: '登録済みのメールアドレスであれば、仮パスワードを送信しました' };
  const cache = CacheService.getScriptCache();
  if (cache.get('rp_' + email)) return msg;         // 60秒以内の連続送信を防止
  cache.put('rp_' + email, '1', 60);
  return withLock_(function () {
    const u = findBy_('Users', 'email', email);
    if (!u || u.status === 'suspended') return msg;
    const temp = tempPassword_();
    sendMail_(email, '仮パスワード再発行のお知らせ',
      u.nickname + ' さん\n\nパスワード再発行のご依頼を受け付けました。\n\n' +
      '仮パスワード: ' + temp + '\n\n' +
      'ログイン後、新しいパスワードを設定してください。\n' + (P_('APP_URL') || '') + '\n\n' +
      '※お心当たりがない場合は、このメールを破棄してください。これまでのパスワードは無効になっています。');
    u.salt = Utilities.getUuid();
    u.passwordHash = hash_(temp, u.salt);
    u.mustChange = '1';
    u.failCount = '0';
    u.lockedUntil = '';
    updateRow_('Users', u);
    return msg;
  });
}

function userFromToken_(token) {
  const cache = CacheService.getScriptCache();
  const uid = cache.get('s_' + token);
  if (!uid) return null;
  const u = findBy_('Users', 'userId', uid);
  if (!u || u.status === 'suspended') return null;
  cache.put('s_' + token, uid, SESSION_TTL);   // 利用のたびに延長
  return u;
}

function publicUser_(u) {
  return { userId: u.userId, email: u.email, nickname: u.nickname, role: u.role, mustChange: u.mustChange === '1' };
}

function hash_(pw, salt) {
  let h = salt + ':' + pw + ':' + P_('PEPPER');
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[(bytes[i] & 0xff) % chars.length];
  return s;
}

function sendMail_(to, subject, body) {
  GmailApp.sendEmail(to, '[' + APP_NAME + '] ' + subject, body, { name: APP_NAME });
}

/* =========================================================
 * ルート
 * ========================================================= */
function listRoutes_(p, u) {
  const f = p.filters || {};
  const users = userMap_();
  let rows = readAll_('Routes').filter(function (r) { return canView_(r, u); });

  if (f.mine) rows = rows.filter(function (r) { return u && r.userId === u.userId; });
  if (f.keyword) {
    const k = String(f.keyword).toLowerCase();
    rows = rows.filter(function (r) { return (r.title + ' ' + r.description + ' ' + r.tags).toLowerCase().indexOf(k) >= 0; });
  }
  if (num_(f.maxGain) != null) rows = rows.filter(function (r) { return Number(r.elevGainM || 0) <= Number(f.maxGain); });
  if (num_(f.maxDistanceKm) != null) rows = rows.filter(function (r) { return Number(r.distanceM || 0) <= Number(f.maxDistanceKm) * 1000; });
  if (Array.isArray(f.tags) && f.tags.length) {
    rows = rows.filter(function (r) {
      const t = String(r.tags || '').split(',');
      return f.tags.every(function (x) { return t.indexOf(x) >= 0; });
    });
  }
  if (f.pedestrian) {
    rows = rows.filter(function (r) {
      return Number(r.pedestrianRatio || 0) >= 0.6 || /車少なめ|歩道・遊歩道中心/.test(String(r.tags || ''));
    });
  }
  if (f.near && num_(f.near.lat) != null && num_(f.near.lng) != null) {
    const km = Number(f.near.km || 30);
    rows = rows.filter(function (r) {
      return haversine_({ lat: Number(f.near.lat), lng: Number(f.near.lng) }, { lat: Number(r.startLat), lng: Number(r.startLng) }) <= km * 1000;
    });
  }

  const gainPerKm = function (r) { return Number(r.elevGainM || 0) / Math.max(Number(r.distanceM || 0) / 1000, 0.5); };
  const sort = f.sort || 'flat';
  if (sort === 'flat') rows.sort(function (a, b) { return gainPerKm(a) - gainPerKm(b); });
  else if (sort === 'gain') rows.sort(function (a, b) { return Number(a.elevGainM || 0) - Number(b.elevGainM || 0); });
  else if (sort === 'popular') rows.sort(function (a, b) { return Number(b.likeCount || 0) - Number(a.likeCount || 0); });
  else rows.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });

  return {
    total: rows.length,
    routes: rows.slice(0, 100).map(function (r) { return routeOut_(r, users, u); })
  };
}

function getRoute_(p, u) {
  const r = findBy_('Routes', 'routeId', String(p.routeId || ''));
  if (!r || !canView_(r, u)) throw new Error('ルートが見つからないか、閲覧する権限がありません');
  const users = userMap_();
  const inter = readAll_('Interactions').filter(function (i) { return i.routeId === r.routeId; });
  const likes = inter.filter(function (i) { return i.type === 'like'; });
  const comments = !u ? [] : inter
    .filter(function (i) { return i.type === 'comment'; })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); })
    .map(function (c) { return commentOut_(c, u, users); });
  const media = readAll_('Media')
    .filter(function (m) { return m.routeId === r.routeId; })
    .map(function (m) { return mediaOut_(m, u); });
  return {
    route: routeOut_(r, users, u),
    points: readPoints_(r.routeId),
    likeCount: likes.length,
    likedByMe: !!u && likes.some(function (l) { return l.userId === u.userId; }),
    comments: comments,
    commentCount: inter.filter(function (i) { return i.type === 'comment'; }).length,
    media: media
  };
}

function saveRoute_(p, u) {
  const r = p.route || {};
  const hasPts = Array.isArray(p.points) && p.points.length > 0;
  const pts = hasPts ? parsePoints_(p.points) : null;
  if (hasPts && pts.length < 2) throw new Error('ルートには2地点以上の位置情報が必要です');

  return withLock_(function () {
    const now = nowIso_();
    let row = r.routeId ? findBy_('Routes', 'routeId', String(r.routeId)) : null;
    if (r.routeId && !row) throw new Error('ルートが見つかりません');
    if (row && row.userId !== u.userId) throw new Error('このルートを編集する権限がありません');
    if (!row && !pts) throw new Error('経路データがありません');

    const isNew = !row;
    if (isNew) {
      row = {
        routeId: newId_('r'), userId: u.userId, likeCount: '0', commentCount: '0', createdAt: now,
        gpxFileId: '', pedestrianRatio: '', source: cleanText_(r.source, 20) || 'manual'
      };
    }
    row.title = cleanText_(r.title, 60) || '無題のルート';
    row.description = cleanText_(r.description, 2000);
    row.visibility = VISIBILITY.indexOf(r.visibility) >= 0 ? r.visibility : 'private';   // 既定は非公開
    row.tags = (Array.isArray(r.tags) ? r.tags : [])
      .map(function (t) { return cleanText_(t, 20).replace(/,/g, ''); })
      .filter(Boolean).slice(0, 10).join(',');
    if (num_(r.pedestrianRatio) != null) row.pedestrianRatio = String(Math.max(0, Math.min(1, Number(r.pedestrianRatio))));
    row.updatedAt = now;

    if (pts) {
      const st = computeStats_(pts);
      row.distanceM = String(Math.round(st.distanceM));
      row.elevGainM = String(Math.round(st.gainM));
      row.elevLossM = String(Math.round(st.lossM));
      row.maxEleM = st.maxEle == null ? '' : String(Math.round(st.maxEle));
      row.minEleM = st.minEle == null ? '' : String(Math.round(st.minEle));
      row.durationSec = String(num_(r.durationSec) != null ? Math.round(Number(r.durationSec)) : Math.round(st.durationSec));
      row.pointCount = String(pts.length);
      row.startLat = String(pts[0].lat);
      row.startLng = String(pts[0].lng);
      row.minLat = String(st.minLat); row.minLng = String(st.minLng);
      row.maxLat = String(st.maxLat); row.maxLng = String(st.maxLng);
      if (!isNew) deletePoints_(row.routeId);
      appendRows_('Waypoints', pts.map(function (q, i) {
        return {
          routeId: row.routeId, seq: i, lat: q.lat.toFixed(6), lng: q.lng.toFixed(6),
          ele: q.ele == null ? '' : (Math.round(q.ele * 10) / 10), time: q.time || ''
        };
      }));
      row.gpxFileId = saveGpxFile_(row, pts, row.gpxFileId);
    }

    if (isNew) appendRows_('Routes', [row]);
    else updateRow_('Routes', row);
    return { route: routeOut_(row, userMap_(), u) };
  });
}

function deleteRoute_(p, u) {
  return withLock_(function () {
    const r = findBy_('Routes', 'routeId', String(p.routeId || ''));
    if (!r) throw new Error('ルートが見つかりません');
    if (r.userId !== u.userId) throw new Error('このルートを削除する権限がありません');
    deletePoints_(r.routeId);
    deleteWhere_('Interactions', function (i) { return i.routeId === r.routeId; });
    deleteWhere_('Media', function (m) {
      if (m.routeId !== r.routeId) return false;
      trash_(m.fileId);
      return true;
    });
    trash_(r.gpxFileId);
    const again = findBy_('Routes', 'routeId', r.routeId);
    if (again) deleteRow_('Routes', again._row, 1);
    return { deleted: true };
  });
}

function exportGpx_(p, u) {
  const r = findBy_('Routes', 'routeId', String(p.routeId || ''));
  if (!r || !canView_(r, u)) throw new Error('ルートが見つからないか、閲覧する権限がありません');
  const pts = readPoints_(r.routeId);
  return {
    filename: (r.title || 'route').replace(/[\\/:*?"<>|]/g, '_') + '.gpx',
    gpx: buildGpx_(r.title, r.description, pts)
  };
}

function routeOut_(r, users, u) {
  return {
    routeId: r.routeId, userId: r.userId,
    nickname: (users[r.userId] || {}).nickname || '退会した会員',
    title: r.title, description: r.description, visibility: r.visibility || 'private',
    tags: String(r.tags || '').split(',').filter(Boolean), source: r.source,
    distanceM: num_(r.distanceM), elevGainM: num_(r.elevGainM), elevLossM: num_(r.elevLossM),
    maxEleM: num_(r.maxEleM), minEleM: num_(r.minEleM), durationSec: num_(r.durationSec),
    pointCount: num_(r.pointCount), startLat: num_(r.startLat), startLng: num_(r.startLng),
    pedestrianRatio: num_(r.pedestrianRatio), likeCount: num_(r.likeCount) || 0,
    commentCount: num_(r.commentCount) || 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
    mine: !!u && u.userId === r.userId
  };
}

/* ---------- 地点データ（Waypoints シート） ---------- */
function parsePoints_(arr) {
  let pts = [];
  arr.forEach(function (a) {
    const lat = Number(a[0]), lng = Number(a[1]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    const ele = a[2] === null || a[2] === '' || a[2] === undefined || !isFinite(Number(a[2])) ? null : Number(a[2]);
    const time = a[3] ? cleanText_(a[3], 40) : '';
    pts.push({ lat: lat, lng: lng, ele: ele, time: time });
  });
  if (pts.length > MAX_POINTS) {        // 上限を超えた分は等間隔に間引く
    const step = pts.length / MAX_POINTS;
    const out = [];
    for (let i = 0; i < MAX_POINTS - 1; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function pointRows_(routeId) {
  const s = sh_('Waypoints');
  const last = s.getLastRow();
  if (last < 2) return [];
  return s.getRange(2, 1, last - 1, 1).createTextFinder(routeId).matchEntireCell(true).findAll()
    .map(function (rg) { return rg.getRow(); });
}

function readPoints_(routeId) {
  const rows = pointRows_(routeId);
  if (!rows.length) return [];
  const min = Math.min.apply(null, rows);
  const max = Math.max.apply(null, rows);
  const vals = sh_('Waypoints').getRange(min, 1, max - min + 1, SHEETS.Waypoints.length).getValues();
  return vals
    .filter(function (v) { return String(v[0]) === routeId; })
    .sort(function (a, b) { return Number(a[1]) - Number(b[1]); })
    .map(function (v) {
      return {
        lat: Number(v[2]), lng: Number(v[3]),
        ele: v[4] === '' ? null : Number(v[4]),
        time: v[5] instanceof Date ? v[5].toISOString() : (v[5] ? String(v[5]) : null)
      };
    });
}

function deletePoints_(routeId) {
  const rows = pointRows_(routeId).sort(function (a, b) { return a - b; });
  if (!rows.length) return;
  const blocks = [];
  let start = rows[0], prev = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] === prev + 1) { prev = rows[i]; continue; }
    blocks.push([start, prev]);
    start = prev = rows[i];
  }
  blocks.push([start, prev]);
  for (let i = blocks.length - 1; i >= 0; i--) deleteRow_('Waypoints', blocks[i][0], blocks[i][1] - blocks[i][0] + 1);
}

/* ---------- 統計・GPX ---------- */
function computeStats_(pts) {
  let dist = 0, gain = 0, loss = 0, maxE = null, minE = null, lastE = null;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    if (i > 0) dist += haversine_(pts[i - 1], a);
    minLat = Math.min(minLat, a.lat); maxLat = Math.max(maxLat, a.lat);
    minLng = Math.min(minLng, a.lng); maxLng = Math.max(maxLng, a.lng);
    if (a.ele != null && isFinite(a.ele)) {
      maxE = maxE == null ? a.ele : Math.max(maxE, a.ele);
      minE = minE == null ? a.ele : Math.min(minE, a.ele);
      if (lastE == null) lastE = a.ele;
      else {
        const d = a.ele - lastE;
        if (d >= 3) { gain += d; lastE = a.ele; }          // 3mのヒステリシスでGPSノイズを除去
        else if (d <= -3) { loss -= d; lastE = a.ele; }
      }
    }
  }
  const t0 = pts[0].time ? Date.parse(pts[0].time) : NaN;
  const t1 = pts[pts.length - 1].time ? Date.parse(pts[pts.length - 1].time) : NaN;
  return {
    distanceM: dist, gainM: gain, lossM: loss, maxEle: maxE, minEle: minE,
    durationSec: isFinite(t0) && isFinite(t1) ? Math.max(0, (t1 - t0) / 1000) : 0,
    minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng
  };
}

function haversine_(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildGpx_(name, desc, pts) {
  const x = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  const seg = pts.map(function (q) {
    return '      <trkpt lat="' + q.lat + '" lon="' + q.lng + '">' +
      (q.ele != null ? '<ele>' + q.ele + '</ele>' : '') +
      (q.time ? '<time>' + x(q.time) + '</time>' : '') + '</trkpt>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="' + x(APP_NAME) + '" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '  <metadata><name>' + x(name) + '</name>' + (desc ? '<desc>' + x(desc) + '</desc>' : '') +
    '<time>' + nowIso_() + '</time></metadata>\n' +
    '  <trk><name>' + x(name) + '</name>\n    <trkseg>\n' + seg + '\n    </trkseg>\n  </trk>\n</gpx>\n';
}

function saveGpxFile_(row, pts, oldId) {
  trash_(oldId);
  const blob = Utilities.newBlob(buildGpx_(row.title, row.description, pts), 'application/gpx+xml', row.routeId + '.gpx');
  return subFolder_('gpx').createFile(blob).getId();
}

/* =========================================================
 * スポット
 * ========================================================= */
function listSpots_(p, u) {
  const users = userMap_();
  let rows = readAll_('Spots').filter(function (s) { return canView_(s, u); });
  const b = p.bbox;
  if (b && num_(b.s) != null) {
    rows = rows.filter(function (s) {
      const lat = Number(s.lat), lng = Number(s.lng);
      return lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e;
    });
  }
  if (p.category) rows = rows.filter(function (s) { return s.category === p.category; });
  if (p.keyword) {
    const k = String(p.keyword).toLowerCase();
    rows = rows.filter(function (s) { return (s.name + ' ' + s.description + ' ' + s.specialty).toLowerCase().indexOf(k) >= 0; });
  }
  if (p.mine) rows = rows.filter(function (s) { return u && s.userId === u.userId; });
  return { spots: rows.slice(0, 500).map(function (s) { return spotOut_(s, users, u); }) };
}

function saveSpot_(p, u) {
  const s = p.spot || {};
  const lat = Number(s.lat), lng = Number(s.lng);
  if (!isFinite(lat) || !isFinite(lng)) throw new Error('位置が指定されていません');
  const name = cleanText_(s.name, 60);
  if (!name) throw new Error('スポット名を入力してください');
  const url = cleanText_(s.url, 500);
  if (url && !/^https?:\/\//i.test(url)) throw new Error('URLは http:// または https:// で始めてください');

  return withLock_(function () {
    const now = nowIso_();
    let row = s.spotId ? findBy_('Spots', 'spotId', String(s.spotId)) : null;
    if (s.spotId && !row) throw new Error('スポットが見つかりません');
    if (row && row.userId !== u.userId) throw new Error('このスポットを編集する権限がありません');
    const isNew = !row;
    if (isNew) row = { spotId: newId_('s'), userId: u.userId, createdAt: now, source: cleanText_(s.source, 20) || 'manual' };
    row.name = name;
    row.category = CATEGORIES.indexOf(s.category) >= 0 ? s.category : 'view';
    row.lat = lat.toFixed(6);
    row.lng = lng.toFixed(6);
    row.description = cleanText_(s.description, 1000);
    row.specialty = cleanText_(s.specialty, 200);
    row.url = url;
    row.visibility = VISIBILITY.indexOf(s.visibility) >= 0 ? s.visibility : 'private';
    row.updatedAt = now;
    if (isNew) appendRows_('Spots', [row]);
    else updateRow_('Spots', row);
    return { spot: spotOut_(row, userMap_(), u) };
  });
}

function deleteSpot_(p, u) {
  return withLock_(function () {
    const s = findBy_('Spots', 'spotId', String(p.spotId || ''));
    if (!s) throw new Error('スポットが見つかりません');
    if (s.userId !== u.userId) throw new Error('このスポットを削除する権限がありません');
    deleteWhere_('Media', function (m) {
      if (m.spotId !== s.spotId) return false;
      trash_(m.fileId);
      return true;
    });
    const again = findBy_('Spots', 'spotId', s.spotId);
    if (again) deleteRow_('Spots', again._row, 1);
    return { deleted: true };
  });
}

function spotOut_(s, users, u) {
  return {
    spotId: s.spotId, userId: s.userId, nickname: (users[s.userId] || {}).nickname || '',
    name: s.name, category: s.category, lat: Number(s.lat), lng: Number(s.lng),
    description: s.description, specialty: s.specialty, url: s.url,
    visibility: s.visibility || 'private', source: s.source, updatedAt: s.updatedAt,
    mine: !!u && u.userId === s.userId
  };
}

/* =========================================================
 * メディア（Google Drive）
 * ========================================================= */
function uploadMedia_(p, u) {
  const mime = String(p.mimeType || '');
  if (!/^(image|video)\//.test(mime)) throw new Error('写真または動画のみアップロードできます');
  if (p.routeId) {
    const r = findBy_('Routes', 'routeId', String(p.routeId));
    if (!r || r.userId !== u.userId) throw new Error('自分のルートにのみ写真・動画を追加できます');
  }
  if (p.spotId) {
    const s = findBy_('Spots', 'spotId', String(p.spotId));
    if (!s || s.userId !== u.userId) throw new Error('自分のスポットにのみ写真・動画を追加できます');
  }
  const bytes = Utilities.base64Decode(String(p.data || ''));
  if (!bytes.length) throw new Error('ファイルが空です');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('ファイルが大きすぎます（30MBまで）');

  const isVideo = mime.indexOf('video/') === 0;
  const name = cleanText_(p.fileName, 100) || ('media_' + Date.now());
  const file = subFolder_(isVideo ? 'videos' : 'photos').createFile(Utilities.newBlob(bytes, mime, name));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    console.warn('共有設定に失敗: ' + err);
  }
  const id = file.getId();
  const row = {
    mediaId: newId_('m'), userId: u.userId, routeId: p.routeId || '', spotId: p.spotId || '',
    fileId: id, mimeType: mime, fileName: name,
    thumbUrl: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w600',
    viewUrl: isVideo ? 'https://drive.google.com/file/d/' + id + '/preview' : 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1800',
    lat: num_(p.lat) == null ? '' : Number(p.lat).toFixed(6),
    lng: num_(p.lng) == null ? '' : Number(p.lng).toFixed(6),
    takenAt: cleanText_(p.takenAt, 40), caption: cleanText_(p.caption, 200), createdAt: nowIso_()
  };
  withLock_(function () { appendRows_('Media', [row]); });
  return { media: mediaOut_(row, u) };
}

function listMedia_(p, u) {
  let rows = readAll_('Media');
  if (p.routeId) {
    const r = findBy_('Routes', 'routeId', String(p.routeId));
    if (!r || !canView_(r, u)) throw new Error('閲覧する権限がありません');
    rows = rows.filter(function (m) { return m.routeId === r.routeId; });
  } else if (p.spotId) {
    const s = findBy_('Spots', 'spotId', String(p.spotId));
    if (!s || !canView_(s, u)) throw new Error('閲覧する権限がありません');
    rows = rows.filter(function (m) { return m.spotId === s.spotId; });
  } else {
    rows = rows.filter(function (m) { return m.userId === u.userId; });
  }
  return { media: rows.map(function (m) { return mediaOut_(m, u); }) };
}

function deleteMedia_(p, u) {
  return withLock_(function () {
    const m = findBy_('Media', 'mediaId', String(p.mediaId || ''));
    if (!m) throw new Error('ファイルが見つかりません');
    if (m.userId !== u.userId) throw new Error('このファイルを削除する権限がありません');
    trash_(m.fileId);
    deleteRow_('Media', m._row, 1);
    return { deleted: true };
  });
}

function mediaOut_(m, u) {
  return {
    mediaId: m.mediaId, userId: m.userId, routeId: m.routeId, spotId: m.spotId,
    mimeType: m.mimeType, fileName: m.fileName, thumbUrl: m.thumbUrl, viewUrl: m.viewUrl,
    lat: num_(m.lat), lng: num_(m.lng), takenAt: m.takenAt, caption: m.caption, createdAt: m.createdAt,
    mine: !!u && u.userId === m.userId
  };
}

/* =========================================================
 * いいね・コメント（会員限定）
 * ========================================================= */
function toggleLike_(p, u) {
  return withLock_(function () {
    const r = viewableRoute_(p.routeId, u);
    const mine = readAll_('Interactions').find(function (i) {
      return i.type === 'like' && i.routeId === r.routeId && i.userId === u.userId;
    });
    if (mine) deleteRow_('Interactions', mine._row, 1);
    else {
      appendRows_('Interactions', [{
        interactionId: newId_('l'), type: 'like', routeId: r.routeId, userId: u.userId,
        nickname: u.nickname, content: '', createdAt: nowIso_(), updatedAt: ''
      }]);
    }
    const counts = recount_(r.routeId);
    return { liked: !mine, likeCount: counts.likeCount };
  });
}

function addComment_(p, u) {
  const content = cleanText_(p.content, 1000);
  if (!content) throw new Error('コメントを入力してください');
  return withLock_(function () {
    const r = viewableRoute_(p.routeId, u);
    const row = {
      interactionId: newId_('c'), type: 'comment', routeId: r.routeId, userId: u.userId,
      nickname: u.nickname, content: content, createdAt: nowIso_(), updatedAt: ''
    };
    appendRows_('Interactions', [row]);
    const counts = recount_(r.routeId);
    return { comment: commentOut_(row, u, userMap_()), commentCount: counts.commentCount };
  });
}

function editComment_(p, u) {
  const content = cleanText_(p.content, 1000);
  if (!content) throw new Error('コメントを入力してください');
  return withLock_(function () {
    const c = findBy_('Interactions', 'interactionId', String(p.commentId || ''));
    if (!c || c.type !== 'comment') throw new Error('コメントが見つかりません');
    if (c.userId !== u.userId) throw new Error('自分のコメントのみ編集できます');
    c.content = content;
    c.updatedAt = nowIso_();
    updateRow_('Interactions', c);
    return { comment: commentOut_(c, u, userMap_()) };
  });
}

function deleteComment_(p, u) {
  return withLock_(function () {
    const c = findBy_('Interactions', 'interactionId', String(p.commentId || ''));
    if (!c || c.type !== 'comment') throw new Error('コメントが見つかりません');
    if (c.userId !== u.userId) throw new Error('自分のコメントのみ削除できます');
    deleteRow_('Interactions', c._row, 1);
    const counts = recount_(c.routeId);
    return { deleted: true, commentCount: counts.commentCount };
  });
}

function viewableRoute_(routeId, u) {
  const r = findBy_('Routes', 'routeId', String(routeId || ''));
  if (!r || !canView_(r, u)) throw new Error('ルートが見つからないか、閲覧する権限がありません');
  return r;
}

function recount_(routeId) {
  const all = readAll_('Interactions').filter(function (i) { return i.routeId === routeId; });
  const likeCount = all.filter(function (i) { return i.type === 'like'; }).length;
  const commentCount = all.filter(function (i) { return i.type === 'comment'; }).length;
  const r = findBy_('Routes', 'routeId', routeId);
  if (r) {
    r.likeCount = String(likeCount);
    r.commentCount = String(commentCount);
    updateRow_('Routes', r);
  }
  return { likeCount: likeCount, commentCount: commentCount };
}

function commentOut_(c, u, users) {
  return {
    commentId: c.interactionId, userId: c.userId,
    nickname: (users[c.userId] || {}).nickname || c.nickname || '退会した会員',
    content: c.content, createdAt: c.createdAt, updatedAt: c.updatedAt,
    mine: !!u && u.userId === c.userId
  };
}

/* =========================================================
 * Gemini 連携
 * ========================================================= */
function callGemini_(parts) {
  const key = P_('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が設定されていないため、AI機能は使えません');
  const model = P_('GEMINI_MODEL', 'gemini-2.5-flash');
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    })
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('AIの呼び出しに失敗しました（' + code + '）: ' + res.getContentText().slice(0, 200));
  const j = JSON.parse(res.getContentText());
  const cand = (j.candidates || [])[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(function (x) { return x.text || ''; }).join('') : '';
  if (!text) throw new Error('AIから回答が得られませんでした');
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    throw new Error('AIの回答を読み取れませんでした。もう一度お試しください');
  }
}

/** 外部ページ(URL)または貼り付けテキストから、コース・スポット・名物を構造化抽出 */
function extractFromUrl_(p, u) {
  const url = cleanText_(p.url, 1000);
  let body = cleanText_(p.text, 40000);
  if (url) body = fetchPageText_(url).slice(0, 40000);
  if (!body || body.length < 50) throw new Error('読み取れる本文が少なすぎます。本文を貼り付けてお試しください');

  const prompt =
    'あなたはハイキング情報の編集者です。次のページ本文から情報を抽出し、以下の形のJSONだけを返してください。\n' +
    '本文に書かれていない値は null にし、数値を推測で作らないでください。\n' +
    '{\n' +
    ' "course": {"title": string, "summary": string(200字以内), "area": string|null, "distanceKm": number|null,\n' +
    '   "elevationGainM": number|null, "elevationDiff": string|null, "durationMin": number|null,\n' +
    '   "difficulty": "やさしい"|"ふつう"|"きつい"|null, "start": string|null, "goal": string|null, "access": string|null},\n' +
    ' "spots": [{"name": string, "category": "camp"|"michinoeki"|"onsen"|"shop"|"view"|"food"|"souvenir",\n' +
    '   "description": string(80字以内), "specialty": string|null, "addressHint": string|null}],\n' +
    ' "specialties": [{"name": string, "description": string(60字以内), "where": string|null}]\n' +
    '}\n' +
    'category の意味: camp=キャンプ場, michinoeki=道の駅, onsen=温泉, shop=買い物, view=景色の良い場所, food=飲食店, souvenir=名物・お土産の店。\n' +
    'addressHint には市町村名や山域など、地図検索の手がかりになる語を入れてください。\n\n' +
    '本文:\n"""\n' + body + '\n"""';

  const out = callGemini_([{ text: prompt }]);
  const course = out.course || {};
  const spots = (Array.isArray(out.spots) ? out.spots : []).slice(0, 40).map(function (s) {
    return {
      name: cleanText_(s.name, 60), category: CATEGORIES.indexOf(s.category) >= 0 ? s.category : 'view',
      description: cleanText_(s.description, 200), specialty: cleanText_(s.specialty, 200),
      addressHint: cleanText_(s.addressHint, 100)
    };
  }).filter(function (s) { return s.name; });
  const specialties = (Array.isArray(out.specialties) ? out.specialties : []).slice(0, 20).map(function (s) {
    return { name: cleanText_(s.name, 60), description: cleanText_(s.description, 200), where: cleanText_(s.where, 100) };
  }).filter(function (s) { return s.name; });
  return { sourceUrl: url, course: course, spots: spots, specialties: specialties };
}

function fetchPageText_(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URLは http:// または https:// で始めてください');
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'Accept-Language': 'ja,en;q=0.8' }
  });
  const code = res.getResponseCode();
  if (code >= 400) throw new Error('ページを取得できませんでした（' + code + '）。本文を貼り付けてお試しください');
  const blob = res.getBlob();
  let html = blob.getDataAsString('UTF-8');
  const headers = res.getHeaders();
  const ct = String(headers['Content-Type'] || headers['content-type'] || '');
  const m = (ct + ' ' + html.slice(0, 3000)).match(/charset=["']?([\w-]+)/i);
  if (m && /shift[_-]?jis|sjis|euc-jp|windows-31j/i.test(m[1])) {
    const cs = /euc/i.test(m[1]) ? 'EUC-JP' : 'Shift_JIS';
    html = blob.getDataAsString(cs);
  }
  return htmlToText_(html);
}

function htmlToText_(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|p|div|li|h\d|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** 位置情報のない写真の撮影地をAIで推定（経路生成アシスト） */
function estimatePhotoLocation_(p, u) {
  const data = String(p.image || '');
  if (!data) throw new Error('画像がありません');
  if (data.length > 6 * 1024 * 1024) throw new Error('画像が大きすぎます');
  const hint = cleanText_(p.hint, 300) || 'なし';
  const prompt =
    'この写真が撮影された場所を推定してください。手がかり: ' + hint + '\n' +
    '次のJSONだけを返してください:\n' +
    '{"placeName": string, "lat": number|null, "lng": number|null, "confidence": number(0〜1), "reason": string(60字以内)}\n' +
    '確信が持てない場合は confidence を低くし、lat と lng は null にしてください。';
  const out = callGemini_([{ text: prompt }, { inlineData: { mimeType: p.mimeType || 'image/jpeg', data: data } }]);
  return {
    placeName: cleanText_(out.placeName, 100),
    lat: num_(out.lat), lng: num_(out.lng),
    confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
    reason: cleanText_(out.reason, 200)
  };
}

/* =========================================================
 * 経路探索（openrouteservice foot-hiking）
 * ========================================================= */
function planRoute_(p, u) {
  const key = P_('ORS_API_KEY');
  if (!key) throw new Error('ORS_API_KEY が設定されていないため、経路探索は使えません');
  const coords = (Array.isArray(p.coords) ? p.coords : [])
    .map(function (c) { return [Number(c[1]), Number(c[0])]; })   // [lat,lng] → [lng,lat]
    .filter(function (c) { return isFinite(c[0]) && isFinite(c[1]); });
  if (coords.length < 2) throw new Error('出発地と目的地を指定してください');
  if (coords.length > 50) throw new Error('経由地は50地点までです');

  const pref = String(p.preference || 'flat');
  const body = {
    coordinates: coords, elevation: true, instructions: false,
    preference: pref === 'shortest' ? 'shortest' : 'recommended'
  };
  if (p.avoidSteps) body.options = { avoid_features: ['steps'] };
  if (coords.length === 2 && pref !== 'shortest') {
    body.alternative_routes = { target_count: 3, share_factor: 0.6, weight_factor: 1.6 };
  }
  const res = UrlFetchApp.fetch('https://api.openrouteservice.org/v2/directions/foot-hiking/geojson', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: key, Accept: 'application/geo+json, application/json' },
    payload: JSON.stringify(body)
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    let msg = res.getContentText().slice(0, 200);
    try { const e = JSON.parse(res.getContentText()); msg = (e.error && (e.error.message || e.error)) || msg; } catch (err) { }
    throw new Error('経路が見つかりませんでした（' + code + '）: ' + msg);
  }
  const j = JSON.parse(res.getContentText());
  const cands = (j.features || []).map(function (f, i) {
    const s = (f.properties && f.properties.summary) || {};
    return {
      index: i,
      points: f.geometry.coordinates.map(function (q) {
        return [q[1], q[0], q.length > 2 ? Math.round(q[2] * 10) / 10 : null];
      }),
      distanceM: Math.round(s.distance || 0),
      durationSec: Math.round(s.duration || 0),
      ascentM: Math.round((f.properties && f.properties.ascent) || 0),
      descentM: Math.round((f.properties && f.properties.descent) || 0)
    };
  });
  if (pref === 'flat') cands.sort(function (a, b) { return a.ascentM - b.ascentM || a.distanceM - b.distanceM; });
  else if (pref === 'shortest') cands.sort(function (a, b) { return a.distanceM - b.distanceM; });
  return { candidates: cands };
}

/* =========================================================
 * スプレッドシート / Drive ユーティリティ
 * ========================================================= */
let _ss = null;
const _rows = {};

function P_(k, d) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  return v == null || v === '' ? (d === undefined ? '' : d) : v;
}

function db_() {
  if (!_ss) _ss = SpreadsheetApp.openById(P_('SPREADSHEET_ID'));
  return _ss;
}

function sh_(name) {
  const s = db_().getSheetByName(name);
  if (!s) throw new Error('シート ' + name + ' がありません。setup を実行してください');
  return s;
}

function readAll_(name) {
  if (_rows[name]) return _rows[name];
  const s = sh_(name);
  const h = SHEETS[name];
  const last = s.getLastRow();
  if (last < 2) return (_rows[name] = []);
  const vals = s.getRange(2, 1, last - 1, h.length).getValues();
  const out = [];
  vals.forEach(function (r, i) {
    if (r[0] === '' || r[0] == null) return;
    const o = { _row: i + 2 };
    h.forEach(function (k, j) {
      const v = r[j];
      o[k] = v instanceof Date ? v.toISOString() : (v == null ? '' : String(v));
    });
    out.push(o);
  });
  return (_rows[name] = out);
}

function findBy_(name, key, val) {
  const v = String(val);
  return readAll_(name).find(function (o) { return o[key] === v; }) || null;
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  const s = sh_(name);
  const h = SHEETS[name];
  const rows = objs.map(function (o) {
    return h.map(function (k) { return o[k] === undefined || o[k] === null ? '' : String(o[k]); });
  });
  const start = s.getLastRow() + 1;
  const need = start + rows.length - 1 - s.getMaxRows();
  if (need > 0) s.insertRowsAfter(s.getMaxRows(), need);
  s.getRange(start, 1, rows.length, h.length).setNumberFormat('@').setValues(rows);
  delete _rows[name];
}

function updateRow_(name, obj) {
  const h = SHEETS[name];
  const row = h.map(function (k) { return obj[k] === undefined || obj[k] === null ? '' : String(obj[k]); });
  sh_(name).getRange(obj._row, 1, 1, h.length).setNumberFormat('@').setValues([row]);
  delete _rows[name];
}

function deleteRow_(name, start, count) {
  const s = sh_(name);
  // データ行をすべて消すとエラーになるため、空行を1行足してから削除する
  if (s.getMaxRows() - count <= s.getFrozenRows()) s.insertRowsAfter(s.getMaxRows(), 1);
  s.deleteRows(start, count);
  delete _rows[name];
}

function deleteWhere_(name, pred) {
  const rows = readAll_(name).filter(pred).map(function (o) { return o._row; }).sort(function (a, b) { return b - a; });
  rows.forEach(function (r) { deleteRow_(name, r, 1); });
  return rows.length;
}

function userMap_() {
  const m = {};
  readAll_('Users').forEach(function (u) { m[u.userId] = { nickname: u.nickname }; });
  return m;
}

function canView_(row, u) {
  if (u && u.userId === row.userId) return true;
  const v = row.visibility || 'private';
  if (v === 'public') return true;
  if (v === 'members') return !!u;
  return false;
}

function subFolder_(name) {
  const root = DriveApp.getFolderById(P_('DRIVE_FOLDER_ID'));
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function trash_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) { console.warn('削除に失敗: ' + fileId); }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('混み合っています。少し時間をおいて再度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function nowIso_() { return new Date().toISOString(); }

function num_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function cleanText_(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max || 500);
}

function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function isEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
