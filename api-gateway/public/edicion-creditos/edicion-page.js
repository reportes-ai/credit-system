'use strict';
const token = sessionStorage.getItem('token');
const yo = JSON.parse(sessionStorage.getItem('usuario') || 'null');
if (!token || !yo) location.href = '/login.html';

const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const TIPO = window.EDICION_TIPO || 'otorgados';

document.getElementById('navNombre').textContent = yo.nombre + ' ' + (yo.apellido || '');
document.getElementById('navPerfil').textContent = yo.perfil || '';
document.getElementById('avatarInicial').textContent = (yo.nombre || '?')[0].toUpperCase();
function logout() { sessionStorage.clear(); location.href = '/login.html'; }

let CAMPOS = [], page = 1, sortCol = 'id', sortDir = 'desc', filters = {};
// Columnas fijas a la izquierda. id_financiera va junto al N° Operación y es editable
// (el backend lo sigue aceptando porque está en CAMPOS_EDIT; en el front lo sacamos del
// bloque editable de la derecha para no duplicarlo).
const COLS_FIJAS = [
  { field:'num_op',                 label:'N° Operación',         edit:false },
  { field:'id_financiera',          label:'ID Financiera',         edit:true  },
  { field:'numero_credito_display', label:'N° Operación (nuevo)',  edit:false },
  { field:'nombre_cliente',         label:'Cliente',               edit:false },
  { field:'rut_cliente',            label:'RUT',                   edit:false },
];
const camposVis = () => CAMPOS.filter(c => c.col !== 'id_financiera');

// Campos calculados (azul) y forzados (rojo). El backend envía la lista en `calculados`.
let CALC = new Set();
let _soloForzados = false;
const CALC_STYLE    = 'color:#0141A2';                 // azul = calculado por fórmula
const FORZADO_STYLE = 'color:#dc2626;font-weight:700'; // rojo = digitado a mano (forzado)
function parseForzados(raw) {
  if (!raw) return new Set();
  try { const a = Array.isArray(raw) ? raw : JSON.parse(raw); return new Set(Array.isArray(a) ? a : []); }
  catch (_) { return new Set(); }
}
const escH = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function colLetter(n) {
  let s = ''; n++;
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function toast(msg, tipo = 'ok') {
  let t = document.getElementById('ed-toast');
  t.textContent = msg; t.className = tipo + ' show';
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.className = '', tipo === 'ok' ? 2500 : 5000);
}

/* ── Build table headers ─────────────────────────────────────── */
function buildHeaders() {
  const thead = document.getElementById('ed-thead');
  if (!thead || !CAMPOS.length) return;

  const trL = document.createElement('tr');
  trL.className = 'tr-letters';

  const tr = document.createElement('tr');

  // columna acciones (guardar)
  const thLA = document.createElement('th'); thLA.textContent = '#'; trL.appendChild(thLA);
  const thA  = document.createElement('th'); thA.innerHTML = ''; tr.appendChild(thA);

  // columnas fijas (incluye ID Financiera junto al N° Operación)
  COLS_FIJAS.forEach(({ field, label }, i) => {
    const thL = document.createElement('th');
    thL.id = 'colLetter_fijo_' + i;
    thL.textContent = colLetter(i);
    thL.title = field; thL.style.cursor = 'pointer';
    thL.onclick = () => irAColumna(field, 'fijo_' + i);
    trL.appendChild(thL);

    const th = document.createElement('th');
    const inner = document.createElement('div'); inner.className = 'th-inner';
    const lbl = document.createElement('div');
    lbl.className = 'th-label' + (sortCol === field ? ' sorted-' + sortDir : '');
    lbl.innerHTML = `${escH(label)}<span class="sort-icon"></span>`;
    lbl.onclick = () => toggleSort(field);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'filter-input'; inp.placeholder = '🔍';
    inp.dataset.col = field; inp.value = filters[field] || '';
    inp.oninput = debounce(() => { filters[field] = inp.value; page = 1; load(); }, 400);
    inner.appendChild(lbl); inner.appendChild(inp); th.appendChild(inner); tr.appendChild(th);
  });

  // columnas editables
  const startIdx = COLS_FIJAS.length;
  camposVis().forEach((c, i) => {
    const idx = startIdx + i;
    const thL = document.createElement('th');
    thL.id = 'colLetter_' + idx;
    thL.textContent = colLetter(idx);
    thL.title = c.col; thL.style.cursor = 'pointer';
    thL.onclick = () => irAColumna(c.col, idx);
    trL.appendChild(thL);

    const th = document.createElement('th');
    const inner = document.createElement('div'); inner.className = 'th-inner';
    const lbl = document.createElement('div');
    lbl.className = 'th-label' + (sortCol === c.col ? ' sorted-' + sortDir : '');
    lbl.innerHTML = `${escH(c.label)}<span class="sort-icon"></span>`;
    lbl.onclick = () => toggleSort(c.col);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'filter-input'; inp.placeholder = '🔍';
    inp.dataset.col = c.col; inp.value = filters[c.col] || '';
    inp.oninput = debounce(() => { filters[c.col] = inp.value; page = 1; load(); }, 400);
    inner.appendChild(lbl); inner.appendChild(inp); th.appendChild(inner); tr.appendChild(th);
  });

  // columna log
  const thLL = document.createElement('th'); thLL.textContent = ''; trL.appendChild(thLL);
  const thLog = document.createElement('th'); thLog.innerHTML = '<div class="th-inner"><div class="th-label">Log</div></div>'; tr.appendChild(thLog);

  thead.innerHTML = '';
  thead.appendChild(trL);
  thead.appendChild(tr);
}

