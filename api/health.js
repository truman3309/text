import { supabase, handlePreflight } from './_lib.js';
// 修正：只回 ok / 不 ok，不回傳資料庫原始錯誤訊息
export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  try{
    const { error } = await supabase.from('shipment_files').select('id').limit(1);
    if(error) throw error;
    res.status(200).json({ ok: true });
  } catch(err){
    console.error(err);
    res.status(503).json({ ok: false });
  }
/*
export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  try{
    const { error } = await supabase.from('shipment_files').select('id').limit(1);
    if(error) throw error;
    res.status(200).json({ ok: true });
  } catch(err){
    res.status(500).json({ ok: false });
  }
}*/
