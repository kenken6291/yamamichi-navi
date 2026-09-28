# やまみちナビ（yamamichi-navi）

ハイキング向けWebナビ。GPS記録・GPX入出力・写真からの経路生成・経路探索（高低差優先）・沿道スポット検索・記事からのAI取り込み・会員限定のいいね／コメントに対応。

| ファイル | 置き場所 |
|---|---|
| `Code.gs` | Google Apps Script |
| `index.html` / `app.js` / `style.css` | GitHub Pages（リポジトリ直下） |

---

## 1. データモデル（Googleスプレッドシート）

`setup()` を実行すると6シートが自動作成されます。全セルは書式「書式なしテキスト」で保存します（数式の実行や日付の自動変換を防ぐため）。

### Users（会員）
| 列 | 内容 |
|---|---|
| userId | `u_` + 12桁ID |
| email | 小文字化したメールアドレス（一意） |
| nickname | 表示名（20文字まで） |
| passwordHash | SHA-256 ×1000回（salt + パスワード + PEPPER） |
| salt | ユーザーごとのUUID。パスワード変更のたびに更新 |
| mustChange | `1` = 仮パスワード中（パスワード変更以外の操作を拒否） |
| failCount / lockedUntil | 5回失敗で15分ロック |
| role / status | `member` / `active`・`suspended` |
| createdAt / lastLoginAt | ISO 8601 |

### Routes（ルート）
| 列 | 内容 |
|---|---|
| routeId, userId | `r_`… / 作成者 |
| title, description | タイトル・説明 |
| visibility | `private`（既定）/ `members` / `public` |
| tags | カンマ区切り（平坦, 車少なめ, 狭い道, 歩道・遊歩道中心, 階段あり, 展望よし） |
| source | record / gpx / photo / plan |
| distanceM, elevGainM, elevLossM, maxEleM, minEleM, durationSec | サーバー側で地点から再計算 |
| pointCount, startLat, startLng, minLat, minLng, maxLat, maxLng | 検索・表示用 |
| pedestrianRatio | 歩道・生活道路の割合（0〜1、道の種類分析の結果） |
| gpxFileId | Drive に保存したGPXのファイルID |
| likeCount, commentCount | 集計値 |
| createdAt, updatedAt | ISO 8601 |

### Waypoints（経路の地点）
`routeId, seq, lat, lng, ele, time` — 1地点1行。保存時にまとめて書き込むため連続した行になり、読み出しは TextFinder で範囲を特定して一括取得します。1ルート最大5,000地点（フロントで4,000点に間引いて送信）。

### Spots（スポット）
`spotId, userId, name, category, lat, lng, description, specialty, url, visibility, source, createdAt, updatedAt`
category: `camp`（キャンプ場）/ `michinoeki`（道の駅）/ `onsen`（温泉）/ `shop`（買い物）/ `view`（景色）/ `food`（飲食店）/ `souvenir`（名物・お土産）

### Media（写真・動画）
`mediaId, userId, routeId, spotId, fileId, mimeType, fileName, thumbUrl, viewUrl, lat, lng, takenAt, caption, createdAt`

### Interactions（いいね・コメント）
`interactionId, type(like|comment), routeId, userId, nickname, content, createdAt, updatedAt`

---

## 2. API（POST / `Content-Type: text/plain`）

リクエスト: `{ "action": "...", "token": "...", ...引数 }`
レスポンス: `{ "ok": true, "data": {...} }` または `{ "ok": false, "error": "...", "code": "AUTH" | "MUST_CHANGE" }`

| action | ログイン | 内容 |
|---|---|---|
| getConfig | 不要 | AI・経路探索が使えるか |
| register | 不要 | 仮パスワードをメール送信 |
| login | 不要 | トークン発行（CacheService、6時間・利用ごとに延長） |
| resetPassword | 不要 | 仮パスワード再発行（60秒の連続送信防止） |
| listRoutes | 不要 | filters: keyword, maxGain, maxDistanceKm, tags, pedestrian, mine, near, sort(flat/gain/new/popular) |
| getRoute | 不要 | 地点・写真・いいね数（コメントは会員のみ） |
| exportGpx | 不要 | GPXテキストを返す |
| listSpots | 不要 | bbox / category / keyword / mine |
| me / logout / changePassword | 必要 | |
| saveRoute | 必要 | 新規・更新（points 省略時は情報のみ更新）。GPXをDriveにも保存 |
| deleteRoute | 必要 | 地点・写真・コメント・GPXもまとめて削除 |
| saveSpot / deleteSpot | 必要 | 作成者のみ編集・削除 |
| uploadMedia / listMedia / deleteMedia | 必要 | base64で送信、30MBまで |
| toggleLike / addComment / editComment / deleteComment | 必要 | 編集・削除は投稿者本人のみ |
| extractFromUrl | 必要 | Geminiでコース・スポット・名物をJSON抽出 |
| estimatePhotoLocation | 必要 | 位置情報のない写真の撮影地をGeminiで推定 |
| planRoute | 必要 | openrouteservice foot-hiking。候補最大3件、`flat` は登りが少ない順 |

閲覧権限: `private` は作成者のみ、`members` はログイン会員、`public` は誰でも。

---

## 3. フロントエンドの主な処理