/* ── Render rows ─────────────────────────────────────────────── */
function renderRows(rows) {
  const tbody = document.getElementById('ed-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="99" style="text-align:center;color:#94a3b8;padding:28px">Sin registros</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const rowId = r.id;
    const fijosTds = COLS_FIJAS.map(c => {
      if (c.edit) {
        return `<td data-field="${c.field}" data-id="${rowId}" data-col="${c.field}"><input type="text" value="${escH(String(r[c.field]??''))}" onchange="markMod(this)"></td>`;
      }
      const style = c.field === 'nombre_cliente' ? ' style="max-width:130px;overflow:hidden;text-overflow:ellipsis"' : '';
      return `<td data-field="${c.field}"${style}>${escH(r[c.field]||'')}</td>`;
    }).join('');

    const fzSet = parseForzados(r.campos_forzados);
    const editTds = camposVis().map(c => {
      const v = r[c.col];
      const stl = CALC.has(c.col) ? (fzSet.has(c.col) ? FORZADO_STYLE : CALC_STYLE) : '';
      if (c.tipo === 'select') {
        const opts = c.ops.map(o => `<option${v===o?' selected':''}>${escH(o)}</option>`).join('');
        return `<td data-field="${c.col}" data-id="${rowId}" data-col="${c.col}"><select onchange="markMod(this)" style="${stl}">${opts}</select></td>`;
      }
      const itype = c.tipo === 'date' ? 'date' : c.tipo === 'month' ? 'month' : 'text';
      const val = c.tipo === 'date' ? String(v||'').slice(0,10) : c.tipo === 'month' ? String(v||'').slice(0,7) : (v??'');
      return `<td data-field="${c.col}" data-id="${rowId}" data-col="${c.col}"><input type="${itype}" value="${escH(String(val))}" onchange="markMod(this)" style="${stl}"></td>`;
    }).join('');

    return `<tr id="row-${rowId}">
      <td style="white-space:nowrap">
        <button class="btn-save-row" id="save-${rowId}" onclick="guardarFila(${rowId})" title="Guardar cambios"><i class="bi bi-floppy"></i></button>
      </td>
      ${fijosTds}${editTds}
      <td><button class="btn-log-row" onclick="verLog(${rowId},'${escH(r.num_op||'')}')" title="Historial"><i class="bi bi-clock-history"></i></button></td>
    </tr>`;
  }).join('');
}

/* ── Pagination bar ──────────────────────────────────────────── */
function renderPag(total, pages, p) {
  const el = document.getElementById('ed-pag');
  let h = `<span>${(total||0).toLocaleString('es-CL')} registros · Página ${p} de ${pages||1}</span>`;
  if (p > 1)     h += `<button onclick="cargar(1)">«</button><button onclick="cargar(${p-1})">‹</button>`;
  h += `<button class="activo" disabled>${p}</button>`;
  if (p < pages) h += `<button onclick="cargar(${p+1})">›</button><button onclick="cargar(${pages})">»</button>`;
  el.innerHTML = h;
}

