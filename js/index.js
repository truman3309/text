  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }
  const WORKER_SRC = String.raw`
    // 修正：0.18.5 有 CVE-2023-30533 / CVE-2024-22363，優先載入自架 0.20.3；vendor/ 還沒放檔案時退回原本版本，功能不受影響
    try{ importScripts('__XLSX_URL__'); } catch(e){ console.warn('vendor/xlsx.full.min.js 不存在，暫時使用舊版 SheetJS 0.18.5（有已知漏洞）'); importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); }
    // ---- IndexedDB 資料庫設定 ----
    // DB_NAME / DB_VERSION：本機瀏覽器端 IndexedDB 的資料庫名稱與版本號。
    // OLD_STORE_NAME：舊版（v1）使用的單一 store 名稱，用於升級時搬移資料。
    // META_STORE：存放每個檔案的「中繼資料」（檔名、欄位、機型、列數...等，不含實際列資料）。
    // DATA_STORE：存放每個檔案的「實際列資料」（rows），與 META_STORE 用同一個 id 對應。
    // 這樣拆成兩個 store 是為了讓「只需要檔案清單」的操作（如畫面列表）不用把整份大資料都讀出來。
    
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

  
    let API_BASE = null;

    async function dbCall(op, params){
      const res = await fetch(API_BASE + '/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ op }, params || {})),
      });
      const out = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(out.error || ('HTTP ' + res.status));
      return out.data;
    }


   
    function genDbId(){
      return Date.now().toString(36) + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }

    
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
    async function uploadFileToStorage(fileId, fileName, bytes){
      const path = fileId + '/' + encodeURIComponent(fileName);
      try{
        const res = await fetch(API_BASE + '/api/storage?path=' + encodeURIComponent(path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        if(!res.ok){
          const errData = await res.json().catch(() => ({}));
          return { ok:false, error: errData.error || res.statusText };
        }
        return { ok:true, path };
      } catch(err){
        return { ok:false, error: err.message };
      }
    }

    async function deleteFromDatabase(dbFileId, storagePath, sourceFileName){
      const errors = [];
      if(dbFileId){
        try{ await dbCall('deleteFile', { fileId: dbFileId }); }
        catch(err){ errors.push('資料表：' + err.message); }
      } else if(sourceFileName){
        try{ await dbCall('deleteFileByName', { name: sourceFileName }); }
        catch(err){ errors.push('資料表（依檔名比對）：' + err.message); }
      }
      if(storagePath){
        try{ await dbCall('deleteStorage', { path: storagePath }); }
        catch(err){ errors.push('Storage：' + err.message); }
      }
      return errors.length ? { ok:false, error: errors.join('；') } : { ok:true };
    }

   
    async function saveToDatabase(sourceFileName, sheetName, model, dbRecords, storagePath, fileId){
      if(!dbRecords.length) return { attempted:false };
      fileId = fileId || genDbId();
      try{
        await dbCall('createFile', { file: {
          id: fileId, source_file_name: sourceFileName, sheet_name: sheetName,
          model: model || null, row_count: dbRecords.length, storage_path: storagePath || null,
        }});
      } catch(err){
        return { attempted:true, ok:false, error: err.message };
      }

      const BATCH_SIZE = 500;
      for(let i = 0; i < dbRecords.length; i += BATCH_SIZE){
        const batch = dbRecords.slice(i, i + BATCH_SIZE).map((rec, idx) => Object.assign(
          { file_id: fileId, row_index: i + idx, full_row: toCsvRow(rec) },
          toSnakeCaseFields(rec)
        ));
        try{
          await dbCall('insertRecords', { records: batch });
        } catch(err){
          await dbCall('deleteFile', { fileId }).catch(() => {});
          return { attempted:true, ok:false, error: err.message };
        }
      }
      return { attempted:true, ok:true, rowCount: dbRecords.length, fileId };
    }

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
      'BT MAC \u2013 Main Board':'btMacMainBoard', 'BT MAC \u2013 Daughter Board':'btMacDaughterBoard',
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

     
    const CAMEL_TO_HEADER = {};
    Object.keys(HEADER_NAME_MAP).forEach(header => { CAMEL_TO_HEADER[HEADER_NAME_MAP[header]] = header; });
    const HEADERS_IN_DB_ORDER = DB_COLUMN_MAP.map(([, camelKey]) => CAMEL_TO_HEADER[camelKey] || camelKey);

   
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

   
    async function fetchRemoteFilesList(){
      try{
        return { ok:true, files: await dbCall('listFiles', { limit: 1000 }) };
      } catch(err){ return { ok:false, files: [] }; }
    }
    
    async function fetchRemoteFileRows(dbFileId){
      try{
        const data = await dbCall('getFileRows', { fileId: dbFileId });
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

      // config 一定是第一則訊息，且不需要 reqId 對應的回覆，收到就設定完立刻 return
      if(msg.type === 'set-config'){
        API_BASE = msg.apiBase;
        return;
      }

      try{
        if(msg.type === 'init'){
          const metas = await dbLoadAllMeta();
          metas.sort((a,b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
          metas.forEach(m => store.set(m.id, { ...m, rows: null }));

          const remoteResult = await fetchRemoteFilesList();
          const localDbFileIds = new Set([...store.values()].map(e => e.dbFileId).filter(Boolean));
          const localNames = new Set([...store.values()].map(e => e.name));
          remoteResult.files.forEach(rf => {
            if(localDbFileIds.has(rf.id) || localNames.has(rf.source_file_name)) return;
            const remoteId = 'remote-' + rf.id;
            store.set(remoteId, {
              id: remoteId, name: rf.source_file_name, sheetName: rf.sheet_name, columns: HEADERS_IN_DB_ORDER,
              model: rf.model, rowCount: rf.row_count, uploadedAt: rf.uploaded_at, rows: null,
              dbStatus: 'ok', dbError: null, storagePath: rf.storage_path || null, dbFileId: rf.id,
              remote: true,
            });
          });

          self.postMessage({ type:'init-ok', reqId: msg.reqId, files: [...store.values()].map(fileMetaOf), columns: allColumns(), connectionOk: remoteResult.ok });

        } else if(msg.type === 'parse'){
          try{
            const data = new Uint8Array(msg.buffer);
            const wb = XLSX.read(data, { type:'array' });
            const sheetName = wb.SheetNames[0];
            const sheet = wb.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
            if(!rows.length) throw new Error('檔案內沒有可讀取的資料列');
            const columns = Object.keys(rows[0]).filter(c => !/^__EMPTY(_\d+)?$/.test(c));
            const model = detectItemModel(columns, rows);
            const id = Date.now() + '-' + Math.random().toString(36).slice(2,7) + '-' + store.size;
            const uploadedAt = new Date().toISOString();
            const entry = { id, name: msg.name, sheetName, columns, model, rowCount: rows.length, uploadedAt, rows };

            const dbFileId = genDbId();
            const uploadResult = await uploadFileToStorage(dbFileId, msg.name, data);
            entry.storagePath = uploadResult.ok ? uploadResult.path : null;
            entry.storageError = uploadResult.ok ? null : uploadResult.error;

            const dbRecords = buildDbRecords(sheet);
            if(!dbRecords.length){
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

        } else if(msg.type === 'test-api'){
          try{
            await dbCall('ping');
            self.postMessage({ type:'test-api-ok', reqId: msg.reqId, ok:true, error:null });
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

  function createWorker(){
    const xlsxUrl = new URL('vendor/xlsx.full.min.js', location.href).href;
    const blob = new Blob([WORKER_SRC.replace('__XLSX_URL__', xlsxUrl)], { type: 'application/javascript' });
    const w = new Worker(URL.createObjectURL(blob));
    w.onmessage = (e) => {
      const msg = e.data;
      const p = pending.get(msg.reqId);
      if(!p) return;
      pending.delete(msg.reqId);
      if(msg.type && (msg.type.endsWith('-err') || msg.type === 'error')) p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    w.onerror = (e) => {
      pending.forEach(p => p.reject(new Error('背景執行緒發生錯誤：' + e.message)));
      pending.clear();
    };
    return w;
  }
 
  async function getWorker(){
    if(!worker){
      worker = createWorker();
      
      worker.postMessage({ type:'set-config', apiBase: location.origin });
    }
    return worker;
  }


  function workerCall(payload, transfer){
    return new Promise((resolve, reject) => {
      getWorker().then(w => {
        const reqId = ++reqCounter;
        pending.set(reqId, { resolve, reject });
        w.postMessage({ ...payload, reqId }, transfer || []);
      }).catch(reject);
    });
  }

  // ================= 資料庫連線狀態 =================
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

   // ================= 主執行緒狀態 =================
  let fileMeta = [];
  let cachedColumns = [];
  const expandedGroups = new Set();
  const openGroups = new Set();
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
    sel.dataset.index = index;
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
  

  const DEFAULT_COMPARE_FIELDS = [
    'IMEI1', 'Serial No.', 'MAC ID', 'Battery SN', 'PCBA SN',
    'LCD SN', 'ICCID', 'PCB Main Board Serial No.', 'SIM Unlock Code',
  ];

  function refreshCompareFieldOptions(){
    compareFieldsList.querySelectorAll('.compare-field-select').forEach(sel => {
      const prev = sel.value;
      const wasUninitialized = sel.disabled;
      if(cachedColumns.length){
        sel.disabled = false;
        sel.innerHTML = cachedColumns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        const defaultField = DEFAULT_COMPARE_FIELDS[parseInt(sel.dataset.index, 10)];
        if(cachedColumns.includes(prev)){
          sel.value = prev;
        } else if(wasUninitialized && defaultField && cachedColumns.includes(defaultField)){
          sel.value = defaultField;
        }
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

  syncCompareFields(9);

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
    const syncAllBtn = document.getElementById('syncAllBtn');
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
          <div class="file-item" data-id="${escapeHtml(f.id)}">
            <div class="file-item-main">
              <div class="file-item-name">${escapeHtml(f.name)}</div>
              <div class="file-item-meta">${escapeHtml(f.rowCount)} 列・${escapeHtml(f.columnCount)} 欄</div>
            </div>
            <div class="file-item-actions">
              <button class="file-json-btn" data-id="${escapeHtml(f.id)}">查看 JSON</button>
              <button class="file-remove-btn" data-id="${escapeHtml(f.id)}">移除</button>
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
  
  // ================= 比對結果「在結果中搜尋」的開關 =================
  // true  = 開啟搜尋功能
  // false = 關閉搜尋功能（搜尋框仍然顯示在畫面上，但無法輸入，也不會篩選結果）
  const RESULT_SEARCH_ENABLED = false;
 
  if(!RESULT_SEARCH_ENABLED){
    const box = document.getElementById('searchBox');
    box.disabled = true;
    box.title = '搜尋功能目前已關閉';
    box.placeholder = '目前搜尋功能關閉';
  }
  let searchDebounceTimer = null;
  document.getElementById('searchBox').addEventListener('input', (e) => {
    if(!RESULT_SEARCH_ENABLED) return;
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
    const csvCell = (v) => { let s = String(v ?? ''); if(/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s; return '"' + s.replace(/"/g,'""') + '"'; };
    const lines = [resultsCtx.exportHeader.map(csvCell).join(',')];
    resultsCtx.dataset.forEach(item => {
      const row = resultsCtx.exportRow(item).map(csvCell);
      lines.push(row.join(','));
    });
    const csv = '\uFEFF' + lines.join('\n');
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
      connected = !!res.connectionOk;
      setStatusBar(connected ? 'ok' : 'bad', connected ? '資料庫連線成功' : '資料庫連線失敗');
    } catch(err){
      showSingleError('初始化背景執行緒失敗，請確認瀏覽器支援 Web Worker：' + err.message);
      renderFilesList();
    }
    if(connected) syncAllUnsyncedFiles();
  })();
