// 出貨資料比對系統 - 後端 API
// 連線用本機/公司內部的 MySQL，設定寫在同資料夾的 .env 檔案裡
// （複製 .env.example 改名成 .env，填入實際連線資訊）

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' })); // 出貨資料量大，放寬上傳大小限制

const mysql = require('mysql2/promise');
require('dotenv').config();

// 檢查必要的環境變數是否存在，缺少就直接停止，不要用空字串矇混過去
const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  throw new Error(`缺少必要的環境變數：${missing.join(', ')}，請確認 .env 檔案已正確設定`);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60000,
});

// 9 個不能重複的唯一碼欄位
const UNIQUE_FIELDS = [
  'imei1', 'serial_no', 'mac_id', 'battery_sn', 'pcba_sn',
  'lcd_sn', 'iccid', 'pcb_main_board_sn', 'sim_unlock_code',
];

// Excel 全部 57 欄（A~BE）的對應表：前端送來的駝峰命名 -> 資料庫欄位名（snake_case）
// 順序照 Excel 欄位順序排列，方便對照
const FIELD_MAP = [
  ['poNo', 'po_no'],                                   // A
  ['referenceId', 'reference_id'],                     // B
  ['soNoContainerNo', 'so_no_container_no'],           // C
  ['vessel', 'vessel'],                                // D
  ['itemModel', 'item_model'],                         // E
  ['brand', 'brand'],                                  // F
  ['palletNo', 'pallet_no'],                           // G
  ['color', 'color'],                                  // H
  ['imei1', 'imei1'],                                  // I  ★唯一碼
  ['imei2', 'imei2'],                                  // J
  ['carton', 'carton'],                                // K
  ['sim', 'sim'],                                      // L
  ['serialNo', 'serial_no'],                           // M  ★唯一碼
  ['macId', 'mac_id'],                                 // N  ★唯一碼
  ['bluetoothId', 'bluetooth_id'],                     // O
  ['batterySn', 'battery_sn'],                         // P  ★唯一碼
  ['buildNo', 'build_no'],                             // Q
  ['simPreinstalled', 'sim_preinstalled'],             // R
  ['apnLoaded', 'apn_loaded'],                         // S
  ['enrolled', 'enrolled'],                            // T
  ['remark', 'remark'],                                // U
  ['accessories', 'accessories'],                      // V
  ['housing', 'housing'],                              // W
  ['screen', 'screen'],                                // X
  ['screenSupplier', 'screen_supplier'],               // Y
  ['memoryComments', 'memory_comments'],               // Z
  ['vibratorSupplier', 'vibrator_supplier'],           // AA
  ['lightProximitySensor', 'light_proximity_sensor'],  // AB
  ['byFactory', 'by_factory'],                         // AC
  ['assemblyLine', 'assembly_line'],                   // AD
  ['manufacturedDate', 'manufactured_date'],           // AE
  ['eid', 'eid'],                                      // AF
  ['internalVersion', 'internal_version'],             // AG
  ['oemUnlockCode', 'oem_unlock_code'],                // AH
  ['skuItemNo', 'sku_item_no'],                        // AI
  ['pcbaSn', 'pcba_sn'],                               // AJ ★唯一碼
  ['lcdSn', 'lcd_sn'],                                 // AK ★唯一碼
  ['mamboDeviceId', 'mambo_device_id'],                // AL
  ['bluetoothMac2', 'bluetooth_mac_2'],                // AM
  ['iccid', 'iccid'],                                  // AN ★唯一碼
  ['rfidEpcMemoryBrand', 'rfid_epc_memory_brand'],     // AO
  ['rfidAndroidSn', 'rfid_android_sn'],                // AP
  ['batteryManufactureDate', 'battery_manufacture_date'], // AQ
  ['isim', 'isim'],                                    // AR
  ['cameraIndicator', 'camera_indicator'],             // AS
  ['wifi5g', 'wifi_5g'],                               // AT
  ['guestWifi', 'guest_wifi'],                         // AU
  ['btMacMainBoard', 'bt_mac_main_board'],             // AV
  ['btMacDaughterBoard', 'bt_mac_daughter_board'],     // AW
  ['rfidBrand', 'rfid_brand'],                         // AX
  ['rfidTid', 'rfid_tid'],                             // AY
  ['pcbMainBoardSn', 'pcb_main_board_sn'],             // AZ ★唯一碼
  ['blePcbSerialNo', 'ble_pcb_serial_no'],             // BA
  ['unitRemarks', 'unit_remarks'],                     // BB
  ['esimIccid', 'esim_iccid'],                         // BC
  ['imsi', 'imsi'],                                    // BD
  ['simUnlockCode', 'sim_unlock_code'],                // BE ★唯一碼
];

