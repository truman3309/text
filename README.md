欄位比對
函式用途對照表
### `api/config.js`

| 方法 | 用途 |
|---|---|
| `handler(req, res)` | Vercel serverless function 的進入點。從 Vercel 的環境變數讀取 `SUPABASE_URL`、`SUPABASE_ANON_KEY`，包成 JSON 回傳給前端。設定 `Cache-Control: no-store` 確保每次都拿到最新值，不會被瀏覽器或 CDN 快取住。 |

---

### 共用方法（四個 HTML 檔案都有，邏輯相同）

| 方法 | 用途 |
|---|---|
| `escapeHtml(str)` | 把字串裡的 `& < > " '` 轉成 HTML 實體字元，避免使用者資料（檔名、機種名稱等）直接塞進 `innerHTML` 時被當成 HTML 語法解析，防止畫面跑版或簡單的 XSS。 |
| `ensureConfig()` | **本次改造新增**。跟 `/api/config` 要 `SUPABASE_URL`／`SUPABASE_ANON_KEY`，成功後存進外層變數。用 `configPromise` 快取住這個 fetch 的 Promise，確保同一頁面即使多個地方同時呼叫，也只會真正打一次 API；失敗的話清掉快取，讓下次呼叫可以重試。 |
| `supabaseHeaders(extra)` | 組出打 Supabase REST API 需要的 HTTP headers（`apikey`、`Authorization: Bearer ...`、`Content-Type`）。`extra` 參數可以傳額外的 header（例如 `Prefer: return=minimal`）合併進去。 |
| `setStatusBar(state, text)` | 更新畫面最上方那顆狀態燈（綠色/紅色/藍色小圓點）跟旁邊的文字，用來顯示目前跟資料庫的連線狀態。 |

---

### `index.html`（欄位重複比對台）

#### 主執行緒（`<script>` 主體）

