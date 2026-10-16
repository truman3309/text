  function escapeHtml(str){
    return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }

  async function dbCall(op, params){
    const res = await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ op }, params || {})),
    });
    const out = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(out.error || ('HTTP ' + res.status));
    return out.data;
  }


  function csvCell(v){
    let s = String(v ?? '');
    if(/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const apiStatusDot = document.getElementById('apiStatusDot');
  const apiStatusText = document.getElementById('apiStatusText');
  function setStatusBar(state, text){
    apiStatusDot.className = 'dot' + (state ? ' ' + state : '');
    apiStatusText.textContent = text;
  }

  async function fetchAllShipmentFiles(){
    const PAGE_SIZE = 1000;
    let all = [];
    let offset = 0;
    while(true){
      const data = await dbCall('listFiles', { fields: 'stats', limit: PAGE_SIZE, offset });
      all = all.concat(data);
      if(data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return all;
  }

  const MONTH_NAMES = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const THIS_YEAR = new Date().getFullYear();

  function parseShipmentInfoFromFilename(filename){
    let date = null;

    const monthMatch = filename.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if(monthMatch){
      const mKey = monthMatch[1].slice(0, 3).toLowerCase();
      if(MONTH_NAMES[mKey] !== undefined){
        const y = Number(monthMatch[3]), d = Number(monthMatch[2]);
        const dt = new Date(y, MONTH_NAMES[mKey], d);
        if(!isNaN(dt.getTime()) && dt.getFullYear() === y) date = dt;
      }
    }

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

  let fullRows = []; 
  let unparsedRows = []; 

  const expandedModels = new Set();

  function buildFlatGroups(rows){
    const ymMap = new Map(); 
    rows.forEach(r => {
      const y = r.date.getFullYear();
      const m = r.date.getMonth() + 1;
      const ymKey = `${y}-${m}`;
      if(!ymMap.has(ymKey)) ymMap.set(ymKey, { year: y, month: m, modelMap: new Map(), total: 0 });
      const g = ymMap.get(ymKey);
      const modelKey = (r.model || '').trim() || '未標示機種';
      if(!g.modelMap.has(modelKey)) g.modelMap.set(modelKey, { files: [], total: 0 });
      const modelEntry = g.modelMap.get(modelKey);
      modelEntry.files.push(r);
      modelEntry.total += r.quantity;
      g.total += r.quantity;
    });

    const groups = Array.from(ymMap.values()).map(g => {
      const models = Array.from(g.modelMap.entries())
        .map(([model, v]) => ({ model, files: v.files.sort((a, b) => b.date - a.date), total: v.total }))
        .sort((a, b) => b.total - a.total);
      return { year: g.year, month: g.month, models, total: g.total };
    });

    groups.sort((a, b) => b.year - a.year || b.month - a.month);
    return groups;
  }

  function renderFlatGroups(groups){
    if(!groups.length) return '<div class="empty-state"><div class="big">沒有可判讀日期的資料</div></div>';

    let prevYm = null;
    const rows = groups.map(g => {
      const key = `${g.year}-${g.month}`;
      const expanded = expandedModels.has(key);
      const ymText = `${g.year} / ${String(g.month).padStart(2,'0')}`;
      const isNewYm = key !== prevYm;
      prevYm = key;

    
      const modelNamesJoined = g.models.map(m => escapeHtml(m.model)).join('、');

      const detail = expanded ? `
        <div class="detail-wrap">
          <div class="table-scroll">
            <table>
              <thead><tr><th>日期</th><th>檔名</th><th>機種</th><th style="text-align:right;">數量</th></tr></thead>
              <tbody>
                ${g.models.flatMap(m => m.files).sort((a, b) => b.date - a.date).map(f => `
                  <tr>
                    <td>${escapeHtml(f.dateStr)}</td>
                    <td class="filename">${escapeHtml(f.source_file_name)}</td>
                    <td>${escapeHtml(f.model || '—')}</td>
                    <td class="qty">${f.quantity.toLocaleString()}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>` : '';

      return `
        <div class="model-row-header${expanded ? ' expanded' : ''}${isNewYm ? ' new-month' : ''}" data-toggle-model="${escapeHtml(key)}">
          <span class="m-ym">${ymText}</span>
          <span class="m-name">${modelNamesJoined}</span>
          <span class="m-qty">${g.total.toLocaleString()} 台</span>
          <span class="caret">▸</span>
        </div>
        ${detail}`;
    }).join('');

    return `
      <div class="col-labels">
        <span>年月</span><span>機種</span><span>數量</span><span></span>
      </div>
      ${rows}`;
  }

  function currentFilteredRows(searchQ){
    if(!searchQ) return fullRows;
    const q = searchQ.toLowerCase();
    return fullRows.filter(r =>
      (r.source_file_name || '').toLowerCase().includes(q) || (r.model || '').toLowerCase().includes(q)
    );
  }

  // 搜尋框只允許英文、數字和 ( ) &，且 & 最多一個；
  function searchError(q){
    if(q === '') return '';
    if(!/^[A-Za-z0-9()&]+$/.test(q)) return '搜尋只能輸入英文字母、數字和 ( ) &，不能包含其他符號或空白';
    if((q.match(/&/g) || []).length > 1) return '搜尋內容裡的 & 最多只能出現一個';
    return '';
  }

  function renderTables(){
    const content = document.getElementById('content');
    const searchQ = document.getElementById('searchBox').value.trim();
    const errorMsg = document.getElementById('errorMsg');

    const err = searchError(searchQ);
    if(err){
      errorMsg.style.display = 'block';
      errorMsg.textContent = err;
      errorMsg.dataset.from = 'search';
      content.innerHTML = '<div class="empty-state"><div class="big">請修正搜尋內容</div></div>';
      return;
    }
    if(errorMsg.dataset.from === 'search'){
      errorMsg.style.display = 'none';
      errorMsg.dataset.from = '';
    }

    const filtered = currentFilteredRows(searchQ);

    if(searchQ){
      buildFlatGroups(filtered).forEach(g => expandedModels.add(`${g.year}-${g.month}`));
    }

    const groups = buildFlatGroups(filtered);
    let html = renderFlatGroups(groups);

    const uq = searchQ.toLowerCase();
    const unparsedFiltered = searchQ
      ? unparsedRows.filter(r => (r.source_file_name || '').toLowerCase().includes(uq) || (r.model || '').toLowerCase().includes(uq))
      : unparsedRows;

    if(unparsedFiltered.length){
      html += `
        <div class="section-title">無法從檔名判讀日期（${unparsedFiltered.length} 筆）</div>
        <div class="section-hint">數量改用資料庫實際列數，僅供參考；如果需要精準統計，建議調整這些檔案的命名格式。</div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>檔名</th><th>機種</th><th>上傳時間</th><th style="text-align:right;">數量（資料庫列數）</th></tr></thead>
            <tbody>${unparsedFiltered.map(r => `
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
    bindTreeEvents();
  }

  function bindTreeEvents(){
    document.querySelectorAll('[data-toggle-model]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-toggle-model');
        if(expandedModels.has(key)) expandedModels.delete(key);
        else expandedModels.add(key);
        renderTables();
      });
    });
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
      expandedModels.clear();

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

      renderTables();
    } catch(err){
      setStatusBar('bad', '資料庫連線失敗：' + err.message);
      content.innerHTML = '';
      errorMsg.style.display = 'block';
      errorMsg.textContent = '讀取失敗：' + err.message;
    }
  }
  const RESULT_SEARCH_ENABLED = false;
    if(!RESULT_SEARCH_ENABLED){
    const box = document.getElementById('searchBox');
    box.disabled = true;
    box.title = '搜尋功能目前已關閉';
    box.placeholder = '目前搜尋功能關閉';  
  }
  let searchDebounceTimer = null;
  document.getElementById('searchBox').addEventListener('input', () => {
    if(!RESULT_SEARCH_ENABLED) return;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderTables, 150);
  });

  document.getElementById('refreshBtn').addEventListener('click', loadData);

  let allExpanded = false;
  document.getElementById('expandAllBtn').addEventListener('click', () => {
    allExpanded = !allExpanded;
    document.getElementById('expandAllBtn').textContent = allExpanded ? '全部收合' : '全部展開';
    if(allExpanded){
      buildFlatGroups(currentFilteredRows(document.getElementById('searchBox').value.trim()))
        .forEach(g => expandedModels.add(`${g.year}-${g.month}`));
    } else {
      expandedModels.clear();
    }
    renderTables();
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    const searchQ = document.getElementById('searchBox').value.trim();
    if(searchError(searchQ)) return;
    const filtered = currentFilteredRows(searchQ);
    if(!filtered.length && !unparsedRows.length) return;
    const lines = ['"出貨日期","檔名","機種","數量"'];
    filtered.forEach(r => {
      lines.push([r.dateStr, r.source_file_name, r.model || '', r.quantity].map(csvCell).join(','));
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
