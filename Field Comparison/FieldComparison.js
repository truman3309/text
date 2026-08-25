function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}
// ================= 背景執行緒（Web Worker）=================
// 解析 Excel、比對運算、IndexedDB 讀寫、送資料庫 API 全部搬到背景執行緒做，
// 主執行緒只處理畫面，不管上傳幾百幾千個檔案都不會讓分頁「沒有回應」。
const WORKER_SRC = String.raw`
  importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const DB_NAME = 'fieldComparatorDB';
  const DB_VERSION = 2;
  const OLD_STORE_NAME = 'uploadedFiles';
  const META_STORE = 'meta';
  const DATA_STORE = 'data';
  let dbPromise = null;
  function openDB(){
    if(!self.indexedDB) return Promise.reject(new Error('瀏覽器不支援 IndexedDB'));
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;
        if(!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath:'id' });
        if(!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE, { keyPath:'id' });
        if(db.objectStoreNames.contains(OLD_STORE_NAME)){
          const oldStore = tx.objectStore(OLD_STORE_NAME);
          const metaStore = tx.objectStore(META_STORE);
          const dataStore = tx.objectStore(DATA_STORE);
          oldStore.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if(cursor){
              const old = cursor.value;
              metaStore.put({
                id: old.id, name: old.name, columns: old.columns || [],
                model: old.model || null, rowCount: (old.rows || []).length,
                uploadedAt: old.uploadedAt
              });
              dataStore.put({ id: old.id, rows: old.rows || [] });
              cursor.continue();
            } else {
              db.deleteObjectStore(OLD_STORE_NAME);
            }
          };
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }
  async function dbPutMeta(meta){
    try{
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put(meta);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } catch(err){}
  }
  async function dbPutData(data){
    try{
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DATA_STORE, 'readwrite');
        tx.objectStore(DATA_STORE).put(data);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } catch(err){}
  }
  async function dbGetData(id){
    try{
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DATA_STORE, 'readonly');
        const req = tx.objectStore(DATA_STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch(err){ return null; }
  }
  async function dbDeleteBoth(id){
    try{
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
        tx.objectStore(META_STORE).delete(id);
        tx.objectStore(DATA_STORE).delete(id);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } catch(err){}
  }
  async function dbClearBoth(){
    try{
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
        tx.objectStore(META_STORE).clear();
        tx.objectStore(DATA_STORE).clear();
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } catch(err){}
  }
  async function dbLoadAllMeta(){
    try{
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readonly');
        const req = tx.objectStore(META_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch(err){ return []; }
  }
  const store = new Map();
  async function ensureRowsLoaded(entry){
    if(entry.rows) return entry.rows;
    if(entry.remote && entry.dbFileId){
      entry.rows = await fetchRemoteFileRows(entry.dbFileId);
      return entry.rows;
    }
    const data = await dbGetData(entry.id);
    entry.rows = (data && data.rows) || [];
    return entry.rows;
  }
  function detectItemModel(columns, rows){
    const col = columns.find(c => c.replace(/[\s_-]/g,'').toLowerCase() === 'itemmodel');
    if(!col) return null;
    const SAMPLE_LIMIT = 20000;
    const sample = rows.length > SAMPLE_LIMIT ? rows.slice(0, SAMPLE_LIMIT) : rows;
    const counts = new Map();
    sample.forEach(r => {
      const v = String(r[col] == null ? '' : r[col]).trim();
      if(!v) return;
      counts.set(v, (counts.get(v)||0)+1);
    });
    if(!counts.size) return null;
    let best=null, bestCount=-1;
    counts.forEach((cnt,v) => { if(cnt>bestCount){ best=v; bestCount=cnt; } });
    return best;
  }
  // ---------- 資料庫欄位對照表（跟後端 server.js 的 FIELD_MAP 完全對齊，依 Excel 欄位位置）----------
  const DB_COLUMN_MAP = [
    ['A','poNo'],['B','referenceId'],['C','soNoContainerNo'],['D','vessel'],
    ['E','itemModel'],['F','brand'],['G','palletNo'],['H','color'],
    ['I','imei1'],['J','imei2'],['K','carton'],['L','sim'],
    ['M','serialNo'],['N','macId'],['O','bluetoothId'],['P','batterySn'],
    ['Q','buildNo'],['R','simPreinstalled'],['S','apnLoaded'],['T','enrolled'],['U','remark'],
    ['V','accessories'],['W','housing'],['X','screen'],['Y','screenSupplier'],['Z','memoryComments'],
    ['AA','vibratorSupplier'],['AB','lightProximitySensor'],['AC','byFactory'],['AD','assemblyLine'],
    ['AE','manufacturedDate'],['AF','eid'],['AG','internalVersion'],['AH','oemUnlockCode'],['AI','skuItemNo'],
    ['AJ','pcbaSn'],['AK','lcdSn'],['AL','mamboDeviceId'],['AM','bluetoothMac2'],['AN','iccid'],
    ['AO','rfidEpcMemoryBrand'],['AP','rfidAndroidSn'],['AQ','batteryManufactureDate'],['AR','isim'],
    ['AS','cameraIndicator'],['AT','wifi5g'],['AU','guestWifi'],['AV','btMacMainBoard'],['AW','btMacDaughterBoard'],
    ['AX','rfidBrand'],['AY','rfidTid'],['AZ','pcbMainBoardSn'],['BA','blePcbSerialNo'],['BB','unitRemarks'],
    ['BC','esimIccid'],['BD','imsi'],['BE','simUnlockCode'],
  ];
  // ---------- 直接連 Supabase（REST API / PostgREST 語法），不再經過中間的後端伺服器 ----------
  const SUPABASE_URL = 'https://brhjfveertlypgrwkqfq.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJyaGpmdmVlcnRseXBncndrcWZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxODI5NTUsImV4cCI6MjEwMjc1ODk1NX0.8fQJ-kiIHV8ePjDTjfby7fHmthqWekD1Sf3TtzfbGwo';
  function supabaseHeaders(extra){
    return Object.assign({
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    }, extra || {});
  }
  function genDbId(){
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  // camelCase（前端解析用的 key）-> snake_case（Supabase 資料表實際欄位名稱）
  const CAMEL_TO_SNAKE = {
    poNo:'po_no', referenceId:'reference_id', soNoContainerNo:'so_no_container_no', vessel:'vessel',
    itemModel:'item_model', brand:'brand', palletNo:'pallet_no', color:'color',
    imei1:'imei1', imei2:'imei2', carton:'carton', sim:'sim',
    serialNo:'serial_no', macId:'mac_id', bluetoothId:'bluetooth_id', batterySn:'battery_sn',
    buildNo:'build_no', simPreinstalled:'sim_preinstalled', apnLoaded:'apn_loaded', enrolled:'enrolled', remark:'remark',
    accessories:'accessories', housing:'housing', screen:'screen', screenSupplier:'screen_supplier', memoryComments:'memory_comments',
    vibratorSupplier:'vibrator_supplier', lightProximitySensor:'light_proximity_sensor', byFactory:'by_factory', assemblyLine:'assembly_line',
    manufacturedDate:'manufactured_date', eid:'eid', internalVersion:'internal_version', oemUnlockCode:'oem_unlock_code', skuItemNo:'sku_item_no',
    pcbaSn:'pcba_sn', lcdSn:'lcd_sn', mamboDeviceId:'mambo_device_id', bluetoothMac2:'bluetooth_mac_2', iccid:'iccid',
    rfidEpcMemoryBrand:'rfid_epc_memory_brand', rfidAndroidSn:'rfid_android_sn', batteryManufactureDate:'battery_manufacture_date', isim:'isim',
    cameraIndicator:'camera_indicator', wifi5g:'wifi_5g', guestWifi:'guest_wifi', btMacMainBoard:'bt_mac_main_board', btMacDaughterBoard:'bt_mac_daughter_board',
    rfidBrand:'rfid_brand', rfidTid:'rfid_tid', pcbMainBoardSn:'pcb_main_board_sn', blePcbSerialNo:'ble_pcb_serial_no', unitRemarks:'unit_remarks',
    esimIccid:'esim_iccid', imsi:'imsi', simUnlockCode:'sim_unlock_code',
  };
  function toSnakeCaseFields(rec){
    const out = {};
    Object.keys(CAMEL_TO_SNAKE).forEach(camel => { out[CAMEL_TO_SNAKE[camel]] = rec[camel] || null; });
    return out;
  }
  // 把一列資料依照 Excel 欄位順序（A~BE）組成一行 CSV 文字，取代原本存 JSON 物件的做法
  function toCsvRow(rec){
    return DB_COLUMN_MAP.map(([, key]) => {
      const s = String(rec[key] ?? '');
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }
  function colLetterToIndex(letter){
    let idx = 0;
    for(let i = 0; i < letter.length; i++) idx = idx * 26 + (letter.toUpperCase().charCodeAt(i) - 64);
    return idx - 1;
  }
  function buildDbRecords(sheet){
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if(raw.length < 2) return [];
    return raw.slice(1)
      .map(rowArr => {
        const rec = {};
        DB_COLUMN_MAP.forEach(([letter, key]) => {
          const idx = colLetterToIndex(letter);
          const v = rowArr[idx];
          rec[key] = (v === undefined || v === null) ? '' : String(v).trim();
        });
        return rec;
      })
      .filter(rec => rec.imei1 || rec.serialNo || rec.macId || rec.pcbaSn);
  }
  // 把原始 Excel 檔案本身上傳到 Supabase Storage（跟資料表是分開的儲存空間）
  async function uploadFileToStorage(fileId, fileName, bytes){
    const path = fileId + '/' + encodeURIComponent(fileName);
    try{
      const res = await fetch(SUPABASE_URL + '/storage/v1/object/excel-files/' + path, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Content-Type': 'application/octet-stream',
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if(!res.ok){
        const errData = await res.json().catch(() => ({}));
        return { ok:false, error: errData.message || res.statusText };
      }
      return { ok:true, path };
    } catch(err){
      return { ok:false, error: err.message };
    }
  }
  // 從 Supabase 刪除這個檔案（shipment_files 那筆刪掉，靠 ON DELETE CASCADE 連動刪掉底下所有 shipment_records），
  // 以及 Storage 裡的原始檔案
  async function deleteFromDatabase(dbFileId, storagePath, sourceFileName){
    const errors = [];
    if(dbFileId){
      try{
        const res = await fetch(SUPABASE_URL + '/rest/v1/shipment_files?id=eq.' + encodeURIComponent(dbFileId), {
          method: 'DELETE', headers: supabaseHeaders(),
        });
        if(!res.ok){
          const errData = await res.json().catch(() => ({}));
          errors.push('資料表：' + (errData.message || res.statusText));
        }
      } catch(err){ errors.push('資料表：' + err.message); }
    } else if(sourceFileName){
      // 沒有記錄資料庫 id 的舊檔案（這個功能上線前就上傳過的），改用檔名去資料庫比對刪除
      try{
        const res = await fetch(SUPABASE_URL + '/rest/v1/shipment_files?source_file_name=eq.' + encodeURIComponent(sourceFileName), {
          method: 'DELETE', headers: supabaseHeaders(),
        });
        if(!res.ok){
          const errData = await res.json().catch(() => ({}));
          errors.push('資料表（依檔名比對）：' + (errData.message || res.statusText));
        }
      } catch(err){ errors.push('資料表（依檔名比對）：' + err.message); }
    }
    if(storagePath){
      try{
        const res = await fetch(SUPABASE_URL + '/storage/v1/object/excel-files/' + storagePath, {
          method: 'DELETE', headers: supabaseHeaders(),
        });
        if(!res.ok){
          const errData = await res.json().catch(() => ({}));
          errors.push('Storage：' + (errData.message || res.statusText));
        }
      } catch(err){ errors.push('Storage：' + err.message); }
    }
    return errors.length ? { ok:false, error: errors.join('；') } : { ok:true };
  }
  async function saveToDatabase(sourceFileName, sheetName, model, dbRecords, storagePath, fileId){
    if(!dbRecords.length) return { attempted:false };
    fileId = fileId || genDbId();
    try{
      // 1) 先在 shipment_files 新增一筆代表這次上傳
      const fileRes = await fetch(SUPABASE_URL + '/rest/v1/shipment_files', {
        method: 'POST',
        headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify([{
          id: fileId, source_file_name: sourceFileName, sheet_name: sheetName,
          model: model || null, row_count: dbRecords.length, storage_path: storagePath || null,
        }]),
      });
      if(!fileRes.ok){
        const errData = await fileRes.json().catch(() => ({}));
        return { attempted:true, ok:false, error: errData.message || fileRes.statusText };
      }
      // 2) 分批把資料列寫進 shipment_records（Supabase 一次 insert 可以送整個陣列）
      const BATCH_SIZE = 500;
      for(let i = 0; i < dbRecords.length; i += BATCH_SIZE){
        const batch = dbRecords.slice(i, i + BATCH_SIZE).map((rec, idx) => Object.assign(
          { file_id: fileId, row_index: i + idx, full_row: toCsvRow(rec) },
          toSnakeCaseFields(rec)
        ));
        const recRes = await fetch(SUPABASE_URL + '/rest/v1/shipment_records', {
          method: 'POST',
          headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
          body: JSON.stringify(batch),
        });
        if(!recRes.ok){
          const errData = await recRes.json().catch(() => ({}));
          // 中途失敗時把剛新增的 file 清掉（設定了 ON DELETE CASCADE，記錄會一起清），避免留下半份資料
          await fetch(SUPABASE_URL + '/rest/v1/shipment_files?id=eq.' + fileId, {
            method: 'DELETE', headers: supabaseHeaders(),
          }).catch(() => {});
          return { attempted:true, ok:false, error: errData.message || recRes.statusText };
        }
      }
      return { attempted:true, ok:true, rowCount: dbRecords.length, fileId };
    } catch(err){
      return { attempted:true, ok:false, error: err.message };
    }
  }
  // 標題文字 -> 資料庫欄位名稱的對照（重新同步已解析過的舊資料時用，
  // 這種情況只剩下依標題文字為 key 的 rows，沒有原始 sheet 可以照欄位位置重讀）
  const HEADER_NAME_MAP = {
    'PO No.':'poNo', 'Reference ID':'referenceId', 'SO No./Container No.':'soNoContainerNo', 'Vessel':'vessel',
    'Item Model':'itemModel', 'Brand':'brand', 'Pallet No.':'palletNo', 'Color':'color',
    'IMEI1':'imei1', 'IMEI2':'imei2', 'Carton':'carton', 'SIM':'sim',
    'Serial No.':'serialNo', 'MAC ID':'macId', 'Bluetooth ID':'bluetoothId', 'Battery SN':'batterySn',
    'Build No.':'buildNo', 'SIM preinstalled':'simPreinstalled', 'APN Loaded':'apnLoaded', 'Enrolled':'enrolled', 'Remark':'remark',
    'Accessories':'accessories', 'Housing':'housing', 'Screen':'screen', 'Screen supplier':'screenSupplier', 'Memory comments':'memoryComments',
    'Vibrator supplier':'vibratorSupplier', 'Light and proximity sensor':'lightProximitySensor', 'By Factory':'byFactory', 'Assembly Line':'assemblyLine',
    'Manufactured Date':'manufacturedDate', 'EID':'eid', 'Internal Version':'internalVersion', 'Oem Unlock Code':'oemUnlockCode', 'SKU - Item No.':'skuItemNo',
    'PCBA SN':'pcbaSn', 'LCD SN':'lcdSn', 'Mambo Device ID':'mamboDeviceId', 'Bluetooth MAC 2':'bluetoothMac2', 'ICCID':'iccid',
    'RFID EPC MEMORY BRAND':'rfidEpcMemoryBrand', 'RFID (Android SN)':'rfidAndroidSn', 'Battery Manufacture Date':'batteryManufactureDate', 'ISIM':'isim',
    'Camera Indicator':'cameraIndicator', '5G Wifi':'wifi5g', 'Guest Wifi':'guestWifi',
    'BT MAC – Main Board':'btMacMainBoard', 'BT MAC – Daughter Board':'btMacDaughterBoard',
    'RFID Brand':'rfidBrand', 'RFID TID':'rfidTid', 'PCB Main Board Serial No.':'pcbMainBoardSn', 'BLE PCB Serial No.':'blePcbSerialNo',
    'Unit Remarks':'unitRemarks', 'eSIM ICCID':'esimIccid', 'IMSI':'imsi', 'SIM Unlock Code':'simUnlockCode',
  };
  function buildDbRecordsFromParsedRows(rows){
    return rows.map(row => {
      const rec = {};
      Object.keys(HEADER_NAME_MAP).forEach(header => {
        const key = HEADER_NAME_MAP[header];
        const v = row[header];
        rec[key] = (v === undefined || v === null) ? '' : String(v).trim();
      });
      return rec;
    }).filter(rec => rec.imei1 || rec.serialNo || rec.macId || rec.pcbaSn);
  }
  // camelKey -> 原始 Excel 標題文字（HEADER_NAME_MAP 的反向對照），
  // 用來把資料庫存的 CSV 資料還原成跟本機解析格式一致的物件，才能套用到比對功能
  const CAMEL_TO_HEADER = {};
  Object.keys(HEADER_NAME_MAP).forEach(header => { CAMEL_TO_HEADER[HEADER_NAME_MAP[header]] = header; });
  const HEADERS_IN_DB_ORDER = DB_COLUMN_MAP.map(([, camelKey]) => CAMEL_TO_HEADER[camelKey] || camelKey);
  // 簡單的 CSV 單列解析（處理雙引號跳脫），對應 toCsvRow() 產生的格式
  function parseCsvRow(csvText){
    const result = [];
    let cur = '';
    let inQuotes = false;
    const s = String(csvText || '');
    for(let i = 0; i < s.length; i++){
      const c = s[i];
      if(inQuotes){
        if(c === '"'){
          if(s[i + 1] === '"'){ cur += '"'; i++; }
          else inQuotes = false;
        } else cur += c;
      } else {
        if(c === '"') inQuotes = true;
        else if(c === ','){ result.push(cur); cur = ''; }
        else cur += c;
      }
    }
    result.push(cur);
    return result;
  }
  function csvRowToDisplayRow(csvText){
    const values = parseCsvRow(csvText);
    const row = {};
    HEADERS_IN_DB_ORDER.forEach((header, idx) => { row[header] = values[idx] ?? ''; });
    return row;
  }
  // 撈出資料庫裡「全部」的檔案清單（只有檔案層級的中繼資料，不含資料列，很輕量）
  async function fetchRemoteFilesList(){
    try{
      const res = await fetch(SUPABASE_URL + '/rest/v1/shipment_files?select=*&order=uploaded_at.asc&limit=1000', {
        headers: supabaseHeaders(),
      });
      if(!res.ok) return { ok:false, files: [] };
      return { ok:true, files: await res.json() };
    } catch(err){ return { ok:false, files: [] }; }
  }
  // 依需要才把某個檔案實際的資料列從資料庫撈回來（點查看 JSON 或執行比對時才拉，避免一開頁就撈一大堆資料）
  async function fetchRemoteFileRows(dbFileId){
    try{
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/shipment_records?file_id=eq.' + encodeURIComponent(dbFileId) + '&select=row_index,full_row&order=row_index.asc&limit=100000',
        { headers: supabaseHeaders() }
      );
      if(!res.ok) return [];
      const data = await res.json();
      return data.map(r => csvRowToDisplayRow(r.full_row));
    } catch(err){ return []; }
  }
  function fileMetaOf(entry){
    return {
      id: entry.id, name: entry.name, rowCount: entry.rowCount, columnCount: entry.columns.length,
      model: entry.model, dbStatus: entry.dbStatus || null, dbError: entry.dbError || null,
      storagePath: entry.storagePath || null, dbFileId: entry.dbFileId || null,
      remote: !!entry.remote,
    };
  }
  function allColumns(){
    const seen = new Set(); const cols = [];
    store.forEach(entry => entry.columns.forEach(c => { if(!seen.has(c)){ seen.add(c); cols.push(c); } }));
    return cols;
  }
  self.onmessage = async function(e){
    const msg = e.data;
    try{
      if(msg.type === 'init'){
        const metas = await dbLoadAllMeta();
        metas.sort((a,b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
        metas.forEach(m => store.set(m.id, { ...m, rows: null }));
        // 每次打開網頁都去資料庫撈一次完整檔案清單，把本機沒有的（例如別的裝置上傳的）補進畫面
        const remoteResult = await fetchRemoteFilesList();
        const localDbFileIds = new Set([...store.values()].map(e => e.dbFileId).filter(Boolean));
        const localNames = new Set([...store.values()].map(e => e.name));
        remoteResult.files.forEach(rf => {
          if(localDbFileIds.has(rf.id) || localNames.has(rf.source_file_name)) return; // 本機已經有了，不重複加入
          const remoteId = 'remote-' + rf.id;
          store.set(remoteId, {
            id: remoteId, name: rf.source_file_name, sheetName: rf.sheet_name, columns: HEADERS_IN_DB_ORDER,
            model: rf.model, rowCount: rf.row_count, uploadedAt: rf.uploaded_at, rows: null,
            dbStatus: 'ok', dbError: null, storagePath: rf.storage_path || null, dbFileId: rf.id,
            remote: true,
          });
        });
        // 這次撈檔案清單如果成功，就代表連線正常，不用再額外打一次 /rest/v1 測連線
        self.postMessage({ type:'init-ok', reqId: msg.reqId, files: [...store.values()].map(fileMetaOf), columns: allColumns(), connectionOk: remoteResult.ok });
      } else if(msg.type === 'parse'){
        try{
          const data = new Uint8Array(msg.buffer);
          const wb = XLSX.read(data, { type:'array' });
          const sheetName = wb.SheetNames[0];
          const sheet = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
          if(!rows.length) throw new Error('檔案內沒有可讀取的資料列');
          // 過濾掉沒有標題文字的欄位（SheetJS 會自動取名成 __EMPTY / __EMPTY_1 ...），
          // 這些通常是 Excel 裡沒填標題的空白欄，不需要出現在比對欄位選單裡
          const columns = Object.keys(rows[0]).filter(c => !/^__EMPTY(_\d+)?$/.test(c));
          const model = detectItemModel(columns, rows);
          const id = Date.now() + '-' + Math.random().toString(36).slice(2,7) + '-' + store.size;
          const uploadedAt = new Date().toISOString();
          const entry = { id, name: msg.name, sheetName, columns, model, rowCount: rows.length, uploadedAt, rows };
          // 先把原始 Excel 檔案本身上傳到 Supabase Storage，跟資料庫用同一個 id 串起來
          const dbFileId = genDbId();
          const uploadResult = await uploadFileToStorage(dbFileId, msg.name, data);
          entry.storagePath = uploadResult.ok ? uploadResult.path : null;
          entry.storageError = uploadResult.ok ? null : uploadResult.error;
          const dbRecords = buildDbRecords(sheet);
          if(!dbRecords.length){
            // 明確標示成失敗，而不是讓它安靜地留在「未同步」狀態不容易被發現
            entry.dbStatus = 'bad';
            entry.dbError = '找不到任何可辨識的唯一碼欄位（IMEI1/Serial No./MAC ID/PCBA SN 都是空的），請確認這份 Excel 的 I/M/N/AJ 欄位位置是否符合預期範本';
            entry.dbFileId = null;
          } else {
            const dbResult = await saveToDatabase(msg.name, sheetName, model, dbRecords, entry.storagePath, dbFileId);
            entry.dbStatus = !dbResult.attempted ? null : (dbResult.ok ? 'ok' : 'bad');
            entry.dbError = dbResult.ok === false ? dbResult.error : null;
            entry.dbFileId = dbResult.ok ? dbResult.fileId : null;
          }
          store.set(id, entry);
          dbPutMeta({ id, name: entry.name, sheetName: entry.sheetName, columns: entry.columns, model: entry.model, rowCount: entry.rowCount, uploadedAt: entry.uploadedAt, dbStatus: entry.dbStatus || null, dbError: entry.dbError || null, storagePath: entry.storagePath || null, dbFileId: entry.dbFileId || null });
          dbPutData({ id, rows: entry.rows });
          self.postMessage({ type:'parse-ok', reqId: msg.reqId, file: fileMetaOf(entry), columns: allColumns(), dbError: entry.dbError });
        } catch(err){
          self.postMessage({ type:'parse-err', reqId: msg.reqId, message: (err && err.message) || '無法解析檔案，請確認格式為 .xlsx / .xls / .csv' });
        }
      } else if(msg.type === 'sync-to-db'){
        const entry = store.get(msg.id);
        if(!entry){
          self.postMessage({ type:'sync-to-db-err', reqId: msg.reqId, message: '找不到這個檔案的資料（可能已經被移除）' });
        } else {
          await ensureRowsLoaded(entry);
          const dbRecords = buildDbRecordsFromParsedRows(entry.rows);
          if(!dbRecords.length){
            entry.dbStatus = 'bad';
            entry.dbError = '找不到任何可辨識的唯一碼欄位（IMEI1/Serial No./MAC ID/PCBA SN 都是空的），請確認這份 Excel 的欄位是否符合預期範本';
          } else {
            const dbResult = await saveToDatabase(entry.name, entry.sheetName || 'Report', entry.model, dbRecords);
            entry.dbStatus = !dbResult.attempted ? null : (dbResult.ok ? 'ok' : 'bad');
            entry.dbError = dbResult.ok === false ? dbResult.error : null;
            entry.dbFileId = dbResult.ok ? dbResult.fileId : (entry.dbFileId || null);
          }
          dbPutMeta({ id: entry.id, name: entry.name, sheetName: entry.sheetName, columns: entry.columns, model: entry.model, rowCount: entry.rowCount, uploadedAt: entry.uploadedAt, dbStatus: entry.dbStatus || null, dbError: entry.dbError || null, storagePath: entry.storagePath || null, dbFileId: entry.dbFileId || null });
          self.postMessage({ type:'sync-to-db-ok', reqId: msg.reqId, file: fileMetaOf(entry) });
        }
      } else if(msg.type === 'remove'){
        const entry = store.get(msg.id);
        let dbDeleteError = null;
        if(entry){
          const delResult = await deleteFromDatabase(entry.dbFileId, entry.storagePath, entry.dbFileId ? null : entry.name);
          if(!delResult.ok) dbDeleteError = delResult.error;
        }
        store.delete(msg.id);
        dbDeleteBoth(msg.id);
        self.postMessage({ type:'remove-ok', reqId: msg.reqId, columns: allColumns(), dbDeleteError });
      } else if(msg.type === 'get-file-data'){
        const entry = store.get(msg.id);
        if(!entry){
          self.postMessage({ type:'get-file-data-err', reqId: msg.reqId, message: '找不到這個檔案的資料（可能已經被移除）' });
        } else {
          await ensureRowsLoaded(entry);
          self.postMessage({ type:'get-file-data-ok', reqId: msg.reqId, name: entry.name, columns: entry.columns, rows: entry.rows });
        }
      } else if(msg.type === 'clear-all'){
        store.clear();
        dbClearBoth();
        self.postMessage({ type:'clear-all-ok', reqId: msg.reqId });
      } else if(msg.type === 'test-api'){
        try{
          const res = await fetch(SUPABASE_URL + '/rest/v1/shipment_files?select=id&limit=1', {
            headers: supabaseHeaders(),
          });
          if(res.ok){
            self.postMessage({ type:'test-api-ok', reqId: msg.reqId, ok:true, error:null });
          } else {
            const errData = await res.json().catch(() => ({}));
            self.postMessage({ type:'test-api-ok', reqId: msg.reqId, ok:false, error: errData.message || res.statusText });
          }
        } catch(err){
          self.postMessage({ type:'test-api-ok', reqId: msg.reqId, ok:false, error: err.message });
        }
      } else if(msg.type === 'compare'){
        const { compareCols, compareMode, ignoreCase, ignoreSpace } = msg;
        const normalize = (v) => {
          let s = String(v == null ? '' : v);
          if(ignoreSpace) s = s.trim();
          if(ignoreCase) s = s.toLowerCase();
          return s;
        };
        await Promise.all([...store.values()].map(ensureRowsLoaded));
        const allRows = [];
        store.forEach(entry => entry.rows.forEach(r => allRows.push({ file: entry.name, row: r })));
        const cols = allColumns();
        function buildRowGroups(){
          const groups = [];
          for(let i=0;i<compareCols.length;i++){
            for(let j=i+1;j<compareCols.length;j++){
              const a=compareCols[i], b=compareCols[j];
              const matched = allRows.filter(item => {
                const va = normalize(item.row[a]);
                const vb = normalize(item.row[b]);
                return va !== '' && va === vb;
              });
              if(matched.length) groups.push({ mode:'horizontal', label: a+' = '+b, matchedFields:[a,b], items: matched });
            }
          }
          return groups;
        }
        function buildColumnGroups(){
          const groups = [];
          compareCols.forEach(c => {
            const map = new Map();
            allRows.forEach(item => {
              const v = normalize(item.row[c]);
              if(v==='') return;
              if(!map.has(v)) map.set(v, []);
              map.get(v).push(item);
            });
            map.forEach(arr => {
              if(arr.length>1) groups.push({ mode:'vertical', label: c+'（值：'+arr[0].row[c]+'）', matchedFields:[c], items: arr });
            });
          });
          return groups;
        }
        let allGroups = [];
        if(compareMode==='horizontal'||compareMode==='both') allGroups = allGroups.concat(buildRowGroups());
        if(compareMode==='vertical'||compareMode==='both') allGroups = allGroups.concat(buildColumnGroups());
        const flat = [];
        allGroups.forEach((g,gi) => g.items.forEach(item => flat.push({
          groupIndex: gi, mode: g.mode, label: g.label, matchedFields: g.matchedFields, file: item.file, row: item.row
        })));
        self.postMessage({
          type:'compare-ok', reqId: msg.reqId,
          flat, groupCount: allGroups.length, totalRows: allRows.length, fileCount: store.size, cols
        });
      }
    } catch(err){
      self.postMessage({ type:'error', reqId: msg.reqId, message: (err && err.message) || '背景執行緒發生未預期的錯誤' });
    }
  };
`;
let worker = null;
let reqCounter = 0;
const pending = new Map();
function getWorker(){
  if(worker) return worker;
  const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
  worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = (e) => {
    const msg = e.data;
    const p = pending.get(msg.reqId);
    if(!p) return;
    pending.delete(msg.reqId);
    if(msg.type && (msg.type.endsWith('-err') || msg.type === 'error')) p.reject(new Error(msg.message));
    else p.resolve(msg);
  };
  worker.onerror = (e) => {
    pending.forEach(p => p.reject(new Error('背景執行緒發生錯誤：' + e.message)));
    pending.clear();
  };
  return worker;
}
function workerCall(payload, transfer){
  return new Promise((resolve, reject) => {
    let w;
    try{ w = getWorker(); } catch(err){ reject(err); return; }
    const reqId = ++reqCounter;
    pending.set(reqId, { resolve, reject });
    w.postMessage({ ...payload, reqId }, transfer || []);
  });
}
// ================= 資料庫連線狀態（直接連 Supabase，網址跟金鑰寫在 Worker 裡）=================
const apiStatusDot = document.getElementById('apiStatusDot');
const apiStatusText = document.getElementById('apiStatusText');
function setStatusBar(state, text){
  apiStatusDot.className = 'dot' + (state ? ' ' + state : '');
  apiStatusText.textContent = text;
}
async function testApiConnection(){
  setStatusBar('pending', '資料庫連線：測試中…');
  try{
    const res = await workerCall({ type:'test-api' });
    if(res.ok){
      setStatusBar('ok', '資料庫連線成功');
      return true;
    }
    throw new Error(res.error || '未知錯誤');
  } catch(err){
    setStatusBar('bad', '資料庫連線失敗：' + err.message);
    return false;
  }
}
// ================= 主執行緒狀態（只存輕量的中繼資料，不存整份資料）=================
let fileMeta = [];
let cachedColumns = [];
const expandedGroups = new Set();
const openGroups = new Set(); // 記錄使用者主動展開過的分組，預設全部收起
const GROUP_INITIAL_SHOW = 50;
const compareFieldsList = document.getElementById('compareFieldsList');
const compareCountInput = document.getElementById('compareCount');
function makeCompareRow(index){
  const row = document.createElement('div');
  row.className = 'compare-field-row';
  const label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = '比對欄位 ' + (index + 1);
  row.appendChild(label);
  const sel = document.createElement('select');
  sel.className = 'compare-field-select';
  row.appendChild(sel);
  return row;
}
function syncCompareFields(count){
  const rows = compareFieldsList.querySelectorAll('.compare-field-row');
  if(count > rows.length){
    for(let i = rows.length; i < count; i++) compareFieldsList.appendChild(makeCompareRow(i));
  } else if(count < rows.length){
    for(let i = rows.length - 1; i >= count; i--) rows[i].remove();
  }
  refreshCompareFieldOptions();
}
function refreshCompareFieldOptions(){
  compareFieldsList.querySelectorAll('.compare-field-select').forEach(sel => {
    const prev = sel.value;
    if(cachedColumns.length){
      sel.disabled = false;
      sel.innerHTML = cachedColumns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      if(cachedColumns.includes(prev)) sel.value = prev;
    } else {
      sel.disabled = true;
      sel.innerHTML = '<option>先上傳檔案</option>';
    }
  });
}
compareCountInput.addEventListener('change', () => {
  let v = parseInt(compareCountInput.value, 10);
  if(isNaN(v) || v < 1) v = 1;
  if(v > 100) v = 100;
  compareCountInput.value = v;
  syncCompareFields(v);
});
syncCompareFields(1);
const slot = document.getElementById('slotS');
const input = document.getElementById('fileS');
const body = document.getElementById('slotSBody');
function refreshMainSlotDisplay(){
  if(!fileMeta.length){
    slot.classList.remove('loaded');
    body.innerHTML = `<div class="slot-main">點擊或拖曳檔案到此處（可一次選大量檔案，會加入比對範圍）</div><div class="slot-hint">支援 .xlsx / .xls / .csv</div>`;
    return;
  }
  slot.classList.add('loaded');
  const totalRows = fileMeta.reduce((sum, f) => sum + f.rowCount, 0);
  body.innerHTML = `
    <div class="slot-file">已上傳 ${fileMeta.length} 個檔案，共 ${totalRows} 列</div>
    <div class="slot-meta">比對時會把這些檔案合併在一起找重複。點擊或拖曳可以再加入更多檔案</div>`;
}
function checkReady(){ document.getElementById('runBtnS').disabled = !fileMeta.length; }
function showSingleError(msg){ document.getElementById('errorMsgS').textContent = msg; }
function clearSingleError(){ document.getElementById('errorMsgS').textContent = ''; }
async function handleFiles(fileList){
  clearSingleError();
  const files = Array.from(fileList || []);
  if(!files.length) return;
  const errors = [];
  const skipped = [];
  const dbErrors = [];
  const total = files.length;
  const knownNames = new Set(fileMeta.map(f => f.name));
  for(let i = 0; i < files.length; i++){
    const file = files[i];
    if(knownNames.has(file.name)){
      skipped.push(file.name);
      continue;
    }
    const pct = Math.round((i / total) * 100);
    slot.classList.add('loaded');
    body.innerHTML = `
      <div class="slot-file">正在解析中…（${i + 1} / ${total}）</div>
      <div class="slot-meta">${escapeHtml(file.name)}　同步存進資料庫中…</div>
      <div class="upload-progress-track"><div class="upload-progress-fill" style="width:${pct}%"></div></div>`;
    await new Promise(resolve => setTimeout(resolve, 0));
    try{
      const buffer = await file.arrayBuffer();
      const res = await workerCall({ type:'parse', buffer, name: file.name }, [buffer]);
      fileMeta.push(res.file);
      cachedColumns = res.columns;
      knownNames.add(file.name);
      if(res.dbError) dbErrors.push(`${file.name}：${res.dbError}`);
    } catch(err){
      errors.push(`${file.name}：${err.message}`);
    }
  }
  refreshCompareFieldOptions();
  refreshMainSlotDisplay();
  document.getElementById('results').classList.remove('show');
  checkReady();
  renderFilesList();
  const messages = [];
  if(skipped.length) messages.push(`${skipped.length} 個檔案因檔名重複已跳過：` + skipped.slice(0, 5).join('、') + (skipped.length > 5 ? ` …等共 ${skipped.length} 個` : ''));
  if(errors.length) messages.push(`${errors.length} 個檔案解析失敗：` + errors.slice(0, 5).join('；') + (errors.length > 5 ? ` …等共 ${errors.length} 個` : ''));
  if(dbErrors.length) messages.push(`${dbErrors.length} 個檔案存進資料庫失敗：` + dbErrors.slice(0, 5).join('；') + (dbErrors.length > 5 ? ` …等共 ${dbErrors.length} 個` : ''));
  if(messages.length) showSingleError(messages.join('\n'));
}
slot.addEventListener('click', () => input.click());
slot.addEventListener('keydown', (e) => { if(e.key==='Enter'||e.key===' ') input.click(); });
input.addEventListener('change', (e) => { handleFiles(e.target.files); input.value = ''; });
['dragover','dragenter'].forEach(ev => slot.addEventListener(ev, (e)=>{ e.preventDefault(); slot.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => slot.addEventListener(ev, (e)=>{ e.preventDefault(); slot.classList.remove('drag'); }));
slot.addEventListener('drop', (e) => { handleFiles(e.dataTransfer.files); });
function dbBadgeHtml(f){
  if(f.remote) return '<div class="db-badge ok" title="這筆是打開網頁時從資料庫撈回來的，不是這個瀏覽器上傳的">☁ 來自資料庫</div>';
  if(f.dbStatus === 'ok') return '<div class="db-badge ok">已存進資料庫</div>';
  if(f.dbStatus === 'bad') return `<div class="db-badge bad" title="${escapeHtml(f.dbError || '')}">資料庫存入失敗</div>`;
  return '<div class="db-badge off">未同步資料庫</div>';
}
function renderFilesList(){
  const list = document.getElementById('filesList');
  const clearAllBtn = document.getElementById('clearAllFilesBtn');
  const syncAllBtn = document.getElementById('syncAllBtn');
  clearAllBtn.style.display = fileMeta.length ? 'block' : 'none';
  const unsyncedCount = fileMeta.filter(f => f.dbStatus !== 'ok').length;
  syncAllBtn.style.display = unsyncedCount ? 'block' : 'none';
  syncAllBtn.textContent = `同步未存入的檔案到資料庫（${unsyncedCount} 個）`;
  if(!fileMeta.length){
    list.innerHTML = '<div class="files-empty" id="filesEmpty">尚未上傳任何檔案</div>';
    return;
  }
  const groups = new Map();
  fileMeta.forEach(f => {
    const label = f.model || '未分類';
    if(!groups.has(label)) groups.set(label, []);
    groups.get(label).push(f);
  });
  const groupEntries = [...groups.entries()].sort((a, b) => {
    if(a[0] === '未分類') return 1;
    if(b[0] === '未分類') return -1;
    return a[0].localeCompare(b[0], 'zh-Hant');
  });
  let html = '';
  groupEntries.forEach(([label, files]) => {
    const isCollapsed = !openGroups.has(label);
    const isExpanded = expandedGroups.has(label);
    const visibleFiles = isExpanded ? files : files.slice(0, GROUP_INITIAL_SHOW);
    const totalRowsInGroup = files.reduce((sum, f) => sum + f.rowCount, 0);
    html += `<div class="file-group-label" data-collapse-label="${escapeHtml(label)}"><span class="group-label-text"><span class="group-arrow">${isCollapsed ? '▸' : '▾'}</span>${escapeHtml(label)}</span><span class="file-group-count">${files.length} 個・${totalRowsInGroup} 列</span></div>`;
    if(!isCollapsed){
      html += visibleFiles.map(f => `
        <div class="file-item" data-id="${f.id}">
          <div class="file-item-main">
            <div class="file-item-name">${escapeHtml(f.name)}</div>
            <div class="file-item-meta">${f.rowCount} 列・${f.columnCount} 欄</div>
          </div>
          <div class="file-item-actions">
            <button class="file-json-btn" data-id="${f.id}">查看 JSON</button>
            <button class="file-remove-btn" data-id="${f.id}">移除</button>
            ${dbBadgeHtml(f)}
          </div>
        </div>
      `).join('');
      if(!isExpanded && files.length > GROUP_INITIAL_SHOW){
        html += `<button class="show-more-btn" data-label="${escapeHtml(label)}">顯示全部（還有 ${files.length - GROUP_INITIAL_SHOW} 筆）</button>`;
      }
    }
  });
  list.innerHTML = html;
}
// 事件代理：整個檔案清單只綁一次點擊監聽器，不用每次重繪都重新對每個按鈕綁一次
// （檔案數量一多，重複綁定/解綁事件監聽器本身就是明顯的效能負擔）
document.getElementById('filesList').addEventListener('click', (e) => {
  const jsonBtn = e.target.closest('.file-json-btn');
  if(jsonBtn){ e.stopPropagation(); openJsonModal(jsonBtn.dataset.id); return; }
  const removeBtn = e.target.closest('.file-remove-btn');
  if(removeBtn){ e.stopPropagation(); removeFromHistory(removeBtn.dataset.id); return; }
  const showMoreBtn = e.target.closest('.show-more-btn');
  if(showMoreBtn){ e.stopPropagation(); expandedGroups.add(showMoreBtn.dataset.label); renderFilesList(); return; }
  const groupLabel = e.target.closest('.file-group-label');
  if(groupLabel){
    const label = groupLabel.dataset.collapseLabel;
    if(openGroups.has(label)) openGroups.delete(label);
    else openGroups.add(label);
    renderFilesList();
  }
});
async function removeFromHistory(id){
  try{
    const res = await workerCall({ type:'remove', id });
    fileMeta = fileMeta.filter(f => f.id !== id);
    cachedColumns = res.columns;
    refreshCompareFieldOptions();
    refreshMainSlotDisplay();
    document.getElementById('results').classList.remove('show');
    checkReady();
    renderFilesList();
    if(res.dbDeleteError) showSingleError('已從瀏覽器移除，但資料庫刪除失敗：' + res.dbDeleteError);
    else clearSingleError();
  } catch(err){ showSingleError('移除檔案時發生錯誤：' + err.message); }
}
const JSON_PREVIEW_LIMIT = 500;
const jsonModalOverlay = document.getElementById('jsonModalOverlay');
const jsonModalTitle = document.getElementById('jsonModalTitle');
const jsonModalMeta = document.getElementById('jsonModalMeta');
const jsonModalBody = document.getElementById('jsonModalBody');
const jsonModalDownload = document.getElementById('jsonModalDownload');
let currentJsonFile = null;
async function openJsonModal(id){
  jsonModalTitle.textContent = '讀取中…';
  jsonModalMeta.textContent = '';
  jsonModalBody.textContent = '';
  jsonModalOverlay.classList.add('show');
  try{
    const res = await workerCall({ type:'get-file-data', id });
    currentJsonFile = { name: res.name, rows: res.rows };
    jsonModalTitle.textContent = res.name;
    const shown = res.rows.length > JSON_PREVIEW_LIMIT ? res.rows.slice(0, JSON_PREVIEW_LIMIT) : res.rows;
    jsonModalMeta.textContent = res.rows.length > JSON_PREVIEW_LIMIT
      ? `共 ${res.rows.length} 列，畫面上僅預覽前 ${JSON_PREVIEW_LIMIT} 列，完整內容請用右上角下載`
      : `共 ${res.rows.length} 列`;
    jsonModalBody.textContent = JSON.stringify(shown, null, 2);
  } catch(err){
    jsonModalTitle.textContent = '讀取失敗';
    jsonModalBody.textContent = err.message;
    currentJsonFile = null;
  }
}
function closeJsonModal(){
  jsonModalOverlay.classList.remove('show');
  currentJsonFile = null;
}
document.getElementById('jsonModalClose').addEventListener('click', closeJsonModal);
jsonModalOverlay.addEventListener('click', (e) => { if(e.target === jsonModalOverlay) closeJsonModal(); });
document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && jsonModalOverlay.classList.contains('show')) closeJsonModal(); });
jsonModalDownload.addEventListener('click', () => {
  if(!currentJsonFile) return;
  const jsonText = JSON.stringify(currentJsonFile.rows, null, 2);
  const blob = new Blob([jsonText], { type:'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentJsonFile.name.replace(/\.(xlsx|xls|csv)$/i, '') + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});
let resultsCtx = null;
const PAGE_SIZE = 200;
let currentList = [];
let currentPage = 1;
function openResults(){ document.getElementById('results').classList.add('show'); }
function setGauge(countHtml, pct, statHtml){
  document.getElementById('gaugeCount').innerHTML = countHtml;
  document.getElementById('gaugeFill').style.width = pct + '%';
  document.getElementById('statRow').innerHTML = statHtml;
}
function paintTable(headHtml, list){
  document.getElementById('tableHead').innerHTML = headHtml;
  currentList = list;
  currentPage = 1;
  renderCurrentPage();
}
function renderCurrentPage(){
  const table = document.getElementById('resultTable');
  const emptyState = document.getElementById('emptyState');
  const pagination = document.getElementById('pagination');
  if(!currentList.length){
    table.style.display = 'none';
    emptyState.style.display = 'block';
    pagination.style.display = 'none';
    document.getElementById('tableBody').innerHTML = '';
    return;
  }
  table.style.display = 'table';
  emptyState.style.display = 'none';
  const totalPages = Math.max(1, Math.ceil(currentList.length / PAGE_SIZE));
  if(currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageSlice = currentList.slice(start, start + PAGE_SIZE);
  resultsCtx.renderRows(pageSlice);
  if(totalPages > 1){
    pagination.style.display = 'flex';
    document.getElementById('pageInfo').textContent =
      `第 ${currentPage} / ${totalPages} 頁（共 ${currentList.length} 筆，每頁顯示 ${PAGE_SIZE} 筆）`;
    document.getElementById('pagePrev').disabled = currentPage <= 1;
    document.getElementById('pageNext').disabled = currentPage >= totalPages;
  } else {
    pagination.style.display = 'none';
  }
}
document.getElementById('pagePrev').addEventListener('click', () => {
  if(currentPage > 1){ currentPage--; renderCurrentPage(); }
});
document.getElementById('pageNext').addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(currentList.length / PAGE_SIZE));
  if(currentPage < totalPages){ currentPage++; renderCurrentPage(); }
});
let searchDebounceTimer = null;
document.getElementById('searchBox').addEventListener('input', (e) => {
  if(!resultsCtx) return;
  const q = e.target.value.trim().toLowerCase();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentList = q ? resultsCtx.dataset.filter(item => resultsCtx.matchQuery(item, q)) : resultsCtx.dataset;
    currentPage = 1;
    renderCurrentPage();
  }, 200);
});
document.getElementById('exportBtn').addEventListener('click', () => {
  if(!resultsCtx || !resultsCtx.dataset.length) return;
  const lines = [resultsCtx.exportHeader.map(h => `"${h.replace(/"/g,'""')}"`).join(',')];
  resultsCtx.dataset.forEach(item => {
    const row = resultsCtx.exportRow(item).map(v => `"${String(v ?? '').replace(/"/g,'""')}"`);
    lines.push(row.join(','));
  });
  const csv = '﻿' + lines.join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '重複項目.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});
document.getElementById('runBtnS').addEventListener('click', async () => {
  clearSingleError();
  if(!fileMeta.length){ showSingleError('請先上傳至少一個檔案'); return; }
  const compareCols = Array.from(document.querySelectorAll('.compare-field-select')).map(s => s.value);
  if(!compareCols.length || compareCols.some(c => !c)){ showSingleError('請先選擇所有比對欄位'); return; }
  const ignoreCase = document.getElementById('ignoreCaseS').checked;
  const ignoreSpace = document.getElementById('ignoreSpaceS').checked;
  const compareMode = document.querySelector('input[name="compareMode"]:checked').value;
  if((compareMode === 'horizontal' || compareMode === 'both') && compareCols.length < 2){
    showSingleError('橫排比對需要至少選擇 2 個比對欄位（用來比較同一列中欄位彼此是否相同）');
    return;
  }
  const runBtn = document.getElementById('runBtnS');
  const originalBtnText = runBtn.textContent;
  runBtn.disabled = true;
  runBtn.textContent = '運算中…';
  try{
    const res = await workerCall({ type:'compare', compareCols, compareMode, ignoreCase, ignoreSpace });
    const { flat, groupCount, totalRows, fileCount, cols } = res;
    const distinctRows = new Set(flat.map(item => item.row));
    const distinctCount = distinctRows.size;
    const pct = totalRows ? Math.round((distinctCount/totalRows)*100) : 0;
    const modeLabel = { horizontal:'橫排比對', vertical:'直排比對', both:'橫排＋直排' }[compareMode];
    setGauge(distinctCount + ' <span>筆列有重複</span>', pct, `
      <div class="stat">涵蓋檔案 <b>${fileCount}</b> 個</div>
      <div class="stat">總列數 <b>${totalRows}</b></div>
      <div class="stat">比對方向 <b>${modeLabel}</b></div>
      <div class="stat">重複值組數 <b>${groupCount}</b></div>
      <div class="stat">重複列比例 <b>${pct}%</b></div>`);
    let headHtml = '<th class="srcfile">來源檔案</th><th class="key">重複欄位</th>';
    cols.forEach(c => {
      const isCompare = compareCols.includes(c);
      const cls = isCompare ? 'cmp' : '';
      headHtml += `<th class="${cls}">${escapeHtml(c)}</th>`;
    });
    // 預先幫每一列算好搜尋用的字串（只算一次），之後打字搜尋時只要直接比對現成的字串，
    // 不用每次都重新把整列組成字串再轉小寫，這是列數一多會卡的主因
    flat.forEach(item => {
      item._searchHay = [item.file, item.label, ...cols.map(c => item.row[c])].join(' ').toLowerCase();
    });
    resultsCtx = {
      dataset: flat,
      renderRows(list){
        document.getElementById('tableBody').innerHTML = list.map(item => {
          const modeTag = item.mode === 'horizontal' ? '橫' : '直';
          let row = `<tr class="${item.groupIndex%2===1?'group-alt':''}"><td class="srcfile">${escapeHtml(item.file)}</td><td class="hitfield mode-${item.mode}">[${modeTag}] ${escapeHtml(item.label)}</td>`;
          cols.forEach(c => {
            const cls = item.matchedFields.includes(c) ? 'key' : '';
            row += `<td class="${cls}">${escapeHtml(item.row[c] ?? '')}</td>`;
          });
          row += '</tr>';
          return row;
        }).join('');
      },
      matchQuery(item, q){
        return item._searchHay.includes(q);
      },
      exportHeader: ['來源檔案', '比對方向', '重複欄位', ...cols],
      exportRow(item){ return [item.file, item.mode==='horizontal'?'橫排':'直排', item.label, ...cols.map(c=>item.row[c] ?? '')]; }
    };
    document.getElementById('searchBox').value = '';
    openResults();
    paintTable(headHtml, flat);
  } catch(err){
    showSingleError('比對時發生錯誤：' + err.message);
  } finally {
    runBtn.textContent = originalBtnText;
    checkReady();
  }
});
document.getElementById('clearAllFilesBtn').addEventListener('click', async () => {
  if(!fileMeta.length) return;
  if(!confirm('確定要清空全部已上傳的檔案紀錄嗎？這個動作無法復原（不含資料庫裡的資料，只清瀏覽器本機）。')) return;
  try{
    await workerCall({ type:'clear-all' });
    fileMeta = [];
    cachedColumns = [];
    expandedGroups.clear();
    openGroups.clear();
    refreshCompareFieldOptions();
    refreshMainSlotDisplay();
    compareCountInput.value = 1;
    syncCompareFields(1);
    document.getElementById('results').classList.remove('show');
    checkReady();
    renderFilesList();
  } catch(err){ showSingleError('清空時發生錯誤：' + err.message); }
});
async function syncAllUnsyncedFiles(){
  const targets = fileMeta.filter(f => f.dbStatus !== 'ok');
  if(!targets.length) return;
  const btn = document.getElementById('syncAllBtn');
  const original = btn.textContent;
  btn.disabled = true;
  const dbErrors = [];
  let lastRenderAt = 0;
  for(let i = 0; i < targets.length; i++){
    btn.textContent = `自動同步中…（${i + 1} / ${targets.length}）`;
    try{
      const res = await workerCall({ type:'sync-to-db', id: targets[i].id });
      const idx = fileMeta.findIndex(f => f.id === res.file.id);
      if(idx !== -1) fileMeta[idx] = res.file;
      if(res.file.dbStatus === 'bad') dbErrors.push(`${res.file.name}：${res.file.dbError}`);
    } catch(err){
      dbErrors.push(`${targets[i].name}：${err.message}`);
    }
    // 節流：批次同步很多檔案時，不用每一筆都整個重繪清單，避免畫面一直閃爍卡頓，
    // 最後一筆一定重繪，確保結果一定會顯示出來
    const now = Date.now();
    if(now - lastRenderAt > 400 || i === targets.length - 1){
      renderFilesList();
      lastRenderAt = now;
    }
  }
  btn.disabled = false;
  btn.textContent = original;
  if(dbErrors.length) showSingleError(`${dbErrors.length} 個檔案同步失敗：\n` + dbErrors.join('\n'));
  else clearSingleError();
}
document.getElementById('syncAllBtn').addEventListener('click', syncAllUnsyncedFiles);
(async function init(){
  document.getElementById('filesList').innerHTML = '<div class="files-empty">正在讀取先前的紀錄與資料庫…</div>';
  let connected = false;
  try{
    const res = await workerCall({ type:'init' });
    fileMeta = res.files;
    cachedColumns = res.columns;
    refreshCompareFieldOptions();
    refreshMainSlotDisplay();
    checkReady();
    renderFilesList();
    // 撈檔案清單這次呼叫本身就順便驗證了連線，不用再額外打一次獨立的連線測試
    connected = !!res.connectionOk;
    setStatusBar(connected ? 'ok' : 'bad', connected ? '資料庫連線成功' : '資料庫連線失敗');
  } catch(err){
    showSingleError('初始化背景執行緒失敗，請確認瀏覽器支援 Web Worker：' + err.message);
    renderFilesList();
  }
  if(connected) syncAllUnsyncedFiles();
})();