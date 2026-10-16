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

  async function testConnection(){
    setStatusBar('pending', '資料庫連線：測試中…');
    try{
      await dbCall('ping');
      setStatusBar('ok', '資料庫連線成功'); return true;
    } catch(err){
      setStatusBar('bad', '資料庫連線失敗：' + err.message);
      return false;
    }
  }

  // 常見會用來查詢的欄位（9 個唯一碼 + 機種 + PO/Reference），逐一查詢才能清楚標示是哪個欄位命中
  const SEARCH_FIELDS = [
    ['imei1', 'IMEI1'], ['serial_no', 'Serial No.'], ['mac_id', 'MAC ID'], ['battery_sn', 'Battery SN'],
    ['pcba_sn', 'PCBA SN'], ['lcd_sn', 'LCD SN'], ['iccid', 'ICCID'],
    ['pcb_main_board_sn', 'PCB Main Board SN'], ['sim_unlock_code', 'SIM Unlock Code'],
    ['item_model', 'Item Model'], ['po_no', 'PO No.'], ['reference_id', 'Reference ID'],
  ];
  const RESULT_LIMIT_PER_FIELD = 50;

  async function searchRecordsByField(query, dbField){
    return dbCall('searchField', { field: dbField, query });
  }

  function renderResults(query, recordResults){
    const panel = document.getElementById('resultsPanel');
    const content = document.getElementById('content');
    panel.style.display = 'block';

    let html = '';
    const totalRecordMatches = recordResults.reduce((s, r) => s + r.rows.length, 0);
    html += `<div class="section-title">符合的裝置資料<span class="section-count">${totalRecordMatches}</span></div>`;
    const nonEmpty = recordResults.filter(r => r.rows.length);
    if(nonEmpty.length){
      html += `
        <div class="table-scroll">
          <table>
            <thead><tr><th>命中欄位</th><th>值</th><th>機種</th><th>來源檔案</th><th>分頁</th><th>列</th></tr></thead>
            <tbody>${nonEmpty.flatMap(r => r.rows.map(row => `
              <tr>
                <td class="matchfield">${escapeHtml(r.label)}</td>
                <td class="mono">${escapeHtml(row[r.field] ?? '')}</td>
                <td>${escapeHtml(row.item_model || '—')}</td>
                <td class="filename">${escapeHtml(row.shipment_files ? row.shipment_files.source_file_name : '—')}</td>
                <td class="mono">${escapeHtml(row.shipment_files ? row.shipment_files.sheet_name : '—')}</td>
                <td class="mono">${row.row_index + 2}</td>
              </tr>
            `)).join('')}</tbody>
          </table>
        </div>`;
    } else {
      html += '<div class="empty-state" style="padding:24px;">沒有裝置資料符合這個查詢</div>';
    }

    content.innerHTML = html;
  }

  async function runSearch(){
    const input = document.getElementById('searchInput');
    const btn = document.getElementById('searchBtn');
    const errorMsg = document.getElementById('errorMsg');
    const query = input.value.trim();

    errorMsg.style.display = 'none';
    if(query.length < 2 || query.length > 30){
      errorMsg.style.display = 'block';
      errorMsg.textContent = '請輸入 2～30 個字元再搜尋';
      return;
    }
    if(!/^[A-Za-z0-9()&]+$/.test(query)){
      errorMsg.style.display = 'block';
      errorMsg.textContent = '只能輸入英文字母、數字、括號 ( ) 和 &，不能包含其他符號或空白';
      return;
    }
    if((query.match(/&/g) || []).length > 1){
      errorMsg.style.display = 'block';
      errorMsg.textContent = '& 最多只能出現一個';
      return;
    }

    btn.disabled = true;
    btn.textContent = '搜尋中…';
    document.getElementById('resultsPanel').style.display = 'block';
    document.getElementById('content').innerHTML = '<div class="loading-state"><div class="big">正在查詢資料庫…</div></div>';

    try{
      const fieldResults = await Promise.all(
        SEARCH_FIELDS.map(async ([dbField, label]) => ({
          field: dbField, label, rows: await searchRecordsByField(query, dbField),
        }))
      );
      renderResults(query, fieldResults);
    } catch(err){
      document.getElementById('content').innerHTML = '';
      errorMsg.style.display = 'block';
      errorMsg.textContent = '查詢失敗：' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ 搜尋';
    }
  }

  document.getElementById('searchBtn').addEventListener('click', runSearch);
  document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if(e.key === 'Enter') runSearch();
  });

  // ================= 進階搜尋（多項條件，AND 組合）=================
  const conditionsList = document.getElementById('conditionsList');
  let conditionRowCount = 0;

  function makeConditionRow(){
    conditionRowCount++;
    const row = document.createElement('div');
    row.className = 'condition-row';
    row.innerHTML = `
      <span class="condition-and-label">${conditionRowCount === 1 ? '搜尋' : 'AND'}</span>
      <select class="condition-field">
        ${SEARCH_FIELDS.map(([field, label]) => `<option value="${field}">${escapeHtml(label)}</option>`).join('')}
      </select>
      <input type="text" class="condition-value" placeholder="輸入值…">
      <button class="condition-remove-btn" title="移除這個條件">✕</button>
    `;
    row.querySelector('.condition-remove-btn').addEventListener('click', () => {
      row.remove();
      relabelConditionRows();
    });
    row.querySelector('.condition-value').addEventListener('keydown', (e) => {
      if(e.key === 'Enter') runAdvancedSearch();
    });
    return row;
  }

  function relabelConditionRows(){
    conditionsList.querySelectorAll('.condition-row').forEach((row, i) => {
      row.querySelector('.condition-and-label').textContent = i === 0 ? '搜尋' : 'AND';
    });
  }

  document.getElementById('addConditionBtn').addEventListener('click', () => {
    conditionsList.appendChild(makeConditionRow());
  });
  conditionsList.appendChild(makeConditionRow());

  document.getElementById('advancedToggle').addEventListener('click', () => {
    const panel = document.getElementById('advancedPanel');
    const btn = document.getElementById('advancedToggle');
    const showing = panel.classList.toggle('show');
    btn.textContent = showing ? '▾ 進階搜尋（多項條件）' : '▸ 進階搜尋（多項條件）';
  });

  async function searchRecordsByConditions(conditions){
    return dbCall('searchConditions', { conditions });
  }

  function renderAdvancedResults(conditions, rows){
    const panel = document.getElementById('resultsPanel');
    const content = document.getElementById('content');
    panel.style.display = 'block';

    const condDesc = conditions.map(([field, value]) => {
      const label = (SEARCH_FIELDS.find(f => f[0] === field) || [, field])[1];
      return `${escapeHtml(label)} 包含「${escapeHtml(value)}」`;
    }).join('　且　');

    let html = `<div class="section-title">符合條件的裝置資料（${condDesc}）<span class="section-count">${rows.length}</span></div>`;
    if(rows.length){
      html += `
        <div class="table-scroll">
          <table>
            <thead><tr><th>機種</th>${conditions.map(([field]) => `<th>${escapeHtml((SEARCH_FIELDS.find(f => f[0] === field) || [,field])[1])}</th>`).join('')}<th>來源檔案</th><th>分頁</th><th>列</th></tr></thead>
            <tbody>${rows.map(row => `
              <tr>
                <td>${escapeHtml(row.item_model || '—')}</td>
                ${conditions.map(([field]) => `<td class="mono">${escapeHtml(row[field] ?? '')}</td>`).join('')}
                <td class="filename">${escapeHtml(row.shipment_files ? row.shipment_files.source_file_name : '—')}</td>
                <td class="mono">${escapeHtml(row.shipment_files ? row.shipment_files.sheet_name : '—')}</td>
                <td class="mono">${row.row_index + 2}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>`;
    } else {
      html += '<div class="empty-state" style="padding:24px;">沒有符合全部條件的資料</div>';
    }
    content.innerHTML = html;
  }

  async function runAdvancedSearch(){
    const errorMsg = document.getElementById('errorMsg');
    const btn = document.getElementById('advancedSearchBtn');
    errorMsg.style.display = 'none';

    const conditions = [...conditionsList.querySelectorAll('.condition-row')]
      .map(row => [row.querySelector('.condition-field').value, row.querySelector('.condition-value').value.trim()])
      .filter(([, value]) => value.length >= 1);

    if(!conditions.length){
      errorMsg.style.display = 'block';
      errorMsg.textContent = '請至少填寫一個條件的值';
      return;
    }
    if(conditions.some(([, value]) => value.length > 30)){
      errorMsg.style.display = 'block';
      errorMsg.textContent = '每個條件最多 30 個字元';
      return;
    }
    if(conditions.some(([, value]) => !/^[A-Za-z0-9()&]+$/.test(value))){
      errorMsg.style.display = 'block';
      errorMsg.textContent = '只能輸入英文字母、數字、括號 ( ) 和 &，不能包含其他符號或空白';
      return;
    }
    if(conditions.some(([, value]) => (value.match(/&/g) || []).length > 1)){
      errorMsg.style.display = 'block';
      errorMsg.textContent = '每個條件裡的 & 最多只能出現一個';
      return;
    }

    btn.disabled = true;
    btn.textContent = '搜尋中…';
    document.getElementById('resultsPanel').style.display = 'block';
    document.getElementById('content').innerHTML = '<div class="loading-state"><div class="big">正在查詢資料庫…</div></div>';

    try{
      const rows = await searchRecordsByConditions(conditions);
      renderAdvancedResults(conditions, rows);
    } catch(err){
      document.getElementById('content').innerHTML = '';
      errorMsg.style.display = 'block';
      errorMsg.textContent = '查詢失敗：' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ 進階搜尋';
    }
  }

  document.getElementById('advancedSearchBtn').addEventListener('click', runAdvancedSearch);

  testConnection();