| 方法 | 用途 |
|---|---|
| `loadAppConfig()` |兩層快取機制：appConfig（結果快取）+ configPromiseMain（請求進行中快取），避免重複打 API。錯誤處理後會重置狀態：失敗時把 configPromiseMain 設回 null，讓下次呼叫可以重新嘗試，而不是永遠卡在失敗的 Promise。多次呼叫安全（idempotent-like）：即使同時有多處程式呼叫 loadAppConfig()，也只會真正發出一次 fetch 請求。 |
| `createWorker()` | 內嵌式 Worker：用 Blob + URL.createObjectURL 動態產生 Worker，不需要額外的實體 .js 檔案。請求／回應配對機制（reqId）：搭配外部的 pending Map，實現「主執行緒發送任務 → Worker 處理 → 用 reqId 找回對應的 Promise 並 resolve/reject」的非同步通訊模式。錯誤處理分兩層：訊息層級錯誤（msg.type 是 -err 或 'error'）：只 reject 這一個對應的請求。Worker 層級錯誤（onerror，例如語法錯誤、未捕捉例外）：代表整個 Worker 可能已經壞掉，所以把所有等待中的請求一次 reject，避免呼叫端永久等待。 |
| `getWorker()` | 取得（或第一次建立）Worker。第一次呼叫時會先 `await loadAppConfig()`，拿到 config 後才建立 Worker，並立刻用 `postMessage({type:'set-config', ...})` 把 Supabase 網址跟 key 傳進 Worker。 |
| `workerCall(payload, transfer)` | 把一個請求包成 `Promise`送進 Worker，並用遞增的 `reqId` 對應「這個請求」跟「Worker 回傳的結果」，讓非同步的 `postMessage` 溝通可以用 `await` 的方式寫。 |
| `testApiConnection()` | 呼叫 Worker 做一次連線測試（`type:'test-api'`），並更新畫面上的狀態列。 |
| `makeCompareRow(index)` | 動態產生一列「比對欄位 N」的下拉選單 DOM 元素。 |
| `syncCompareFields(count)` | 依照使用者填的「比對欄位數量」，增加或刪除對應數量的下拉選單列。 |
| `refreshCompareFieldOptions()` | 把目前所有已上傳檔案裡出現過的欄位名稱，重新填進每個比對欄位下拉選單，並套用預設值（IMEI1、Serial No. 等 9 個唯一碼欄位）。 |
| `refreshMainSlotDisplay()` | 更新上傳區塊顯示的文字（顯示目前已上傳幾個檔案、共幾列）。 |
| `checkReady()` | 檢查是否已有上傳檔案，決定「找出重複項目」按鈕要不要能按。 |
| `showSingleError(msg)` / `clearSingleError()` | 顯示 / 清除畫面上的錯誤訊息文字。 |
| `handleFiles(fileList)` | 使用者選取或拖曳檔案後的主要處理流程：逐一讀取檔案內容、丟給 Worker 解析（`type:'parse'`）、更新畫面上的進度與檔案清單，並彙整解析失敗、檔名重複、資料庫寫入失敗的訊息。 |
| `dbBadgeHtml(f)` | 依照檔案的資料庫同步狀態（`ok`／`bad`／未同步／來自遠端），組出對應的小徽章 HTML。 |
| `renderFilesList()` | 把 `fileMeta`（目前所有檔案的中繼資料）依機種分組、渲染成畫面上那份可收合的檔案清單。 |
| `removeFromHistory(id)` | 使用者點「移除」某個檔案時呼叫，請 Worker 從 IndexedDB 跟 Supabase 一併刪除該檔案的資料。 |
| `openJsonModal(id)` / `closeJsonModal()` | 開啟／關閉「查看 JSON」彈出視窗，顯示某個檔案解析後的原始資料列（超過 500 列只預覽前 500 列）。 |
| `openResults()` | 顯示比對結果區塊。 |
| `setGauge(countHtml, pct, statHtml)` | 更新比對結果最上方的統計儀表（重複列數、進度條、各項統計數字）。 |
| `paintTable(headHtml, list)` | 設定結果表格的表頭，並觸發第一頁的渲染。 |
| `renderCurrentPage()` | 依照目前頁碼，從完整結果清單裡切出這一頁要顯示的資料並畫出表格，同時更新分頁按鈕的狀態。 |
| **`runBtnS` 的 click 事件內邏輯** | 蒐集使用者選的比對欄位、比對方向、忽略大小寫/空白等設定，送給 Worker 執行比對（`type:'compare'`），拿到結果後渲染統計儀表跟結果表格。 |
| `syncAllUnsyncedFiles()` | 把所有「未同步到資料庫」的檔案，逐一請 Worker 重新嘗試寫入資料庫（`type:'sync-to-db'`），並節流更新畫面避免頻繁重繪造成卡頓。 |
| **`init()`（立即執行函式）** | 頁面載入時的初始化流程：請 Worker 讀取 IndexedDB 裡的歷史紀錄與資料庫最新檔案清單、渲染畫面、如果連線成功就順便觸發一次未同步檔案的自動同步。 |

#### Worker 內部（`WORKER_SRC` 字串裡）

