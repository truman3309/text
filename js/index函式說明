## 整體架構

這個檔案分成兩個部分，跑在兩個不同的「執行緒」：

| 部分 | 行號 | 負責的事 |
|---|---|---|
| **背景執行緒（Web Worker）** | 第 12～851 行（`WORKER_SRC` 字串裡面） | 解析 Excel、存取瀏覽器本機資料庫（IndexedDB）、透過 `/api/db` 連資料庫、執行比對運算。這些都很花時間，放在背景才不會讓畫面卡住 |
| **主執行緒** | 第 852 行之後 | 操作畫面：按鈕、檔案清單、結果表格、分頁、匯出 |

兩邊用「傳訊息」溝通：主執行緒用 `workerCall()` 送出任務，背景執行緒在 `self.onmessage` 裡處理完再回傳結果。

---

## 共用工具

| 函式 | 行號 | 用途 |
|---|---|---|
| `escapeHtml(str)` | 1 | 把 `& < > " '` 轉成 HTML 安全字元。任何要塞進畫面的資料（檔名、欄位值）都要先經過它，防止 XSS 攻擊 |

---

## 一、背景執行緒（Web Worker）

### 1-1. 載入 Excel 解析套件（第 13～14 行）
先嘗試載入 `vendor/xlsx.full.min.js`（新版 SheetJS），找不到時退回 cdnjs 上的舊版 0.18.5。

### 1-2. 瀏覽器本機資料庫（IndexedDB）
把上傳過的檔案存在瀏覽器裡，重新整理頁面後不用重新上傳。

| 常數 | 行號 | 說明 |
|---|---|---|
| `DB_NAME`、`DB_VERSION` | 22～23 | 本機資料庫名稱 `fieldComparatorDB`，版本 2 |
| `OLD_STORE_NAME` | 24 | 舊版（v1）的資料表名稱，升級時用來搬資料 |
| `META_STORE` | 25 | 存「檔案資訊」（檔名、欄位、機種、列數），資料量小 |
| `DATA_STORE` | 26 | 存「實際資料列」，資料量大，需要時才讀 |

| 函式 | 行號 | 用途 |
|---|---|---|
| `openDB()` | 39 | 開啟本機資料庫。第一次使用或版本升級時，自動建立資料表，並把舊版資料搬到新的兩張表 |
| `dbPutMeta(meta)` | 85 | 把一個檔案的資訊存進本機 |
| `dbPutData(data)` | 102 | 把一個檔案的資料列存進本機 |
| `dbGetData(id)` | 119 | 從本機讀出一個檔案的資料列 |
| `dbDeleteBoth(id)` | 137 | 從本機刪除一個檔案（資訊和資料列一起刪） |
| `dbLoadAllMeta()` | 157 | 讀出本機所有檔案的資訊（不含資料列），用來顯示檔案清單 |
| `ensureRowsLoaded(entry)` | 190 | 確保某個檔案的資料列已經載入記憶體。已載入就直接用；從資料庫來的檔案向伺服器讀；本機檔案從 IndexedDB 讀。這樣開頁時不用一次載入全部資料 |

