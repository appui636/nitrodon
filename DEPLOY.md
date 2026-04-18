# 🚀 IntroDone! ONLINE - デプロイガイド

## 方法1: Render.com で無料公開（推奨）

### 前提条件
- GitHubアカウント
- Render.comアカウント（GitHub連携可）

### ステップ

#### 1. GitHubにアップロード
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/introdone.git
git push -u origin main
```

#### 2. Render.comでデプロイ
1. https://render.com にアクセス → "New" → "Web Service"
2. GitHubリポジトリを選択
3. 以下を設定:
   - **Name**: `introdone`
   - **Environment**: `Node`
   - **Build Command**: `echo "No build needed"`
   - **Start Command**: `node src/server.js`
   - **Plan**: `Free` (無料)

4. 環境変数は自動でPORT=10000が設定される

#### 3. デプロイ完了
約1-3分で `https://introdone-xxxx.onrender.com` でアクセス可能に！

### 特徴
- ✅ 無料
- ✅ いつでもURLでアクセス可能
- ✅ 自動HTTPS（SSL）
- ❌ 15分無操作で一度スリープ（次回アクセスで自動起動）

---

## 方法2: Railway.app（有料・安定）

1. https://railway.app にアクセス → GitHub連携
2. "New Project" → "Deploy from GitHub"
3. リポジトリ選択
4. Render.comと同様に自動検出される

### 特徴
- ✅ 24/7稼働
- ✅ より安定
- ❌ 月$5～（有料）

---

## 方法3: Heroku（無料枠廃止）

Herokuはもう無料枠がないため非推奨。

---

## 方法4: 自分のサーバー（VPS・クラウド）

AWS、GCP、Azureなどで以下のように実行:

```bash
# サーバーにSSH接続
ssh user@your-server.com

# リポジトリクローン
git clone https://github.com/YOUR_USERNAME/introdone.git
cd introdone

# Node.js インストール（未インストールの場合）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 起動（本番環境では pm2 推奨）
npm install pm2 -g
pm2 start src/server.js --name introdone
pm2 save  # 再起動時も自動起動
```

### Nginx でリバースプロキシ（推奨）
```nginx
server {
  listen 80;
  server_name introdone.example.com;
  
  # HTTP → HTTPS リダイレクト
  return 301 https://$server_name$request_uri;
}

server {
  listen 443 ssl;
  server_name introdone.example.com;
  
  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;
  
  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Certbot（Let's Encrypt）で無料SSL:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --nginx -d introdone.example.com
```

---

## 方法5: Docker で本格デプロイ

### Dockerfile を作成
```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json .
COPY src/ src/
COPY public/ public/
COPY music/ music/

EXPOSE 3000

CMD ["node", "src/server.js"]
```

### Docker Compose
```yaml
version: '3.8'
services:
  introdone:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./music:/app/music
    environment:
      - PORT=3000
```

実行:
```bash
docker-compose up -d
```

---

## 🔒 アクセス制限（検索結果非表示）

### 1. robots.txt 設置（自動で実装済み）
`public/index.html` に以下を追加:
```html
<meta name="robots" content="noindex, nofollow">
```

### 2. Optional: Basic認証（さらにセキュア）

Nginx でBasic認証:
```bash
# .htpasswd ファイル生成
sudo apt install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd admin
# パスワード入力
```

Nginx設定:
```nginx
location / {
  auth_basic "IntroDone Admin";
  auth_basic_user_file /etc/nginx/.htpasswd;
  
  proxy_pass http://localhost:3000;
  # ... (上記のproxy設定)
}
```

### 3. Optional: IP制限
```nginx
location / {
  # 特定のIPアドレスのみ許可
  allow 192.168.1.0/24;
  allow 203.0.113.0/24;
  deny all;
  
  proxy_pass http://localhost:3000;
}
```

---

## 🎵 本番環境での曲の追加

### 方法1: `/admin.html` で追加（簡単）
1. ブラウザで `https://your-domain/admin.html` を開く
2. 曲情報を入力して追加
3. 自動的にサーバーに保存される

### 方法2: Git で追加・更新（推奨）
```bash
# ローカルで曲を追加
cp new_song.mp3 music/
# catalog.json を編集
git add music/
git commit -m "Add new songs"
git push

# Render.com 自動デプロイ
# (GitHub連携なら自動で新バージョンをデプロイ)
```

### 方法3: SCP でアップロード
```bash
scp song.mp3 user@server.com:/path/to/introdone/music/
```

---

## 📊 本番環境でのモニタリング

### ログ確認
```bash
# Render.com の場合：ダッシュボード → "Logs"

# 自分のサーバーの場合：
pm2 logs introdone
```

### パフォーマンス監視
```bash
# CPU/メモリ使用率
pm2 monit
```

---

## 🛡️ セキュリティのベストプラクティス

1. **Node.js の定期更新**
   ```bash
   # 最新LTS版に更新
   nvm install 20
   nvm use 20
   ```

2. **catalog.json の定期バックアップ**
   ```bash
   # cron で毎日バックアップ
   0 2 * * * cp /app/music/catalog.json /backups/catalog-$(date +\%Y\%m\%d).json
   ```

3. **レート制限**（DDoS対策）- Nginx
   ```nginx
   limit_req_zone $binary_remote_addr zone=api:10m rate=100r/m;
   
   location / {
     limit_req zone=api burst=200 nodelay;
     proxy_pass http://localhost:3000;
   }
   ```

4. **CORS（クロスオリジン）設定**
   - 現在は同一オリジンのみ対応
   - もし別ドメインからアクセスさせたい場合は server.js に追加:
   ```javascript
   res.setHeader('Access-Control-Allow-Origin', 'https://your-domain.com');
   ```

---

## トラブルシューティング

### Q. 曲が再生されない
A. 以下を確認:
1. `music/` フォルダにMP3ファイルが存在するか
2. `catalog.json` のファイル名が正しいか
3. ファイルのパーミッションが読み取り可能か
   ```bash
   chmod 644 music/*.mp3
   ```
4. ブラウザのコンソール(F12)でエラーを確認

### Q. WebSocket が切断される
A.
1. ファイアウォール設定を確認（WSS - WebSocket Secure）
2. リバースプロキシの設定を確認
3. Render.com など、稼働時間が制限されている環境ならスリープを無視する設定を追加

### Q. 検索エンジンに引っかかった
A.
1. Google Search Console で該当URL を削除申請
2. Bing Webmaster Tools でも同様に削除
3. robots.txt が正しく設置されているか確認

---

## 推奨セットアップ（本番運用）

```
【推奨】
┌─────────────────────────────────┐
│      Render.com（無料）         │
│  - 3分のセットアップ            │
│  - HTTPS自動                    │
│  - GitHub自動デプロイ           │
└─────────────────────────────────┘

【より安定】
┌─────────────────────────────────┐
│   VPS (DigitalOcean $5/月)      │
│  + Nginx リバースプロキシ        │
│  + pm2 (自動再起動)             │
│  + Certbot (Let's Encrypt SSL)  │
└─────────────────────────────────┘

【フル管理】
┌─────────────────────────────────┐
│   AWS / GCP / Azure             │
│  + Docker コンテナ化             │
│  + CloudFront CDN              │
│  + DDoS 保護                    │
└─────────────────────────────────┘
```

---

**最初はRender.comが最も簡単。後から規模を拡大する場合はVPSへ移行がおすすめです。**
