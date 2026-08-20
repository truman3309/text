import { supabase, handlePreflight } from './_lib.js';

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  try{
    const { error } = await supabase.from('shipment_files').select('id').limit(1);
    if(error) throw error;
    res.status(200).json({ ok: true });
  } catch(err){
    res.status(500).json({ ok: false, error: err.message });
  }
}