### 1-3. 資料整理
| 函式 / 常數 | 行號 | 用途 |
|---|---|---|
| `detectItemModel(columns, rows)` | 212 | 找出「Item Model」欄位裡出現最多次的值，當作這個檔案的機種，用來在檔案清單分組。最多只抽樣前 20000 列 |
| `DB_COLUMN_MAP` | 233 | Excel 欄位字母（A～BE）對應程式內部欄位名稱的表，共 57 欄 |
| `dbCall(op, params)` | 261 | **呼叫伺服器 `/api/db`**，所有資料庫操作都透過它。瀏覽器不持有 key，由伺服器去連 Supabase |
| `genDbId()` | 280 | 產生檔案 ID（時間戳＋安全亂數），用在資料庫和 Storage 路徑 |
| `CAMEL_TO_SNAKE` | 288 | 程式內部欄位名稱（例如 `serialNo`）對應資料庫欄位名稱（例如 `serial_no`） |
| `toSnakeCaseFields(rec)` | 312 | 用上面的對照表，把一列資料轉成資料庫要的欄位名稱 |
| `toCsvRow(rec)` | 328 | 把一列資料依 A～BE 順序組成一行 CSV 文字，存進資料庫的 `full_row` 欄位，之後可以完整還原 |
| `colLetterToIndex(letter)` | 344 | 把 Excel 欄位字母換成索引數字，例如 `A`→0、`AJ`→35 |
| `buildDbRecords(sheet)` | 361 | 依欄位**字母位置**讀取 Excel，組成要存進資料庫的資料。IMEI1、Serial No.、MAC ID、PCBA SN 全部是空的列會被略過 |
| `HEADER_NAME_MAP` | 484 | Excel **表頭文字**（例如 `'Serial No.'`）對應程式內部欄位名稱 |
| `buildDbRecordsFromParsedRows(rows)` | 512 | 跟 `buildDbRecords` 一樣，但改用**表頭文字**對應欄位。用在「重新同步」只剩本機資料、沒有原始 Excel 的情況 |
| `CAMEL_TO_HEADER`、`HEADERS_IN_DB_ORDER` | 528～530 | 反向對照表：把資料庫的欄位順序換回表頭文字，讓從資料庫讀回的資料格式跟上傳時一樣 |
| `parseCsvRow(csvText)` | 542 | 解析一行 CSV 文字（處理引號、逗號），把 `full_row` 拆回 57 個值 |
| `csvRowToDisplayRow(csvText)` | 573 | 把 `full_row` 還原成「表頭文字 → 值」的物件，才能拿去比對和顯示 |

### 1-4. 連資料庫（透過伺服器）
| 函式 | 行號 | 用途 |
|---|---|---|
| `uploadFileToStorage(fileId, fileName, bytes)` | 388 | 把原始 Excel 檔上傳到 `/api/storage`，保存原始檔。路徑是「檔案ID/檔名」，4MB 以內 |
| `deleteFromDatabase(dbFileId, storagePath, sourceFileName)` | 419 | 刪除資料庫裡的檔案（資料列會跟著刪）和 Storage 的原始檔。沒有檔案 ID 時改用檔名刪除。任一步失敗都會繼續做其他步驟，最後一起回報錯誤 |
| `saveToDatabase(...)` | 452 | 存進資料庫：先建立檔案資訊（`createFile`），再每 500 列一批寫入資料列（`insertRecords`）。中途失敗會把剛建立的檔案刪掉，不留下半份資料 |
| `fetchRemoteFilesList()` | 590 | 讀取資料庫裡所有檔案的清單（最多 1000 個） |
| `fetchRemoteFileRows(dbFileId)` | 605 | 讀取一個檔案的所有資料列，並用 `csvRowToDisplayRow` 還原 |

### 1-5. 其他
| 函式 | 行號 | 用途 |
|---|---|---|
| `fileMetaOf(entry)` | 621 | 把完整的檔案資料精簡成「畫面只需要的資訊」（不含資料列），避免把大量資料傳回主執行緒 |
| `allColumns()` | 638 | 把所有檔案出現過的欄位名稱合併、去掉重複，用來填比對欄位的下拉選單 |

### 1-6. 訊息總入口 `self.onmessage`（第 668 行）
主執行緒送來的每個任務都在這裡依 `msg.type` 分派：

| `msg.type` | 行號 | 做什麼 |
|---|---|---|
| `set-config` | 672 | 接收網站網址（`API_BASE`），之後連 `/api/db` 要用。一定是第一則訊息 |
| `init` | 678 | 頁面剛打開時：讀本機的檔案清單，再向資料庫要清單，把「資料庫有、本機沒有」的檔案也加進來（標成「來自資料庫」） |
| `parse` | 699 | 使用者上傳檔案時：解析 Excel → 偵測機種 → 上傳原始檔 → 存進資料庫 → 存進本機 → 回傳檔案資訊 |
| `sync-to-db` | 738 | 把「之前沒成功存進資料庫」的檔案重新存一次 |
| `remove` | 758 | 移除檔案：刪資料庫、刪 Storage、刪本機 |
| `get-file-data` | 769 | 讀出一個檔案的所有資料列，給「查看 JSON」用 |
| `test-api` | 778 | 連線測試，呼叫 `/api/db` 的 `ping` |
| `compare` | 786 | **執行比對**（見下方） |

