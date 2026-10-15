// ============================================================
// 原始 Excel 上傳轉送：瀏覽器 → /api/storage?path=...（Vercel）→ Supabase Storage
// 金鑰只在伺服器端使用。限制：
//   - 只能上傳到 excel-files bucket、路徑格式固定為「檔案id/編碼後檔名」
//   - 不允許覆蓋既有檔案（x-upsert: false）
//   - Vercel 單次請求上限約 4.5MB，超過時回傳 413；網頁會照原本邏輯繼續存資料，只是沒有保存原始檔
// ============================================================
import { handlePreflight } from './_cors.js';
import { isValidStoragePath } from './_validate.js';
import { allow } from './_ratelimit.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SECRET_KEY;

const MAX_BYTES = 4 * 1024 * 1024;

// 直接讀原始資料流（不經過 Vercel 的 body 解析，避免二進位被轉碼）
function readRaw(req, limit){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if(size > limit){ reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if(!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: '伺服器設定不完整' });
  // 修正：只接受二進位上傳（跨站表單送不出這個 Content-Type）
  if(!/^application\/octet-stream\b/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: '只接受 application/octet-stream' });

  // 修正：請求頻率限制（超過上限回 429；網頁會照原本邏輯繼續存資料，只是不保存原始檔）
  if(!(await allow(req, 'upload'))) return res.status(429).json({ error: '上傳太頻繁，請稍後再試' });

  const path = new URL(req.url, 'http://x').searchParams.get('path') || '';
  if(!isValidStoragePath(path)) return res.status(400).json({ error: 'path 格式錯誤' });

  let bytes;
  try{ bytes = await readRaw(req, MAX_BYTES); }
  catch(err){
    if(err.code === 413) return res.status(413).json({ error: '檔案超過 4MB，原始檔不會保存（資料仍會存進資料庫）' });
    return res.status(400).json({ error: '讀取上傳內容失敗' });
  }
  if(!bytes.length) return res.status(400).json({ error: '檔案是空的' });

  try{
    const r = await fetch(SUPABASE_URL + '/storage/v1/object/excel-files/' + path, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/octet-stream', 'x-upsert': 'false',
      },
      body: bytes,
    });
    if(!r.ok){
      console.error('[storage upload]', r.status, (await r.text()).slice(0, 300));
      return res.status(502).json({ error: '原始檔上傳失敗' });
    }
    return res.status(200).json({ data: { ok: true, path } });
  } catch(err){
    console.error(err);
    return res.status(502).json({ error: '原始檔上傳失敗' });
  }
}
