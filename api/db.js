// ============================================================
// 資料庫轉送 API：瀏覽器 → /api/db（Vercel）→ Supabase
// 金鑰（SUPABASE_SERVICE_ROLE_KEY）只存在 Vercel 環境變數，永遠不會送到瀏覽器。
// 這裡不是「什麼都轉送」，而是只開放網頁實際用到的操作，參數也逐一檢查：
//   - 不能清空全部資料、不能 UPDATE、不能任意下 SQL / 任意查詢
//   - 欄位名稱只能是白名單內的，搜尋字串只能是英數字和 ( ) &（& 最多一個）
// 使用方式：POST /api/db  body: { "op": "操作名稱", ...參數 }
// ============================================================
import { handlePreflight } from './_cors.js';
import { isValidStoragePath } from './_validate.js';
import { allow, OP_CATEGORY } from './_ratelimit.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SECRET_KEY;

// ---------- 白名單 ----------
// shipment_records 可寫入的欄位（Excel A~BE 57 欄 + file_id/row_index/full_row）
const RECORD_COLUMNS = new Set([
  'file_id', 'row_index', 'full_row',
  'po_no', 'reference_id', 'so_no_container_no', 'vessel', 'item_model', 'brand', 'pallet_no', 'color',
  'imei1', 'imei2', 'carton', 'sim', 'serial_no', 'mac_id', 'bluetooth_id', 'battery_sn',
  'build_no', 'sim_preinstalled', 'apn_loaded', 'enrolled', 'remark', 'accessories', 'housing', 'screen',
  'screen_supplier', 'memory_comments', 'vibrator_supplier', 'light_proximity_sensor', 'by_factory',
  'assembly_line', 'manufactured_date', 'eid', 'internal_version', 'oem_unlock_code', 'sku_item_no',
  'pcba_sn', 'lcd_sn', 'mambo_device_id', 'bluetooth_mac_2', 'iccid', 'rfid_epc_memory_brand',
  'rfid_android_sn', 'battery_manufacture_date', 'isim', 'camera_indicator', 'wifi_5g', 'guest_wifi',
  'bt_mac_main_board', 'bt_mac_daughter_board', 'rfid_brand', 'rfid_tid', 'pcb_main_board_sn',
  'ble_pcb_serial_no', 'unit_remarks', 'esim_iccid', 'imsi', 'sim_unlock_code',
]);
// 搜尋頁可以查的欄位（跟 search.js 的 SEARCH_FIELDS 一致）
const SEARCH_FIELDS = new Set([
  'imei1', 'serial_no', 'mac_id', 'battery_sn', 'pcba_sn', 'lcd_sn', 'iccid',
  'pcb_main_board_sn', 'sim_unlock_code', 'item_model', 'po_no', 'reference_id',
]);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEARCH_RE = /^[A-Za-z0-9()&]+$/;

class BadRequest extends Error {}
const bad = (msg) => { throw new BadRequest(msg); };

function str(v, max, name){
  if(v === null || v === undefined) return null;
  if(typeof v !== 'string' && typeof v !== 'number') bad(`${name} 格式錯誤`);
  const s = String(v);
  if(s.length > max) bad(`${name} 太長`);
  return s;
}
function checkId(v, name = 'id'){
  if(typeof v !== 'string' || !ID_RE.test(v)) bad(`${name} 格式錯誤`);
  return v;
}
function checkSearch(v, maxLen, name = '搜尋內容', minLen = 1){
  if(typeof v !== 'string') bad(`${name} 格式錯誤`);
  const s = v.trim();
  if(s.length < minLen || s.length > maxLen) bad(`${name} 長度必須在 ${minLen}～${maxLen} 個字元`);
  if(!SEARCH_RE.test(s)) bad(`${name} 只能包含英文字母、數字和 ( ) &`);
  if((s.match(/&/g) || []).length > 1) bad(`${name} 的 & 最多只能出現一個`);
  return s;
}
function intIn(v, min, max, def){
  if(v === undefined || v === null) return def;
  const n = Number(v);
  if(!Number.isInteger(n) || n < min || n > max) bad('數字參數超出範圍');
  return n;
}
const enc = encodeURIComponent;