**`compare` 裡面的函式：**
| 函式 | 行號 | 用途 |
|---|---|---|
| `normalize(v)` | 788 | 依使用者勾選的選項，去掉前後空白、轉小寫，再拿來比較 |
| `buildRowGroups()` | 801 | **橫排比對**：同一列裡，選定的欄位兩兩比較，找出值相同的列，例如 IMEI1 = IMEI2 |
| `buildColumnGroups()` | 816 | **直排比對**：同一個欄位往下看，找出在不同列重複出現的值，例如兩列的 IMEI1 一樣 |

---

## 二、主執行緒

### 2-1. 跟背景執行緒溝通
| 函式 | 行號 | 用途 |
|---|---|---|
| `createWorker()` | 875 | 建立背景執行緒，並設定收到回覆時要對應到哪個請求。背景執行緒當掉時，所有等待中的請求會一起回報錯誤，不會卡住 |
| `getWorker()` | 903 | 取得背景執行緒，第一次呼叫時才建立，並把網站網址傳過去 |
| `workerCall(payload, transfer)` | 928 | 送任務給背景執行緒，等它做完回傳結果。每個任務有編號（`reqId`），回覆才不會對錯 |

### 2-2. 連線狀態
| 函式 | 行號 | 用途 |
|---|---|---|
| `setStatusBar(state, text)` | 949 | 更新頁面上方的狀態燈（綠：成功、紅：失敗、橘：測試中）和文字 |
| `testApiConnection()` | 962 | 測試資料庫連線並更新狀態燈 |

### 2-3. 比對欄位設定
| 函式 / 常數 | 行號 | 用途 |
|---|---|---|
| `makeCompareRow(index)` | 1001 | 產生一個「比對欄位 N」的下拉選單 |
| `syncCompareFields(count)` | 1022 | 依「比對欄位數量」增加或刪除下拉選單 |
| `DEFAULT_COMPARE_FIELDS` | 1036 | 預設會自動選好的 9 個欄位：IMEI1、Serial No.、MAC ID、Battery SN、PCBA SN、LCD SN、ICCID、PCB Main Board Serial No.、SIM Unlock Code |
| `refreshCompareFieldOptions()` | 1041 | 把所有欄位名稱填進每個下拉選單。原本選好的保留；第一次有選項時自動套用上面的預設值 |
| 比對欄位數量的 `change` 事件 | 1061 | 數量限制在 1～100，改了之後同步增減下拉選單 |

### 2-4. 上傳檔案
| 函式 | 行號 | 用途 |
|---|---|---|
| `refreshMainSlotDisplay()` | 1075 | 更新上傳區塊的文字，例如「已上傳 52 個檔案，共 31479 列」 |
| `checkReady()` | 1088 | 有檔案才讓「找出重複項目」按鈕可以按 |
| `showSingleError(msg)` / `clearSingleError()` | 1089～1090 | 顯示／清除錯誤訊息 |
| `handleFiles(fileList)` | 1092 | **上傳主流程**：逐一讀檔、交給背景執行緒解析並存進資料庫、顯示進度條。檔名重複的會跳過，最後彙整「解析失敗」「存資料庫失敗」的訊息 |
| 上傳區的點擊、鍵盤、拖曳事件 | 1143～1148 | 點擊或按 Enter 開啟選檔視窗；拖曳檔案進來時改變外觀，放開就上傳 |

### 2-5. 檔案清單
| 函式 | 行號 | 用途 |
|---|---|---|
| `dbBadgeHtml(f)` | 1150 | 產生檔案旁邊的小標籤：「已存進資料庫」「資料庫存入失敗」「未同步資料庫」「來自資料庫」 |
| `renderFilesList()` | 1157 | 畫出右側檔案清單：依機種分組、可收合，每組預設最多顯示 50 個檔案，超過出現「顯示全部」 |
| 檔案清單的 `click` 事件 | 1208 | 處理「查看 JSON」「移除」「顯示全部」「展開／收合分組」四種點擊 |
| `removeFromHistory(id)` | 1227 | 移除檔案，再更新下拉選單、上傳區、清單 |

