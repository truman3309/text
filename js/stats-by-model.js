  function escapeHtml(str){
    return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }

  // 資料庫一律經過伺服器轉送 /api/db，金鑰只存在 Vercel，瀏覽器（含開發者工具）看不到
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


  // 修正（CSV/公式注入）：以 = + - @ Tab CR 開頭的值（純數字除外），Excel 開啟時會被當成公式執行，前面加 ' 變成純文字
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

  // 直接查已經在資料庫端算好聚合結果的 view，一次請求就拿到「機種＋數量」，不用整包資料撈回來自己算
  async function fetchModelCounts(){
    const data = await dbCall('modelCounts');
    return data.map(r => [r.model, r.qty]);
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
          <div class="model-qty">${escapeHtml(qty)} <span>台</span></div>
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
      fullData = await fetchModelCounts();
      setStatusBar('ok', '資料庫連線成功');
      maxQty = fullData.length ? fullData[0][1] : 0;
      const totalQty = fullData.reduce((sum, [, qty]) => sum + qty, 0);
      updateSummary(fullData, totalQty);
      renderList(fullData);
    } catch(err){
      setStatusBar('bad', '資料庫連線失敗：' + err.message);
      content.innerHTML = '';
      errorMsg.style.display = 'block';
      errorMsg.textContent = '讀取失敗：' + err.message;
    }
  }
  if(!RESULT_SEARCH_ENABLED){
    const box = document.getElementById('searchBox');
    box.disabled = true;
    box.title = '搜尋功能目前已關閉';
    box.placeholder = '目前搜尋功能關閉';   // ← 加這一行
  }
  const RESULT_SEARCH_ENABLED = false;
  let searchDebounceTimer = null;
  document.getElementById('searchBox').addEventListener('input', (e) => {
    if(!RESULT_SEARCH_ENABLED) return;
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
      lines.push(csvCell(model) + ',' + csvCell(qty));
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