// ---------- 呼叫 Supabase REST（只在伺服器端執行）----------
async function rest(method, pathAndQuery, body, prefer){
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };
  if(prefer) headers.Prefer = prefer;
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + pathAndQuery, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if(!res.ok){
    console.error('[supabase]', method, pathAndQuery.split('?')[0], res.status, text.slice(0, 300));
    throw new Error('資料庫操作失敗');
  }
  return text ? JSON.parse(text) : null;
}

// ---------- 每一個允許的操作 ----------
const OPS = {
  // 連線測試
  async ping(){
    await rest('GET', 'shipment_files?select=id&limit=1');
    return { ok: true };
  },

  // 檔案清單（比對台用 all；出貨日期統計用 stats 精簡欄位 + 分頁）
  async listFiles(p){
    const limit = intIn(p.limit, 1, 1000, 1000);
    const offset = intIn(p.offset, 0, 10000000, 0);
    const select = p.fields === 'stats'
      ? 'source_file_name,model,row_count,uploaded_at'
      : 'id,source_file_name,sheet_name,model,row_count,uploaded_at,storage_path';
    return rest('GET', `shipment_files?select=${select}&order=uploaded_at.asc&limit=${limit}&offset=${offset}`);
  },

  // 單一檔案的所有資料列（只回 row_index + full_row）
  async getFileRows(p){
    const id = checkId(p.fileId, 'fileId');
    return rest('GET', `shipment_records?file_id=eq.${enc(id)}&select=row_index,full_row&order=row_index.asc&limit=100000`);
  },

  // 新增檔案主檔
  async createFile(p){
    const f = p.file || {};
    const row = {
      id: checkId(f.id),
      source_file_name: str(f.source_file_name, 255, '檔名'),
      sheet_name: str(f.sheet_name, 100, '分頁名稱'),
      model: str(f.model, 255, '機種'),
      row_count: intIn(f.row_count, 0, 1048576, 0),
      storage_path: f.storage_path ? (isValidStoragePath(f.storage_path) ? f.storage_path : bad('storage_path 格式錯誤')) : null,
    };
    if(!row.source_file_name || !row.sheet_name) bad('缺少檔名或分頁名稱');
    await rest('POST', 'shipment_files', [row], 'return=minimal');
    return { ok: true };
  },

  // 新增資料列（每次最多 500 筆，只接受白名單欄位）
  async insertRecords(p){
    const list = p.records;
    if(!Array.isArray(list) || list.length === 0 || list.length > 500) bad('records 必須是 1～500 筆');
    const rows = list.map(r => {
      if(!r || typeof r !== 'object') bad('records 格式錯誤');
      const out = {};
      for(const [k, v] of Object.entries(r)){
        if(!RECORD_COLUMNS.has(k)) bad(`不允許的欄位：${k}`);
        out[k] = v;
      }
      checkId(out.file_id, 'file_id');
      out.row_index = intIn(out.row_index, 0, 1048576, 0);
      out.full_row = str(out.full_row ?? '', 20000, 'full_row') ?? '';
      for(const k of Object.keys(out)){
        if(k !== 'file_id' && k !== 'row_index' && k !== 'full_row') out[k] = str(out[k], 500, k);
      }
      return out;
    });
    // 修正：只能把資料列寫進「30 分鐘內剛建立的檔案」，而且 row_index 不能超過檔案宣告的列數，
    // 避免有人往別人早就上傳好的檔案裡塞假資料（會讓重複比對結果失真）
    const fileId = rows[0].file_id;
    if(rows.some(r => r.file_id !== fileId)) bad('同一批資料必須屬於同一個檔案');
    const found = await rest('GET', `shipment_files?id=eq.${enc(fileId)}&select=row_count,uploaded_at&limit=1`);
    const f = found && found[0];
    if(!f) bad('找不到這個檔案');
    if(Date.now() - new Date(f.uploaded_at).getTime() > 30 * 60 * 1000) bad('這個檔案已建立超過 30 分鐘，不能再新增資料列');
    if(rows.some(r => r.row_index >= f.row_count)) bad('row_index 超過檔案的列數');
    await rest('POST', 'shipment_records', rows, 'return=minimal');
    return { ok: true };
  },

  // 刪除單一檔案（shipment_records 會連動刪除）
  async deleteFile(p){
    const id = checkId(p.fileId, 'fileId');
    await rest('DELETE', `shipment_files?id=eq.${enc(id)}`);
    return { ok: true };
  },

  // 依檔名刪除（原本網頁的功能：本機沒有 dbFileId 時使用）
  async deleteFileByName(p){
    const name = str(p.name, 255, '檔名');
    if(!name) bad('缺少檔名');
    await rest('DELETE', `shipment_files?source_file_name=eq.${enc(name)}`);
    return { ok: true };
  },

  // 資料庫搜尋：單一欄位模糊查詢
  async searchField(p){
    if(!SEARCH_FIELDS.has(p.field)) bad('不允許的搜尋欄位');
    const q = checkSearch(p.query, 30, '搜尋內容', 2);
    return rest('GET',
      `shipment_records?select=id,file_id,row_index,${p.field},item_model,shipment_files(source_file_name,sheet_name,uploaded_at)` +
      `&${p.field}=ilike.*${enc(q)}*&limit=50`);
  },

  // 資料庫搜尋：進階多條件（AND）
  async searchConditions(p){
    const conds = p.conditions;
    if(!Array.isArray(conds) || conds.length === 0 || conds.length > 12) bad('條件數量必須是 1～12 個');
    const params = conds.map(c => {
      if(!Array.isArray(c) || c.length !== 2 || !SEARCH_FIELDS.has(c[0])) bad('不允許的搜尋欄位');
      return `${c[0]}=ilike.*${enc(checkSearch(c[1], 30, '條件'))}*`;
    }).join('&');
    const cols = [...new Set(['id', 'file_id', 'row_index', 'item_model', ...conds.map(c => c[0])])].join(',');
    return rest('GET', `shipment_records?select=${cols},shipment_files(source_file_name,sheet_name,uploaded_at)&${params}&limit=200`);
  },

  // 機種出貨量統計（資料庫 view）
  async modelCounts(){
    return rest('GET', 'model_shipment_counts?select=model,qty&order=qty.desc');
  },

  // 刪除 Storage 裡的原始 Excel
  async deleteStorage(p){
    if(!isValidStoragePath(p.path)) bad('path 格式錯誤');
    const res = await fetch(SUPABASE_URL + '/storage/v1/object/excel-files/' + p.path, {
      method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
    });
    if(!res.ok){ console.error('[storage delete]', res.status, (await res.text()).slice(0, 300)); throw new Error('檔案刪除失敗'); }
    return { ok: true };
  },
};

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // 修正：只接受 JSON（跨站表單送不出 application/json，必須經過瀏覽器的 CORS 預檢，會被擋下）
  if(!/^application\/json\b/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: '只接受 application/json' });
  if(!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: '伺服器設定不完整' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const op = OPS[body.op];
  if(typeof body.op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, body.op)){
    return res.status(400).json({ error: '不支援的操作' });
  }
  // 修正：請求頻率限制（超過上限回 429）
  if(!(await allow(req, OP_CATEGORY[body.op]))){
    return res.status(429).json({ error: '操作太頻繁，請稍後再試' });
  }
  try{
    const data = await op(body);
    return res.status(200).json({ data });
  } catch(err){
    if(err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(502).json({ error: err.message === '資料庫操作失敗' || err.message === '檔案刪除失敗' ? err.message : '伺服器錯誤' });
  }
}