function genId(){
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- 健康檢查 ----------
app.get('/api/health', async (req, res) => {
  try{
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch(err){
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- 上傳一份檔案（一個 Excel 分頁）的資料 ----------
// body: { sourceFileName, sheetName, model, rows: [{ poNo, referenceId, ..., simUnlockCode, fullRow: {...} }] }
app.post('/api/files', async (req, res) => {
  const { sourceFileName, sheetName, model, rows } = req.body || {};
  if(!sourceFileName || !sheetName || !Array.isArray(rows)){
    return res.status(400).json({ error: '缺少必要欄位：sourceFileName、sheetName、rows' });
  }

  const id = genId();
  const columnNames = ['file_id', 'row_index', ...FIELD_MAP.map(([, col]) => col), 'full_row'];
  const placeholders = columnNames.map(() => '?').join(', ');

  const conn = await pool.getConnection();
  try{
    await conn.beginTransaction();

    await conn.query(
      'INSERT INTO shipment_files (id, source_file_name, sheet_name, model, row_count) VALUES (?, ?, ?, ?, ?)',
      [id, sourceFileName, sheetName, model || null, rows.length]
    );

    const BATCH_SIZE = 300; // 57 欄位較寬，每批數量略降避免單一封包過大
    for(let i = 0; i < rows.length; i += BATCH_SIZE){
      const batch = rows.slice(i, i + BATCH_SIZE);
      const values = batch.map((row, idx) => {
        const fieldValues = FIELD_MAP.map(([camelKey]) => row[camelKey] ?? null);
        return [id, i + idx, ...fieldValues, JSON.stringify(row.fullRow ?? row)];
      });
      await conn.query(
        `INSERT INTO shipment_records (${columnNames.join(', ')}) VALUES ?`,
        [values]
      );
    }

    await conn.commit();
    res.json({ id, rowCount: rows.length });
  } catch(err){
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ---------- 已上傳檔案清單 ----------
app.get('/api/files', async (req, res) => {
  try{
    const [rows] = await pool.query(
      'SELECT id, source_file_name, sheet_name, model, row_count, uploaded_at FROM shipment_files ORDER BY uploaded_at ASC'
    );
    res.json({ files: rows });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

// ---------- 單一檔案的完整資料（給「查看 JSON」用） ----------
app.get('/api/files/:id/data', async (req, res) => {
  try{
    const [[file]] = await pool.query('SELECT * FROM shipment_files WHERE id = ?', [req.params.id]);
    if(!file) return res.status(404).json({ error: '找不到這個檔案' });
    const [rows] = await pool.query(
      'SELECT row_index, full_row FROM shipment_records WHERE file_id = ? ORDER BY row_index ASC',
      [req.params.id]
    );
    res.json({ file, rows: rows.map(r => r.full_row) });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

// ---------- 刪除一個檔案（連同底下的資料列） ----------
app.delete('/api/files/:id', async (req, res) => {
  try{
    await pool.query('DELETE FROM shipment_files WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

// ---------- 清空全部 ----------
app.delete('/api/files', async (req, res) => {
  try{
    await pool.query('DELETE FROM shipment_files');
    res.json({ ok: true });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

// ---------- 重複比對：對 9 個唯一碼欄位，找出資料庫裡「目前所有已存資料」中重複的值 ----------
// 這樣新上傳的資料只要進了資料庫，就會自動跟歷史上傳過的所有資料一起比對
app.post('/api/compare', async (req, res) => {
  try{
    const results = [];
    for(const field of UNIQUE_FIELDS){
      const [dupGroups] = await pool.query(
        `SELECT ${field} AS val, COUNT(*) AS cnt
         FROM shipment_records
         WHERE ${field} IS NOT NULL AND ${field} <> ''
         GROUP BY ${field}
         HAVING cnt > 1`
      );
      if(!dupGroups.length) continue;

      const values = dupGroups.map(d => d.val);
      const [rows] = await pool.query(
        `SELECT sr.id, sr.file_id, sr.row_index, sr.${field} AS matched_value, sr.full_row,
                sf.source_file_name, sf.sheet_name, sf.model, sf.uploaded_at
         FROM shipment_records sr
         JOIN shipment_files sf ON sr.file_id = sf.id
         WHERE sr.${field} IN (?)
         ORDER BY sr.${field}`,
        [values]
      );
      results.push({ field, duplicateValueCount: dupGroups.length, rows });
    }

    const totalDuplicateRows = results.reduce((sum, r) => sum + r.rows.length, 0);
    res.json({ results, totalDuplicateRows });
  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 統計：依機種 / 依來源檔案彙總出貨量 ----------
app.get('/api/stats', async (req, res) => {
  try{
    const [byModel] = await pool.query(
      `SELECT item_model, COUNT(*) AS qty
       FROM shipment_records
       WHERE item_model IS NOT NULL AND item_model <> ''
       GROUP BY item_model ORDER BY qty DESC`
    );
    const [byFile] = await pool.query(
      `SELECT source_file_name, sheet_name, model, row_count, uploaded_at
       FROM shipment_files ORDER BY uploaded_at ASC`
    );
    res.json({ byModel, byFile });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});