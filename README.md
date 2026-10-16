# 欄位重複比對台

工廠出貨資料的 Excel 重複比對與查詢工具。上傳多份出貨 Excel，系統會自動找出重複的 IMEI、序號、MAC 等唯一碼，並提供資料庫搜尋與出貨量統計。

## 為什麼做這個工具

工廠出貨前，需要確認每一台裝置的 IMEI、序號、MAC ID 等唯一碼沒有重複。過去的做法是**同時開啟多個 Excel，一筆一筆用眼睛核對**：

- 很耗眼力，長時間比對容易看錯、漏看
- 資料量一大，就要花很久的時間
- 跨檔案比對特別困難，需要在多個視窗之間來回切換

這個網頁把核對工作交給程式：**一次上傳多份 Excel，幾秒內就列出所有重複的資料**，並標出是哪個檔案、哪一列、哪個欄位重複。

## 功能

| 頁面 | 檔案 | 功能 |
|---|---|---|
| **欄位重複比對台** | `index.html` | 一次上傳多份 Excel／CSV，選擇要比對的欄位，找出重複資料；結果可以分頁瀏覽、匯出 CSV |
| **資料庫搜尋** | `search.html` | 輸入 IMEI、序號、機種等，同時查 12 個欄位；也可以用多個條件組合查詢 |
| **出貨日期與出貨量統計** | `stats-by-date.html` | 從檔名判讀出貨日期與數量，依「年月 → 機種」統計出貨量 |
| **機種出貨量統計** | `stats-by-model.html` | 每個機種的總出貨量，以長條圖呈現 |

### 比對方式
- **直排比對**：同一個欄位往下看，找出不同列之間重複的值。例如兩台裝置的 IMEI1 一樣。
- **橫排比對**：同一列裡的欄位兩兩比較，找出值相同的欄位。例如同一台裝置的 IMEI1 = IMEI2。
- **兩者都要**：同時做以上兩種比對。

可以勾選「忽略大小寫」「忽略前後空白」，避免格式差異造成漏判。

### 預設比對的 9 個唯一碼欄位
IMEI1、Serial No.、MAC ID、Battery SN、PCBA SN、LCD SN、ICCID、PCB Main Board Serial No.、SIM Unlock Code

### 其他特色
- **大量資料不卡頓**：解析與比對都在背景執行緒（Web Worker）進行，上萬筆資料也不會讓畫面卡住。
- **自動保存**：上傳過的檔案會存進資料庫，也會快取在瀏覽器裡，重新整理頁面不用重新上傳。
- **自動分組**：依機種把檔案分組顯示。
- **支援格式**：`.xlsx`、`.xls`、`.csv`，Excel 欄位為 A～BE 共 57 欄的出貨報表範本。

## 系統架構

```
瀏覽器（index.html / search.html / stats-*.html）
   │  不持有任何資料庫金鑰
   ▼
Vercel Serverless Functions
   ├─ /api/db       資料庫操作（只開放網頁需要的操作，參數逐一檢查）
   ├─ /api/storage  上傳原始 Excel
   └─ /api/health   連線檢查
   │  金鑰只存在 Vercel 環境變數
   ▼
Supabase
   ├─ PostgreSQL   shipment_files（檔案）、shipment_records（資料列）
   └─ Storage      excel-files（原始 Excel）
```

