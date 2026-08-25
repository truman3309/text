function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

const SUPABASE_URL = 'https://brhjfveertlypgrwkqfq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJyaGpmdmVlcnRseXBncndrcWZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxODI5NTUsImV4cCI6MjEwMjc1ODk1NX0.8fQJ-kiIHV8ePjDTjfby7fHmthqWekD1Sf3TtzfbGwo';

function supabaseHeaders(extra){
  return Object.assign({
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

const apiStatusDot = document.getElementById('apiStatusDot');
const apiStatusText = document.getElementById('apiStatusText');
function setStatusBar(state, text){
  apiStatusDot.className = 'dot' + (state ? ' ' + state : '');
  apiStatusText.textContent = text;
}

// 分頁把 shipment_records 裡所有的 item_model 撈回來（資料量大，PostgREST 預設一次最多回 1000 筆，要自己分頁撈完）
async function fetchAllItemModels(){
  const PAGE_SIZE = 1000;
  let all = [];
  let offset = 0;
  while(true){
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/shipment_records?select=item_model&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`,
      { headers: supabaseHeaders() }
    );

    if(!res.ok){
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || res.statusText);
    }
    const data = await res.json();
    all = all.concat(data.map(r => r.item_model));
    if(data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

function aggregateByModel(models){
  const counts = new Map();
  models.forEach(m => {
    const key = (m || '').trim() || '未分類';
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

let fullData = []; // [[model, qty], ...]
let maxQty = 0;

function renderList(list){
  const content = document.getElementById('content');
  if(!list.length){
    content.innerHTML = '<div class="empty-state"><div class="big">找不到符合的機種</div></div>';
    return;
  }
  content.innerHTML = '<div class="model-list">' + list.map(([model, qty]) => {
    const pct = maxQty ? Math.round((qty / maxQty) * 100) : 0;

    return `
      <div class="model-row">
        <div class="model-name">${escapeHtml(model)}</div>
        <div class="model-bar-track"><div class="model-bar-fill" style="width:${pct}%"></div></div>
        <div class="model-qty">${qty} <span>台</span></div>
      </div>`;
  }).join('') + '</div>';
}

function updateSummary(list, totalQty){
  document.getElementById('summaryRow').style.display = 'flex';
  document.getElementById('statModelCount').textContent = list.length;
  document.getElementById('statTotalQty').innerHTML = totalQty.toLocaleString() + ' <span>台</span>';
}

async function loadData(){
  const errorMsg = document.getElementById('errorMsg');
  const content = document.getElementById('content');
  errorMsg.style.display = 'none';
  document.getElementById('summaryRow').style.display = 'none';
  content.innerHTML = '<div class="loading-state"><div class="big">正在讀取資料…</div><div>資料量較大時可能需要幾秒鐘</div></div>';
  setStatusBar('pending', '資料庫連線：讀取中…');

  try{
    const models = await fetchAllItemModels();
    setStatusBar('ok', '資料庫連線成功');
    fullData = aggregateByModel(models);
    maxQty = fullData.length ? fullData[0][1] : 0;
    const totalQty = models.length;
    updateSummary(fullData, totalQty);
    renderList(fullData);
  } catch(err){

    setStatusBar('bad', '資料庫連線失敗：' + err.message);
    content.innerHTML = '';
    errorMsg.style.display = 'block';
    errorMsg.textContent = '讀取失敗：' + err.message;
  }
}

let searchDebounceTimer = null;
document.getElementById('searchBox').addEventListener('input', (e) => {
  clearTimeout(searchDebounceTimer);
  const q = e.target.value.trim().toLowerCase();
  searchDebounceTimer = setTimeout(() => {
    const filtered = q ? fullData.filter(([model]) => model.toLowerCase().includes(q)) : fullData;
    renderList(filtered);
  }, 150);
});

document.getElementById('refreshBtn').addEventListener('click', loadData);

document.getElementById('exportBtn').addEventListener('click', () => {
  if(!fullData.length) return;
  const lines = ['"機種","出貨量"'];
  fullData.forEach(([model, qty]) => {
    lines.push(`"${String(model).replace(/"/g, '""')}","${qty}"`);
  });
  const csv = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '機種出貨量統計.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);

});

loadData();