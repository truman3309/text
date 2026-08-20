# 出貨資料比對系統 - Vercel + Supabase 後端

## 部署步驟

### 1. 建立 Supabase 專案
1. 到 [supabase.com](https://supabase.com) 註冊、建立新專案
2. 進到專案的 **SQL Editor**，把 `supabase-schema.sql` 整份內容貼上執行
3. 到專案的 **Settings → API** 頁面，記下兩個值：
   - **Project URL**（例如 `https://xxxxx.supabase.co`）
   - **service_role secret**（在 "Project API keys" 底下，不是 anon/public 那個）

### 2. 部署到 Vercel
1. 把這個資料夾整個推上 GitHub（一個獨立的 repo，跟前端分開）
2. 到 [vercel.com](https://vercel.com)，New Project，選這個 repo 匯入
3. 部署設定畫面裡展開 **Environment Variables**，新增：
   - `SUPABASE_URL` = 剛剛記下的 Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = 剛剛記下的 service_role secret
4. 點 Deploy

### 3. 確認部署成功
部署完成後 Vercel 會給一個網址，例如 `https://your-project.vercel.app`。
瀏覽器打開 `https://your-project.vercel.app/api/health`，應該會看到：
```json
{"ok":true}
```

### 4. 接上前端
回到 `index.html`（重複比對工具），把資料庫後端 API 網址改成這個 Vercel 網址
（目前預設值寫死在程式碼裡是 `http://localhost:3000`，需要改成 Vercel 網址並重新部署前端，
或是先跟我說，我把它改成可以在畫面上輸入的版本）。

## API 端點一覽

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/health` | 確認資料庫連線正常 |
| GET | `/api/files` | 已上傳檔案清單 |
| POST | `/api/files` | 上傳一個分頁的資料 |
| DELETE | `/api/files` | 清空全部 |
| DELETE | `/api/files/:id` | 刪除單一檔案 |
| GET | `/api/files/:id/data` | 單一檔案完整資料（查看 JSON 用）|
| POST | `/api/compare` | 對 9 個唯一碼欄位找出所有重複值 |
| GET | `/api/stats` | 依機種統計出貨量 |

這些路徑跟之前 Express 版本完全一樣，所以前端的 API 呼叫程式碼不用改，只要換掉「後端 API 網址」這個設定值就好。

## 本機測試（選用）

如果想在推上 Vercel 之前先在本機測試：
```bash
npm install -g vercel
npm install
vercel dev
```
`vercel dev` 會在本機模擬 Vercel 的執行環境，讀取專案根目錄的 `.env.local`
（把 `.env.example` 複製一份改名成 `.env.local` 並填好值）。