| 層級 | 技術 |
|---|---|
| 前端 | HTML、CSS、JavaScript（無框架）、Web Worker、IndexedDB |
| Excel 解析 | [SheetJS](https://sheetjs.com/) |
| 後端 | [Vercel](https://vercel.com/) Serverless Functions（Node.js） |
| 資料庫 | [Supabase](https://supabase.com/)（PostgreSQL + Storage） |

## 專案結構

```
text-main/
├── index.html              欄位重複比對台
├── search.html             資料庫搜尋
├── stats-by-date.html      出貨日期與出貨量統計
├── stats-by-model.html     機種出貨量統計
├── js/                     各頁面的程式
├── api/
│   ├── db.js               資料庫操作轉送
│   ├── storage.js          原始檔上傳轉送
│   ├── health.js           連線檢查
│   ├── _ratelimit.js       請求頻率限制
│   ├── _validate.js        輸入檢查
│   ├── _cors.js            CORS 設定
│   └── _lib.js             共用連線設定
├── vendor/                 SheetJS（需自行放入，見 vendor/README.txt）
├── backend-vercel/
│   ├── supabase-schema.sql 資料表結構
│   ├── lock-anon.sql       收回匿名存取權限
│   └── rate-limit.sql      頻率限制用的資料表與函式
├── vercel.json             安全標頭（CSP 等）
└── .vercelignore           不部署的檔案
```

## 部署

### 1. Supabase
1. 建立專案，在 **SQL Editor** 執行 `backend-vercel/supabase-schema.sql` 建立資料表。
2. 建立名為 `excel-files` 的 Storage bucket，設為**不公開**。
3. 到 **Authentication → Sign In / Providers** 關閉「Allow new users to sign up」。

### 2. Vercel
1. 匯入這個 GitHub repo。
2. 設定環境變數：

   | 變數 | 值 |
   |---|---|
   | `SUPABASE_URL` | Supabase 專案網址 |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase 的 service_role key（**只放這裡，不要寫進程式碼**） |

3. 部署，打開網站確認四個頁面都顯示「資料庫連線成功」。

### 3. 部署完成後
在 Supabase SQL Editor 依序執行：
1. `backend-vercel/rate-limit.sql`
2. `backend-vercel/lock-anon.sql`（一定要在部署完成**之後**才執行）

### 4. SheetJS
到 <https://cdn.sheetjs.com/> 下載 `xlsx.full.min.js`（0.20.3 以上），放進 `vendor/`。沒放的話會暫時使用舊版，功能正常，但有已知漏洞。

## 資安設計

- **金鑰不進瀏覽器**：所有資料庫操作都經過 `/api/db`，開發者工具裡看不到任何金鑰。
- **資料庫不對外開放**：匿名與自行註冊的帳號都無法直接存取資料庫。
- **只開放必要操作**：`/api/db` 只接受網頁實際用到的操作；欄位名稱、檔案 ID、搜尋內容都有白名單或格式檢查。
- **請求頻率限制**：限制每個 IP 的操作次數；刪除另有全站每日上限。可在 `api/_ratelimit.js` 調整。
- **防 XSS**：畫面上的資料都經過跳脫，並以 CSP 限制只能執行自己網站的程式。
- **防 CSV 公式注入**：匯出 CSV 時，`= + - @` 開頭的值會加上 `'`，避免 Excel 執行公式。
- **搜尋輸入限制**：只允許英文、數字、`( )` 和一個 `&`。

> ⚠ 目前網站**沒有登入機制**，知道網址的人都能使用網頁上的功能（查詢、上傳、刪除）。請勿將網址公開分享。

## 調整設定

| 想調整 | 位置 |
|---|---|
| 比對結果的搜尋功能開關 | `js/index.js` 的 `RESULT_SEARCH_ENABLED` |
| 統計頁的搜尋功能開關 | `js/stats-by-date.js`、`js/stats-by-model.js` 的 `RESULT_SEARCH_ENABLED` |
| 預設比對欄位 | `js/index.js` 的 `DEFAULT_COMPARE_FIELDS` |
| 搜尋字數與允許符號 | `js/search.js`，以及 `api/db.js` 的 `checkSearch`、`SEARCH_RE`（兩邊要一起改） |
| 請求頻率上限 | `api/_ratelimit.js` 的 `RULES` |
| 原始檔上傳大小上限 | `api/storage.js` 的 `MAX_BYTES`（最大約 4.5MB，Vercel 的限制） |

## 程式說明文件

各頁面每個函式的用途、行號與流程：

- [欄位重複比對台（index.js）](docs/index-js-函式說明.md)
- [資料庫搜尋（search.js）](docs/search-js-函式說明.md)
- [出貨日期與出貨量統計（stats-by-date.js）](docs/stats-by-date-js-函式說明.md)
- [機種出貨量統計（stats-by-model.js）](docs/stats-by-model-js-函式說明.md)
