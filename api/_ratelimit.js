// ============================================================
// 請求頻率限制
// 計數存在 Supabase（backend-vercel/rate-limit.sql 建立的 api_rate_hit 函式），
// 所以不管 Vercel 同時開幾台伺服器，大家共用同一份計數。
//
// 上限可以直接改下面的 RULES。數字是依照網頁正常使用情況訂的：
//   - 比對時每個檔案要讀一次資料列，所以「讀取」給得比較寬
//   - 搜尋頁按一次搜尋會查 12 個欄位，等於 12 次請求
//   - 「刪除」是最危險的操作，除了每個 IP 的上限，還有全站每天的總上限，
//     就算有人換很多個 IP，一天也刪不完整個資料庫
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SECRET_KEY;

const MIN = 60, HOUR = 3600, DAY = 86400;

// 每一類操作的規則：[計數範圍('ip' 或 'global'), 時間區間(秒), 上限次數]
export const RULES = {
  read:   [['ip', MIN, 1200]],                                     // 檔案清單、讀取資料列、統計、連線測試
  search: [['ip', MIN, 600]],                                      // 搜尋（約每分鐘 50 次搜尋）
  create: [['ip', HOUR, 300]],                                     // 新增檔案
  insert: [['ip', HOUR, 6000]],                                    // 新增資料列（每次 500 筆）
  delete: [['ip', 10 * MIN, 60], ['ip', HOUR, 200], ['global', DAY, 1000]],
  upload: [['ip', HOUR, 300], ['global', DAY, 3000]],              // 上傳原始 Excel
};

// 哪個 op 屬於哪一類
export const OP_CATEGORY = {
  ping: 'read', listFiles: 'read', getFileRows: 'read', modelCounts: 'read',
  searchField: 'search', searchConditions: 'search',
  createFile: 'create',
  insertRecords: 'insert',
  deleteFile: 'delete', deleteFileByName: 'delete', deleteStorage: 'delete',
};

// 取得使用者 IP。部署在 Vercel 時，x-forwarded-for 由 Vercel 設定，使用者無法偽造
export function clientIp(req){
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function hit(key, windowSeconds, limit){
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/api_rate_hit', {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_key: key, p_window_seconds: windowSeconds, p_limit: limit }),
  });
  if(!res.ok) throw new Error('rate limit check failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return (await res.json()) === true;
}

// 回傳 true = 可以繼續；false = 超過上限
// 如果資料庫還沒執行 rate-limit.sql（或計數失敗），會記錄錯誤但放行，避免整個網站因此停擺
export async function allow(req, category){
  const rules = RULES[category];
  if(!rules) return true;
  const ip = clientIp(req);
  try{
    const results = await Promise.all(rules.map(([scope, win, limit]) =>
      hit(scope === 'global' ? `global:${category}:${win}` : `ip:${ip}:${category}:${win}`, win, limit)));
    return results.every(Boolean);
  } catch(err){
    console.error('[rate-limit] 無法計數，暫時放行。請確認已執行 backend-vercel/rate-limit.sql：', err.message);
    return true;
  }
}
