import { supabase, handlePreflight } from './_lib.js';

export default async function handler(req, res){
  if(handlePreflight(req, res)) return;
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const { data, error } = await supabase.rpc('find_duplicate_records');
    if(error) throw error;

    // 依欄位分組，整理成前端要的格式
    const grouped = new Map();
    (data || []).forEach(row => {
      if(!grouped.has(row.field)) grouped.set(row.field, { field: row.field, values: new Set(), rows: [] });
      const g = grouped.get(row.field);
      g.values.add(row.matched_value);
      g.rows.push(row);
    });

    const results = [...grouped.values()].map(g => ({
      field: g.field,
      duplicateValueCount: g.values.size,
      rows: g.rows,
    }));
    const totalDuplicateRows = results.reduce((sum, r) => sum + r.rows.length, 0);

    res.status(200).json({ results, totalDuplicateRows });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
}
