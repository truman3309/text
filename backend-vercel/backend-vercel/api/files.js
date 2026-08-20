import { supabase, handlePreflight, FIELD_MAP, genId } from './_lib.js';

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;

  // ---------- 已上傳檔案清單 ----------
  if(req.method === 'GET'){
    const { data, error } = await supabase
      .from('shipment_files')
      .select('id, source_file_name, sheet_name, model, row_count, uploaded_at')
      .order('uploaded_at', { ascending: true });
    if(error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ files: data });
  }

  // ---------- 上傳一個分頁的資料 ----------
  if(req.method === 'POST'){
    const { sourceFileName, sheetName, model, rows } = req.body || {};
    if(!sourceFileName || !sheetName || !Array.isArray(rows)){
      return res.status(400).json({ error: '缺少必要欄位：sourceFileName、sheetName、rows' });
    }

    const id = genId();
    const { error: fileErr } = await supabase.from('shipment_files').insert({
      id, source_file_name: sourceFileName, sheet_name: sheetName, model: model || null, row_count: rows.length,
    });
    if(fileErr) return res.status(500).json({ error: fileErr.message });

    const BATCH_SIZE = 500;
    for(let i = 0; i < rows.length; i += BATCH_SIZE){
      const batch = rows.slice(i, i + BATCH_SIZE).map((row, idx) => {
        const rec = { file_id: id, row_index: i + idx, full_row: row.fullRow ?? row };
        FIELD_MAP.forEach(([camelKey, col]) => { rec[col] = row[camelKey] ?? null; });
        return rec;
      });
      const { error: insErr } = await supabase.from('shipment_records').insert(batch);
      if(insErr){
        // 上傳中途失敗時，把已經寫進去、屬於這個檔案的資料清乾淨，避免留下半份資料
        await supabase.from('shipment_files').delete().eq('id', id);
        return res.status(500).json({ error: insErr.message });
      }
    }

    return res.status(200).json({ id, rowCount: rows.length });
  }

  // ---------- 清空全部 ----------
  if(req.method === 'DELETE'){
    const { error } = await supabase.from('shipment_files').delete().not('id', 'is', null);
    if(error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
