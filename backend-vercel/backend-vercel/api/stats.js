import { supabase, handlePreflight } from './_lib.js';

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  if(req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const { data: byModel, error: e1 } = await supabase.rpc('shipment_stats_by_model');
    if(e1) throw e1;

    const { data: byFile, error: e2 } = await supabase
      .from('shipment_files')
      .select('source_file_name, sheet_name, model, row_count, uploaded_at')
      .order('uploaded_at', { ascending: true });
    if(e2) throw e2;

    res.status(200).json({ byModel, byFile });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
}
