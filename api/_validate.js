// 共用的輸入檢查
// Storage 路徑必須是「檔案id/encodeURIComponent(檔名)」的標準形式：
//   - 只能有一個 /，第一段是 id
//   - 第二段解碼後不能含 / \ 或控制字元，也不能是 . 或 ..
//   - 第二段必須跟 encodeURIComponent 的結果完全一樣（擋掉 %2e%2e、%2F 這類變形寫法）
export function isValidStoragePath(p){
  if(typeof p !== 'string' || p.length > 700) return false;
  const m = p.match(/^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9%._~!*'()-]{1,600})$/);
  if(!m) return false;
  let name;
  try{ name = decodeURIComponent(m[2]); } catch(_){ return false; }
  if(name === '.' || name === '..') return false;
  if(/[\/\\\u0000-\u001f\u007f]/.test(name)) return false;
  return encodeURIComponent(name) === m[2];
}