### 2-6. 查看 JSON 視窗
| 函式 | 行號 | 用途 |
|---|---|---|
| `openJsonModal(id)` | 1250 | 打開視窗顯示檔案內容，超過 500 列只預覽前 500 列 |
| `closeJsonModal()` | 1271 | 關閉視窗 |
| 關閉按鈕、點背景、按 Esc | 1276～1278 | 三種關閉視窗的方式 |
| 下載按鈕的 `click` 事件 | 1280 | 把完整內容下載成 `.json` 檔 |

### 2-7. 比對結果
| 函式 | 行號 | 用途 |
|---|---|---|
| `openResults()` | 1297 | 顯示結果區塊 |
| `setGauge(countHtml, pct, statHtml)` | 1299 | 更新結果上方的統計：重複列數、進度條、涵蓋檔案、總列數等 |
| `paintTable(headHtml, list)` | 1305 | 設定表頭，並畫出第一頁 |
| `renderCurrentPage()` | 1312 | 依目前頁碼畫出這一頁（每頁 200 筆），並更新分頁按鈕 |
| 上一頁／下一頁的 `click` 事件 | 1345～1348 | 換頁 |

### 2-8. 搜尋開關與結果搜尋
| 項目 | 行號 | 用途 |
|---|---|---|
| `RESULT_SEARCH_ENABLED` | 1356 | **搜尋功能的開關**。`false` = 關閉，`true` = 開啟 |
| 關閉時的設定 | 1358～1363 | 搜尋框設為無法輸入，加上提示「搜尋功能目前已關閉」，並把框裡的文字換成「目前搜尋功能關閉」 |
| 搜尋框的 `input` 事件 | 1365 | 開關打開時，輸入後 0.2 秒篩選結果；開關關閉時直接略過 |

### 2-9. 匯出 CSV
| 項目 | 行號 | 用途 |
|---|---|---|
| 匯出按鈕的 `click` 事件 | 1377 | 把目前的比對結果匯出成 `重複項目.csv` |
| `csvCell(v)` | 1380 | 處理每一格：以 `= + - @` 開頭的值前面加 `'`，避免 Excel 把它當公式執行（純數字除外） |

### 2-10. 執行比對
| 項目 | 行號 | 用途 |
|---|---|---|
| 「找出重複項目」按鈕的 `click` 事件 | 1395 | **比對主流程**：檢查設定 → 交給背景執行緒比對 → 計算統計數字 → 畫出表格。橫排比對至少要選 2 個欄位 |
| `resultsCtx.renderRows(list)` | 1442 | 把一頁的結果畫成表格列，比對欄位會標上顏色 |
| `resultsCtx.matchQuery(item, q)` | 1454 | 判斷某一列有沒有包含搜尋文字（搜尋開關打開時使用） |
| `resultsCtx.exportHeader` / `exportRow` | 1457～1458 | 定義匯出 CSV 的表頭和每一列內容 |

### 2-11. 同步與初始化
| 函式 | 行號 | 用途 |
|---|---|---|
| `syncAllUnsyncedFiles()` | 1472 | 把所有「還沒存進資料庫」的檔案一個個重新存。每 0.4 秒才更新一次畫面，避免卡頓 |
| `init()` | 1507 | **頁面打開時自動執行**：讀取本機和資料庫的檔案清單、畫出畫面、更新連線狀態；連線成功的話，自動同步還沒存進資料庫的檔案 |

---

## 一個檔案從上傳到比對的流程

```
使用者拖曳 Excel
  → handleFiles()                 主執行緒：讀檔、顯示進度
  → workerCall({type:'parse'})    交給背景執行緒
  → XLSX.read()                   解析 Excel
  → detectItemModel()             偵測機種
  → uploadFileToStorage()         保存原始檔
  → buildDbRecords()              整理成資料庫格式
  → saveToDatabase()              經 /api/db 存進資料庫
  → dbPutMeta() / dbPutData()     存進瀏覽器本機
  → renderFilesList()             檔案清單出現新檔案

使用者按「找出重複項目」
  → workerCall({type:'compare'})
  → ensureRowsLoaded()            載入所有檔案的資料列
  → buildRowGroups() / buildColumnGroups()
  → setGauge() + paintTable()     顯示統計和結果表格
```