| 方法 | 用途 |
|---|---|
| `openDB()` | 開啟（或建立）瀏覽器的 IndexedDB 資料庫，處理版本升級時把舊格式資料搬到新的 `meta`／`data` 兩個 store。 |
| `dbPutMeta(meta)` / `dbPutData(data)` | 把某個檔案的中繼資料（`meta`）或實際資料列（`data`）寫進 IndexedDB。 |
| `dbGetData(id)` | 從 IndexedDB 依 id 讀出某個檔案的資料列。 |
| `dbDeleteBoth(id)` | 從 IndexedDB 同時刪除某個檔案的中繼資料跟資料列。 |
| `dbLoadAllMeta()` | 從 IndexedDB 讀出所有已存過的檔案中繼資料清單。 |
| `ensureRowsLoaded(entry)` | 確保某個檔案的實際資料列已經載入記憶體——如果是遠端檔案就從 Supabase 撈，否則從 IndexedDB 讀，避免每個檔案一開始就把資料整包載入造成卡頓。 |
| `detectItemModel(columns, rows)` | 從解析出來的資料列裡，自動偵測「Item Model」欄位最常出現的值，當作這個檔案的機種標籤（用來在畫面上分組顯示）。 |
| `supabaseHeaders(extra)` | （Worker 內部版本）同上，組出打 Supabase 需要的 headers。 |
| `genDbId()` | 產生一個給 Supabase 資料表用的唯一 id（時間戳記 + 亂數）。 |
| `toSnakeCaseFields(rec)` | 把解析出來的 camelCase 欄位物件（如 `imei1`、`serialNo`）轉成 Supabase 資料表實際用的 snake_case 欄位名稱（如 `serial_no`）。 |
| `toCsvRow(rec)` | 把一列資料依照 Excel 欄位順序（A～BE）組成一行 CSV 文字，存進 `shipment_records.full_row`，方便之後還原成完整列資料而不用存一大包 JSON。 |
| `colLetterToIndex(letter)` | 把 Excel 欄位字母（如 `AJ`）換算成從 0 開始的陣列索引。 |
| `buildDbRecords(sheet)` | 直接用 Excel 欄位「位置」（A欄、B欄...）讀取原始 sheet，組成要寫入資料庫的紀錄陣列，並過濾掉沒有任何唯一碼（IMEI1/Serial No./MAC ID/PCBA SN）的空列。 |
| `uploadFileToStorage(fileId, fileName, bytes)` | 把使用者上傳的原始 Excel/CSV 檔案本身，上傳到 Supabase Storage（跟資料表分開的檔案儲存空間）。 |
| `deleteFromDatabase(dbFileId, storagePath, sourceFileName)` | 使用者移除某個檔案時，從 Supabase 的 `shipment_files` 資料表（連動刪除 `shipment_records`）跟 Storage 一併刪除該檔案。 |
| `saveToDatabase(sourceFileName, sheetName, model, dbRecords, storagePath, fileId)` | 把解析好的資料寫進 Supabase：先在 `shipment_files` 新增一筆代表這次上傳，再分批（每 500 筆）把資料列寫進 `shipment_records`；如果中途失敗會把剛新增的 file 記錄清掉，避免留下半份資料。 |
| `buildDbRecordsFromParsedRows(rows)` | 跟 `buildDbRecords` 類似，但是用「標題文字」對照欄位名稱，用在重新同步已經解析過、只剩下 IndexedDB 資料（沒有原始 Excel sheet）的舊檔案。 |
| `parseCsvRow(csvText)` | 簡單的單列 CSV 字串解析器（處理雙引號跳脫），對應 `toCsvRow()` 產生的格式，用來把資料庫存的 CSV 字串還原回一列資料。 |
| `csvRowToDisplayRow(csvText)` | 把 `full_row` 那串 CSV 文字，還原成跟本機解析格式一致的物件，才能套用到比對功能。 |
| `fetchRemoteFilesList()` | 從 Supabase 撈出所有檔案的中繼資料清單（不含實際資料列，只是輕量的檔案層級資訊）。 |
| `fetchRemoteFileRows(dbFileId)` | 依需要才把某個遠端檔案實際的資料列從 Supabase 撈回來（點查看 JSON 或執行比對時才拉，避免一開頁就撈一大堆資料）。 |
| `fileMetaOf(entry)` | 把內部完整的檔案物件，整理成只給畫面用的精簡版中繼資料（不含實際資料列）。 |
| `allColumns()` | 彙整目前所有已上傳檔案出現過的所有欄位名稱（去重複），給比對欄位下拉選單使用。 |
| `self.onmessage` | Worker 的訊息總入口，依收到的 `msg.type` 分派到對應邏輯：`set-config`（設定連線資訊）、`init`（初始化讀取歷史紀錄）、`parse`（解析新上傳的檔案）、`sync-to-db`（重新同步到資料庫）、`remove`（移除檔案）、`get-file-data`（讀取單一檔案完整資料）、`test-api`（連線測試）、`compare`（執行重複比對運算）。 |
| **`compare` 分支內的 `buildRowGroups()`** | 橫排比對邏輯：兩兩比較使用者選的欄位，找出同一列中兩個欄位值相同的資料。 |
| **`compare` 分支內的 `buildColumnGroups()`** | 直排比對邏輯：針對每個選定欄位，找出該欄位裡有哪些值在不同列中重複出現。 |

---

### `stats-by-model.html`（機種出貨量統計）

