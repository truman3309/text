import { supabase, handlePreflight } from '../../_lib.js';

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  if(req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;

  const { data: file, error: fileErr } = await supabase
    .from('shipment_files').select('*').eq('id', id).single();
  if(fileErr || !file) return res.status(404).json({ error: '找不到這個檔案' });

  const { data: rows, error: rowsErr } = await supabase
    .from('shipment_records')
    .select('row_index, full_row')
    .eq('file_id', id)
    .order('row_index', { ascending: true });
  if(rowsErr) return res.status(500).json({ error: rowsErr.message });

  res.status(200).json({ file, rows: rows.map(r => r.full_row) });
}