/* ── Load data ───────────────────────────────────────────────── */
async function load() {
  document.getElementById('ed-loading').style.display = 'block';
  const activeFilters = Object.fromEntries(Object.entries(filters).filter(([,v]) => v !== ''));
  const params = new URLSearchParams({ tipo: TIPO, page, sort: sortCol, dir: sortDir });
  if (Object.keys(activeFilters).length) params.set('filters', JSON.stringify(activeFilters));
  if (_soloForzados) params.set('solo_forzados', '1');
  try {
    const r = await fetch('/api/edicion-creditos?' + params, { headers: H });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    const first = !CAMPOS.length;
    CAMPOS = j.campos || [];
    CALC = new Set(j.calculados || []);
    if (first) buildHeaders();
    renderRows(j.data || []);
    const pg = j.pagination || {};
    renderPag(pg.total, pg.pages, pg.page);
  } catch (e) {
    document.getElementById('ed-tbody').innerHTML =
      `<tr><td colspan="99" style="text-align:center;color:#ef4444;padding:28px">${escH(e.message)}</td></tr>`;
  } finally {
    document.getElementById('ed-loading').style.display = 'none';
  }
}

function cargar(p) { page = p; load(); }

/* ── Sort ────────────────────────────────────────────────────── */
function toggleSort(col) {
  if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  else { sortCol = col; sortDir = 'asc'; }
  page = 1;
  buildHeaders();
  load();
}

/* ── Column navigation (BD Dios style) ───────────────────────── */
let _dropSel = -1;
function buscarColumna(q) {
  const dd = document.getElementById('colDropdown');
  _dropSel = -1;
  if (!q.trim()) { dd.innerHTML = ''; dd.style.display = 'none'; return; }
  const qlo = q.toLowerCase();
  const allCols = [
    ...COLS_FIJAS.map((c, i) => ({ field: c.field, label: c.label, idKey: 'fijo_' + i })),
    ...camposVis().map((c, i) => ({ field: c.col, label: c.label, idKey: String(COLS_FIJAS.length + i) }))
  ];
  const hits = allCols.filter(c => c.label.toLowerCase().includes(qlo) || c.field.toLowerCase().includes(qlo) || colLetter(parseInt(c.idKey.replace('fijo_','')) || 0).toLowerCase() === qlo);
  if (!hits.length) {
    dd.innerHTML = '<div style="padding:10px 14px;color:#9ca3af;font-size:.8rem">Sin resultados</div>';
    dd.style.display = 'block'; return;
  }
  dd.innerHTML = hits.map(h => `
    <div class="col-drop-item" data-field="${h.field}" data-key="${h.idKey}"
      style="padding:8px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;font-size:.83rem;border-bottom:1px solid #f3f4f6"
      onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''"
      onclick="irAColumna('${h.field}','${h.idKey}');document.getElementById('colSearch').value='${escH(h.label)}';document.getElementById('colDropdown').style.display='none'">
      <span style="background:#0141A2;color:#fff;border-radius:5px;padding:1px 7px;font-size:.72rem;font-weight:700;min-width:28px;text-align:center">${colLetter(h.idKey.startsWith('fijo_')?parseInt(h.idKey.replace('fijo_','')):parseInt(h.idKey))}</span>
      <span>${escH(h.label)}</span>
    </div>`).join('');
  dd.style.display = 'block';
}

function navColDropdown(e) {
  const items = document.querySelectorAll('.col-drop-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown')  { _dropSel = Math.min(_dropSel+1, items.length-1); highlightDrop(items); e.preventDefault(); }
  else if (e.key === 'ArrowUp')   { _dropSel = Math.max(_dropSel-1, 0); highlightDrop(items); e.preventDefault(); }
  else if (e.key === 'Enter' && _dropSel >= 0) { items[_dropSel].click(); e.preventDefault(); }
  else if (e.key === 'Escape') { document.getElementById('colDropdown').style.display = 'none'; }
}
function highlightDrop(items) {
  items.forEach((it, i) => it.style.background = i === _dropSel ? '#eff6ff' : '');
  if (_dropSel >= 0) items[_dropSel].scrollIntoView({ block: 'nearest' });
}