| 方法 | 用途 |
|---|---|
| `fetchModelCounts()` | 查詢 Supabase 的 `model_shipment_counts` view（資料庫端已經算好聚合結果），一次拿到「機種＋數量」清單，取代舊版逐筆撈資料再前端手動彙總的做法。 |
| `renderList(list)` | 把機種與數量清單渲染成畫面上的長條圖列表（含機種名稱、比例長條、數量）。 |
| `updateSummary(list, totalQty)` | 更新最上方的統計摘要（機種數、總出貨量）。 |
| `loadData()` | 頁面主要的載入流程：呼叫 `fetchModelCounts()`、更新狀態列、算出最大值跟總量、觸發畫面渲染；失敗時顯示錯誤訊息。 |
| **`searchBox` 的 input 事件內邏輯** | 依使用者輸入的關鍵字，即時篩選（debounce 150ms）已載入的機種清單並重新渲染。 |
| **`exportBtn` 的 click 事件內邏輯** | 把目前的機種統計資料組成 CSV 字串並觸發瀏覽器下載。 |

---

### `stats-by-date.html`（出貨日期與出貨量統計）

| 方法 | 用途 |
|---|---|
| `fetchAllShipmentFiles()` | 分頁撈出 Supabase `shipment_files` 表裡所有檔案的中繼資料（檔名、機種、列數、上傳時間）。因為是檔案層級資料，筆數通常不多，暫時不需要像 `stats-by-model.html` 那樣做聚合優化。 |
| `parseShipmentInfoFromFilename(filename)` | 用正則表達式從檔名裡解析出出貨日期（支援 `Aug 14 2026` 或 `260304` 兩種格式）跟出貨數量（檔名裡的 `XXXPCS`）。 |
| `formatDate(d)` | 把 `Date` 物件格式化成 `YYYY-MM-DD` 字串。 |
| `buildFlatGroups(rows)` | 把已解析出日期的資料列依「年-月」分組，同月份底下再依機種分組，計算每個機種、每個月份的總量。 |
| `renderFlatGroups(groups)` | 把分組結果渲染成可展開/收合的表格列（一行代表一個年月，點擊展開可看到該月所有檔案明細）。 |
| `currentFilteredRows(searchQ)` | 依搜尋關鍵字篩選已解析日期的資料列。 |
| `renderTables()` | 整合搜尋篩選、分組、渲染已解析與無法解析日期兩個區塊的完整流程。 |
| `bindTreeEvents()` | 幫每個年月列的展開/收合區塊綁定點擊事件。 |
| `loadData()` | 頁面主要的載入流程：呼叫 `fetchAllShipmentFiles()`、逐一解析檔名取得日期與數量、分成「可解析」與「無法解析」兩組、更新統計摘要並觸發渲染。 |
| **`expandAllBtn` 的 click 事件內邏輯** | 切換「全部展開／全部收合」所有年月分組。 |
| **`exportBtn` 的 click 事件內邏輯** | 把目前篩選後的資料組成 CSV 並觸發下載。 |

---

### `search.html`（資料庫搜尋）

| 方法 | 用途 |
|---|---|
| `testConnection()` | 測試跟 Supabase 的連線是否正常，更新畫面狀態列。 |
| `searchRecordsByField(query, dbField)` | 針對單一欄位（例如 `imei1`），用 `ilike` 模糊比對查詢 `shipment_records`，並一併帶出對應的 `shipment_files`（來源檔名、分頁、上傳時間）。 |
| `renderResults(query, recordResults)` | 把「簡易搜尋」模式下、依欄位分別查詢到的結果，合併渲染成一張表格，並標示每一列是命中哪個欄位。 |
| `runSearch()` | 簡易搜尋的主要流程：檢查輸入長度、同時對 `SEARCH_FIELDS` 裡列出的所有欄位（IMEI1、Serial No.、MAC ID 等共 12 個）平行查詢（`Promise.all`），再彙整結果渲染。 |
| `makeConditionRow()` | 動態產生「進階搜尋」的一列查詢條件（欄位下拉選單 + 輸入框 + 移除按鈕）。 |
| `relabelConditionRows()` | 重新標記進階搜尋條件列的前綴文字（第一行是「搜尋」，之後都是「AND」）。 |
| `searchRecordsByConditions(conditions)` | 把使用者填的多個條件組成一串用 `&` 連接的 PostgREST 查詢參數（AND 邏輯），查詢符合**全部**條件的資料列。 |
| `renderAdvancedResults(conditions, rows)` | 把進階搜尋的結果渲染成表格，欄位會依使用者選擇的搜尋條件動態產生。 |
| `runAdvancedSearch()` | 進階搜尋的主要流程：蒐集所有有填值的條件、呼叫 `searchRecordsByConditions()`、渲染結果。 |