| 機能 | 実装 |
|---|---|
| 地図 | Leaflet 1.9.4 + 地理院タイル（標準・淡色・写真）/ OSM / OpenTopoMap |
| GPS記録 | `watchPosition`（精度40m超・5m未満の移動は除外）、Wake Lock で画面点灯維持、10秒ごとに端末へ一時保存（ブラウザを閉じても再開可） |
| GPX | DOMParser で trkpt → rtept → wpt の順に読み込み、Blob でダウンロード |
| 写真→経路 | exifr で GPS・撮影日時を取得 → 時刻順に並べ50m間隔で補間。任意で経路探索に沿わせる／AI推定 |
| 標高補完 | Open-Meteo Elevation API（100地点ずつ） |
| 道の種類の分析 | Overpass API で周辺の道を取得し、ルート上40mごとに最寄りの道を判定（歩道・山道 / 生活道路 / 幹線道路 / 狭い道）→ タグ候補と pedestrianRatio |
| ルート沿いスポット | 登録スポット＋OSM施設（Overpass `around` の線指定）を、ルートからの距離とスタートからの距離で並べる |
| 記事取り込み | Gemini の抽出結果を一覧 → Nominatim で位置検索（1秒1回）→ 選んだものを非公開スポットとして登録 |

---

## 4. セットアップ手順

### 4-1. GAS プロジェクト作成と初期設定
1. https://script.google.com で「新しいプロジェクト」を作成し、名前を `yamamichi-navi` にする
2. 既存の `コード.gs` の中身を `Code.gs` の内容で置き換えて保存
3. 関数の選択で `setup` を選び「実行」→ 権限を承認
   - 実行ログにスプレッドシートとDriveフォルダのURLが表示されます
4. 歯車（プロジェクトの設定）→「スクリプト プロパティ」に以下を追加

| プロパティ | 値 |
|---|---|
| GEMINI_API_KEY | https://aistudio.google.com/apikey で取得したキー |
| GEMINI_MODEL | 使うモデルID（例: 最新の Flash 系モデル。未設定なら `gemini-2.5-flash`） |
| ORS_API_KEY | https://openrouteservice.org/dev/#/signup で無料登録して取得（経路探索を使う場合） |
| APP_URL | `https://kenken6291.github.io/yamamichi-navi/` |

`SPREADSHEET_ID` / `DRIVE_FOLDER_ID` / `PEPPER` は setup が自動で入れます。**PEPPER を変えると全員のパスワードが無効になる**ので触らないでください。

### 4-2. ウェブアプリとしてデプロイ
1. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
2. 次のユーザーとして実行: **自分** / アクセスできるユーザー: **全員**
3. 表示された `https://script.google.com/macros/s/…/exec` をコピー
4. 動作確認: そのURLの末尾に `?api=1` を付けて開き、`{"ok":true,...}` が出ればOK

> **コードを変更したら必ず**「デプロイ」→「デプロイを管理」→ 鉛筆アイコン →「バージョン: 新バージョン」→「デプロイ」。URLはそのまま使えます。

### 4-3. GitHub Pages で公開
1. GitHub に `yamamichi-navi` リポジトリを作成
2. `app.js` 7行目の `GAS_URL` を 4-2 でコピーしたURLに書き換え
3. `index.html` `app.js` `style.css` をリポジトリ直下に push
4. Settings → Pages → Branch: `main` / `/(root)` → Save
5. 数分後 `https://kenken6291.github.io/yamamichi-navi/` で表示

### 4-4. （任意）GAS 単体でホストする場合
GAS エディタで HTML ファイルを3つ追加し、中身をそのまま貼り付けます（タグで囲む必要はありません）。

| 追加するファイル名 | 中身 |
|---|---|
| `index`（HTML） | index.html |
| `style`（HTML） | style.css の中身 |
| `app`（HTML） | app.js の中身 |

`doGet` が3つを結合して配信し、通信は自動で `google.script.run` に切り替わります（GAS_URL の設定は不要）。ただし GAS の画面は iframe 内で動くため、**GPS記録・GPXダウンロードは GitHub Pages 版での利用を推奨**します。

---

## 5. 注意事項
- **写真・動画は Drive の「リンクを知っている全員が閲覧可」** で保存します（画面に表示するため）。URLは推測できませんが、非公開ルートの写真もリンクを知られると見られます。
- アップロード上限: 画像は長辺2000pxのJPEGに縮小して送信、動画は25MBまで（GAS の受信上限のため）。
- Gmail の送信上限（無料アカウントは1日100通程度）を超えると登録・再発行メールが届きません。
- スマホで画面を消したりブラウザを裏に回すと、多くの端末でGPS記録が止まります。
- iPhone で写真を選ぶと位置情報が外れることがあります（アプリ内にも案内を表示）。
- Overpass・Nominatim・Open-Meteo は無料の公開APIです。短時間に連続して使うと一時的に断られることがあります。

## 6. 動作確認チェックリスト
- [ ] 会員登録 → 仮パスワードメール受信 → ログイン → パスワード変更画面が強制表示される
- [ ] パスワード入力欄の「表示／隠す」が切り替わる
- [ ] 5回ログイン失敗で15分ロック、再発行で解除される
- [ ] 記録開始 → 数分歩く → 終了 → 下書きに距離・登り・標高グラフが出る
- [ ] 保存時の公開範囲が「非公開」で選ばれている
- [ ] 別アカウントで非公開ルートが見えない／会員限定はログイン時のみ見える
- [ ] GPX書き出し → 読み込みで同じ経路になる
- [ ] 写真3枚以上から経路ができ、保存時に写真もアップロードされる
- [ ] 経路探索で候補が登りの少ない順に並ぶ
- [ ] 「道の種類を調べる」でタグ候補が出て、保存画面にチェックされる
- [ ] ルート沿いのスポットがスタートからの距離順に並ぶ
- [ ] 記事URLからスポットを抽出 → 位置検索 → 登録できる
- [ ] いいね・コメントの投稿／編集／削除（他人のコメントには編集ボタンが出ない）