function irAColumna(field, idKey) {
  document.querySelectorAll('.tr-letters th').forEach(th => th.classList.remove('col-letter-highlight'));
  const lth = document.getElementById('colLetter_' + idKey);
  if (lth) lth.classList.add('col-letter-highlight');
  document.querySelectorAll('th.col-highlighted, td.col-highlighted').forEach(el => el.classList.remove('col-highlighted'));
  const ths = document.querySelectorAll('#ed-thead tr:last-child th');
  ths.forEach(th => { if (th.querySelector(`[data-col="${field}"], .th-label`) && th.querySelector('.th-inner')) {
    // encontrar por posición
  }});
  // highlight celdas de la columna
  document.querySelectorAll(`#ed-tbody td[data-field="${field}"]`).forEach(td => td.classList.add('col-highlighted'));
  // scroll
  const tableScroll = document.getElementById('tableScroll');
  const td0 = document.querySelector(`#ed-tbody td[data-field="${field}"]`);
  if (td0 && tableScroll) {
    const tRect = td0.getBoundingClientRect();
    const wRect = tableScroll.getBoundingClientRect();
    tableScroll.scrollTo({ left: tableScroll.scrollLeft + tRect.left - wRect.left - 80, behavior: 'smooth' });
  }
  setTimeout(() => {
    if (lth) lth.classList.remove('col-letter-highlight');
    document.querySelectorAll('th.col-highlighted, td.col-highlighted').forEach(el => el.classList.remove('col-highlighted'));
  }, 3000);
}

/* ── Inline edit ─────────────────────────────────────────────── */
function markMod(el) {
  const td = el.closest('td');
  const rowId = td.dataset.id;
  td.classList.add('modified');
  // Editar a mano un campo calculado lo deja forzado → feedback inmediato en rojo
  if (CALC.has(td.dataset.col)) { el.style.color = '#dc2626'; el.style.fontWeight = '700'; }
  window._MODS = window._MODS || {};
  window._MODS[rowId] = window._MODS[rowId] || {};
  window._MODS[rowId][td.dataset.col] = el.value;
  const btn = document.getElementById('save-' + rowId);
  if (btn) btn.classList.add('show');
}

async function guardarFila(rowId) {
  const cambios = (window._MODS || {})[rowId];
  if (!cambios || !Object.keys(cambios).length) return;
  const btn = document.getElementById('save-' + rowId);
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/edicion-creditos/' + rowId, {
      method: 'PUT', headers: H, body: JSON.stringify(cambios)
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    toast(`✓ ${j.data.campos_actualizados} campo(s) actualizado(s)`);
    delete window._MODS[rowId];
    document.querySelectorAll(`#row-${rowId} td.modified`).forEach(td => td.classList.remove('modified'));
    if (btn) { btn.classList.remove('show'); btn.disabled = false; }
  } catch (e) {
    toast(e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

/* ── Log modal ───────────────────────────────────────────────── */
async function verLog(rowId, numOp) {
  const r = await fetch('/api/edicion-creditos/' + rowId + '/log', { headers: H });
  const j = await r.json();
  const rows = j.data || [];
  const filas = rows.length
    ? rows.map(l => `<tr>
        <td>${escH(l.campo)}</td>
        <td>${escH(l.valor_antes??'—')}</td>
        <td>${escH(l.valor_despues??'—')}</td>
        <td>${escH(l.usuario)}</td>
        <td>${l.fecha ? new Date(l.fecha).toLocaleString('es-CL') : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px">Sin cambios registrados</td></tr>`;
  const overlay = document.createElement('div');
  overlay.className = 'log-overlay';
  overlay.innerHTML = `
    <div class="log-box">
      <div class="log-head"><span><i class="bi bi-clock-history me-2"></i>Historial — OP ${escH(numOp)}</span>
        <button onclick="this.closest('.log-overlay').remove()" style="background:none;border:none;color:#fff;font-size:1.1rem;cursor:pointer"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="log-body"><table>
        <thead><tr><th>Campo</th><th>Antes</th><th>Después</th><th>Usuario</th><th>Fecha</th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>
    </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

document.addEventListener('click', e => {
  if (!e.target.closest('#colSearchWrap')) {
    const dd = document.getElementById('colDropdown');
    if (dd) dd.style.display = 'none';
  }
});

// Botón "Solo forzados": filtra las operaciones con algún campo calculado forzado (rojo)
(function injectForzadosBtn() {
  const tb = document.querySelector('.toolbar');
  if (!tb || document.getElementById('btnForzados')) return;
  const b = document.createElement('button');
  b.id = 'btnForzados'; b.type = 'button';
  b.style.cssText = 'margin-left:auto;border:1px solid #fecaca;background:#fff;color:#dc2626;border-radius:8px;padding:6px 12px;font-size:.82rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px';
  b.innerHTML = '<i class="bi bi-flag-fill"></i> Solo forzados';
  b.onclick = () => {
    _soloForzados = !_soloForzados;
    b.style.background = _soloForzados ? '#dc2626' : '#fff';
    b.style.color = _soloForzados ? '#fff' : '#dc2626';
    page = 1; load();
  };
  tb.appendChild(b);
})();

load();
