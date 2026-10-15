// 共用的 CORS / 快取標頭處理（不依賴 Supabase 套件）
// 修正：原本 Access-Control-Allow-Origin: * 讓任何網站都能呼叫。
// 前端跟 API 在同一個網域，不需要 CORS；有設定 ALLOWED_ORIGIN 才開放那一個來源。
export function handlePreflight(req, res){
  const allowed = process.env.ALLOWED_ORIGIN;
  if(allowed && req.headers.origin === allowed){
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return true; }
  return false;
}
