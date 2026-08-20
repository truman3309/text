import { supabase, handlePreflight } from '../_lib.js';

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  const { id } = req.query;

  if(req.method === 'DELETE'){
    const { error } = await supabase.from('shipment_files').delete().eq('id', id);
    if(error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
