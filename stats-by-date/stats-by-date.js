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

// shipment_files 是檔案層級的表，數量遠比 shipment_records 少，一般不會超過 1000 筆，
// 但保險起見還是做分頁，避免檔案數量成長後漏抓
async function fetchAllShipmentFiles(){
  const PAGE_SIZE = 1000;
  let all = [];
  let offset = 0;
  while(true){
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/shipment_files?select=source_file_name,model,row_count,uploaded_at&order=uploaded_at.asc&limit=${PAGE_SIZE}&offset=${offset}`,
      { headers: supabaseHeaders() }
    );
    if(!res.ok){
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || res.statusText);
    }
    const data = await res.json();
    all = all.concat(data);
    if(data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

const MONTH_NAMES = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
const THIS_YEAR = new Date().getFullYear();

// 從檔名嘗試解析出貨日期跟數量，格式不固定，盡量抓，抓不到就回傳 null
function parseShipmentInfoFromFilename(filename){
  let date = null;

  // 格式一：英文月份，例如 "Aug 14 2026" / "July 30 2026"
  const monthMatch = filename.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if(monthMatch){
    const mKey = monthMatch[1].slice(0, 3).toLowerCase();
    if(MONTH_NAMES[mKey] !== undefined){
      const y = Number(monthMatch[3]), d = Number(monthMatch[2]);
      const dt = new Date(y, MONTH_NAMES[mKey], d);
      if(!isNaN(dt.getTime()) && dt.getFullYear() === y) date = dt;
    }
  }

  // 格式二：6 碼數字 YYMMDD，例如 "260304" = 2026-03-04（限制年份要接近現在，避免誤判成 PO/REF 編號的一部分）
  if(!date){
    const ymdMatch = filename.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/);
    if(ymdMatch){
      const yy = Number(ymdMatch[1]), mm = Number(ymdMatch[2]), dd = Number(ymdMatch[3]);
      const fullYear = 2000 + yy;
      if(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && Math.abs(fullYear - THIS_YEAR) <= 5){
        const dt = new Date(fullYear, mm - 1, dd);
        if(!isNaN(dt.getTime())) date = dt;
      }
    }
  }

  // 數量：找檔名裡的「數字 + PCS」
  let quantity = null;
  const pcsMatch = filename.match(/(\d+)\s*PCS/i);
  if(pcsMatch) quantity = parseInt(pcsMatch[1], 10);

  return { date, quantity };
}

function formatDate(d){
  if(!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let fullRows = []; // 已解析出日期的
let unparsedRows = []; // 解析不出日期的

function renderTables(parsed, unparsed){
  const content = document.getElementById('content');
  let html = '';

  if(parsed.length){
    html += `
      <div class="table-scroll">
        <table>
          <thead><tr><th>出貨日期</th><th>檔名</th><th>機種</th><th style="text-align:right;">數量</th></tr></thead>
          <tbody>${parsed.map(r => `
            <tr>
              <td>${escapeHtml(r.dateStr)}</td>
              <td class="filename">${escapeHtml(r.source_file_name)}</td>
              <td>${escapeHtml(r.model || '—')}</td>
              <td class="qty">${r.quantity.toLocaleString()}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>`;
  } else {
    html += '<div class="empty-state"><div class="big">沒有可判讀日期的資料</div></div>';
  }

  if(unparsed.length){
    html += `
      <div class="section-title">無法從檔名判讀日期（${unparsed.length} 筆）</div>
      <div class="section-hint">數量改用資料庫實際列數，僅供參考；如果需要精準統計，建議調整這些檔案的命名格式。</div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>檔名</th><th>機種</th><th>上傳時間</th><th style="text-align:right;">數量（資料庫列數）</th></tr></thead>
          <tbody>${unparsed.map(r => `
            <tr>
              <td class="filename">${escapeHtml(r.source_file_name)}<span class="unparsed-badge">無法解析日期</span></td>
              <td>${escapeHtml(r.model || '—')}</td>
              <td>${escapeHtml(new Date(r.uploaded_at).toLocaleString())}</td>
              <td class="qty">${r.row_count.toLocaleString()}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>`;
  }

  content.innerHTML = html;
}

async function loadData(){
  const errorMsg = document.getElementById('errorMsg');
  const content = document.getElementById('content');
  errorMsg.style.display = 'none';
  document.getElementById('summaryRow').style.display = 'none';
  content.innerHTML = '<div class="loading-state"><div class="big">正在讀取資料…</div></div>';
  setStatusBar('pending', '資料庫連線：讀取中…');

  try{
    const files = await fetchAllShipmentFiles();
    setStatusBar('ok', '資料庫連線成功');

    fullRows = [];
    unparsedRows = [];

    files.forEach(f => {
      const info = parseShipmentInfoFromFilename(f.source_file_name || '');
      if(info.date){
        fullRows.push({
          source_file_name: f.source_file_name, model: f.model,
          date: info.date, dateStr: formatDate(info.date),
          quantity: info.quantity != null ? info.quantity : f.row_count,
        });
      } else {
        unparsedRows.push(f);
      }
    });

    fullRows.sort((a, b) => b.date - a.date);

    const totalQty = fullRows.reduce((s, r) => s + r.quantity, 0) + unparsedRows.reduce((s, r) => s + r.row_count, 0);
    document.getElementById('summaryRow').style.display = 'flex';
    document.getElementById('statFileCount').textContent = files.length;
    document.getElementById('statTotalQty').innerHTML = totalQty.toLocaleString() + ' <span>台</span>';
    document.getElementById('statParsedCount').textContent = `${fullRows.length} / ${files.length}`;

    renderTables(fullRows, unparsedRows);
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
    const matchQ = r => (r.source_file_name || '').toLowerCase().includes(q) || (r.model || '').toLowerCase().includes(q);
    const p = q ? fullRows.filter(matchQ) : fullRows;
    const u = q ? unparsedRows.filter(matchQ) : unparsedRows;
    renderTables(p, u);
  }, 150);
});

document.getElementById('refreshBtn').addEventListener('click', loadData);

document.getElementById('exportBtn').addEventListener('click', () => {
  if(!fullRows.length && !unparsedRows.length) return;
  const lines = ['"出貨日期","檔名","機種","數量","備註"'];
  fullRows.forEach(r => {
    lines.push(`"${r.dateStr}","${String(r.source_file_name).replace(/"/g,'""')}","${String(r.model || '').replace(/"/g,'""')}","${r.quantity}",""`);
  });
  unparsedRows.forEach(r => {
    lines.push(`"","${String(r.source_file_name).replace(/"/g,'""')}","${String(r.model || '').replace(/"/g,'""')}","${r.row_count}","無法解析日期，數量為資料庫列數"`);
  });
  const csv = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '出貨日期與出貨量統計.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

loadData();