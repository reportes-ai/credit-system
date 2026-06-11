'use strict';
const token = sessionStorage.getItem('token');
const yo = JSON.parse(sessionStorage.getItem('usuario') || 'null');
if (!token || !yo) location.href = '/login.html';

const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const TIPO = window.EDICION_TIPO || 'otorgados';

// Estado global
let CAMPOS = [], ROWS = [], MODS = {}, PAG = {}, sortCol = null, sortDir = 1;
let filtroQ = '', filtroLetra = '', filtroCampo = 'automotora', paginaActual = 1;
const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function logout() { sessionStorage.clear(); location.href = '/login.html'; }
document.getElementById('navNombre').textContent = yo.nombre + ' ' + (yo.apellido || '');
document.getElementById('navPerfil').textContent = yo.perfil || '';
document.getElementById('avatarInicial').textContent = (yo.nombre || '?')[0].toUpperCase();

function toast(msg, tipo = 'ok') {
  let t = document.getElementById('ed-toast');
  if (!t) { t = document.createElement('div'); t.id = 'ed-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = tipo;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.className = '', tipo === 'ok' ? 2500 : 4000);
}

const fmtCLP = v => v != null && v !== '' ? '$' + parseInt(v).toLocaleString('es-CL') : '';
const fmtF   = v => v ? String(v).slice(0, 10) : '';
const fmtM   = v => v ? String(v).slice(0, 7) : '';
const escH   = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Tipos numéricos y de fecha
const tiposNum = new Set(['number', 'decimal']);

async function cargar(page = 1) {
  paginaActual = page;
  const root = document.getElementById('appRoot');
  root.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8">Cargando…</div>';
  const params = new URLSearchParams({ tipo: TIPO, page });
  if (filtroQ)     params.set('q', filtroQ);
  if (filtroLetra) { params.set('letra', filtroLetra); params.set('campo', filtroCampo); }
  try {
    const r = await fetch('/api/edicion-creditos?' + params, { headers: H });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    CAMPOS = j.campos || [];
    ROWS = j.data || [];
    PAG = j.pagination || {};
    MODS = {};
    renderPage();
  } catch (e) {
    root.innerHTML = `<div style="text-align:center;color:#ef4444;padding:40px">${escH(e.message)}</div>`;
  }
}

function renderPage() {
  const root = document.getElementById('appRoot');

  // Filtros sticky
  const letrasBtns = LETRAS.map(l =>
    `<button class="btn-af-sm${filtroLetra === l ? ' on' : ''}" onclick="setLetra('${l}')">${l}</button>`
  ).join('') + `<button class="btn-af-sm${filtroLetra === '' ? ' on' : ''}" onclick="setLetra('')">✕</button>`;

  const camposOpts = CAMPOS.filter(c => c.tipo === 'text' || c.tipo === 'select')
    .map(c => `<option value="${escH(c.col)}"${filtroCampo === c.col ? ' selected' : ''}>${escH(c.label)}</option>`).join('');

  const html = `
  <div class="filtros-bar">
    <input type="text" id="fQ" value="${escH(filtroQ)}" placeholder="Buscar OP, dealer, ejecutivo, patente…" oninput="filtroQ=this.value" onkeydown="if(event.key==='Enter')cargar(1)">
    <button class="btn-af" onclick="cargar(1)"><i class="bi bi-search me-1"></i>Buscar</button>
    <label style="font-size:.73rem;font-weight:700;color:#475569;margin:0">Columna:</label>
    <select onchange="filtroCampo=this.value;if(filtroLetra)cargar(1)">${camposOpts}</select>
    <div class="letras-bar">${letrasBtns}</div>
    <span class="contador">${PAG.total?.toLocaleString('es-CL') || 0} registros</span>
  </div>
  <div class="wrap">
    <table class="ed-tbl">
      <thead><tr>
        <th style="width:32px"></th>
        <th onclick="sortBy('num_op')" class="${sortCol==='num_op'?'sorted-'+sortStr():''}">N° Op</th>
        <th onclick="sortBy('numero_credito')" class="${sortCol==='numero_credito'?'sorted-'+sortStr():''}">N° Crédito</th>
        <th>Cliente</th>
        <th>RUT</th>
        ${CAMPOS.map(c => `<th onclick="sortBy('${c.col}')" class="${sortCol===c.col?'sorted-'+sortStr():''}">${escH(c.label)}</th>`).join('')}
        <th>Log</th>
      </tr></thead>
      <tbody id="tbody">${renderRows()}</tbody>
    </table>
  </div>
  <div class="pag" id="pag">${renderPag()}</div>
  <div id="ed-toast" style="display:none"></div>
  `;
  root.innerHTML = html;
}

function sortStr() { return sortDir === 1 ? 'asc' : 'desc'; }
function sortBy(col) {
  if (sortCol === col) sortDir = -sortDir; else { sortCol = col; sortDir = 1; }
  ROWS.sort((a, b) => {
    const va = a[col] ?? ''; const vb = b[col] ?? '';
    return String(va).localeCompare(String(vb), 'es', { numeric: true }) * sortDir;
  });
  document.getElementById('tbody').innerHTML = renderRows();
  // Actualizar clases de th
  document.querySelectorAll('.ed-tbl thead th').forEach(th => {
    th.className = th.textContent.includes(col) ? 'sorted-' + sortStr() : '';
  });
}

function setLetra(l) {
  filtroLetra = l;
  cargar(1);
}

function renderRows() {
  if (!ROWS.length) return `<tr><td colspan="99" style="text-align:center;color:#94a3b8;padding:24px">Sin registros</td></tr>`;
  return ROWS.map(r => {
    const rowId = r.id;
    const cells = CAMPOS.map(c => {
      const v = r[c.col];
      const key = `${rowId}__${c.col}`;
      if (c.tipo === 'select') {
        const opts = c.ops.map(o => `<option${v === o ? ' selected' : ''}>${escH(o)}</option>`).join('');
        return `<td data-key="${key}" data-id="${rowId}" data-col="${c.col}"><select onchange="markMod(this)">${opts}</select></td>`;
      }
      const inputType = c.tipo === 'date' ? 'date' : c.tipo === 'month' ? 'month' : 'text';
      const valFmt = c.tipo === 'date' ? fmtF(v) : c.tipo === 'month' ? fmtM(v) : (v ?? '');
      return `<td data-key="${key}" data-id="${rowId}" data-col="${c.col}"><input type="${inputType}" value="${escH(String(valFmt))}" onchange="markMod(this)"></td>`;
    }).join('');
    return `<tr id="row-${rowId}">
      <td style="white-space:nowrap">
        <button class="btn-save-row" id="save-${rowId}" onclick="guardarFila(${rowId})"><i class="bi bi-floppy"></i></button>
      </td>
      <td class="fijo">${escH(r.num_op || '')}</td>
      <td class="fijo">${escH(r.numero_credito_display || '')}</td>
      <td class="fijo" style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${escH(r.nombre_cliente || '')}</td>
      <td class="fijo">${escH(r.rut_cliente || '')}</td>
      ${cells}
      <td><button class="btn-log-row" onclick="verLog(${rowId},'${escH(r.num_op||'')}')" title="Ver historial"><i class="bi bi-clock-history"></i></button></td>
    </tr>`;
  }).join('');
}

function renderPag() {
  const { page, pages, total } = PAG;
  if (!pages || pages <= 1) return `<span>${(total||0).toLocaleString('es-CL')} registros</span>`;
  let h = `<span>Página ${page} de ${pages} (${(total||0).toLocaleString('es-CL')})</span>`;
  if (page > 1)    h += `<button onclick="cargar(1)">«</button><button onclick="cargar(${page-1})">‹</button>`;
  h += `<button class="activo" disabled>${page}</button>`;
  if (page < pages) h += `<button onclick="cargar(${page+1})">›</button><button onclick="cargar(${pages})">»</button>`;
  return h;
}

function markMod(el) {
  const td = el.closest('td');
  const rowId = td.dataset.id;
  const col   = td.dataset.col;
  td.classList.add('modified');
  MODS[rowId] = MODS[rowId] || {};
  MODS[rowId][col] = el.tagName === 'SELECT' ? el.value : el.value;
  const btn = document.getElementById('save-' + rowId);
  if (btn) btn.classList.add('show');
}

async function guardarFila(rowId) {
  const cambios = MODS[rowId];
  if (!cambios || !Object.keys(cambios).length) return;
  const btn = document.getElementById('save-' + rowId);
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/edicion-creditos/' + rowId, {
      method: 'PUT', headers: H, body: JSON.stringify(cambios)
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    toast(`✓ Crédito actualizado (${j.data.campos_actualizados} campo${j.data.campos_actualizados > 1 ? 's' : ''})`);
    delete MODS[rowId];
    // Limpiar marcas modified en la fila
    document.querySelectorAll(`#row-${rowId} td.modified`).forEach(td => td.classList.remove('modified'));
    if (btn) { btn.classList.remove('show'); btn.disabled = false; }
  } catch (e) {
    toast(e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

async function verLog(rowId, numOp) {
  const r = await fetch('/api/edicion-creditos/' + rowId + '/log', { headers: H });
  const j = await r.json();
  const rows = j.data || [];
  const filas = rows.length
    ? rows.map(l => `<tr>
        <td>${escH(l.campo)}</td>
        <td>${escH(l.valor_antes ?? '—')}</td>
        <td>${escH(l.valor_despues ?? '—')}</td>
        <td>${escH(l.usuario)}</td>
        <td>${l.fecha ? new Date(l.fecha).toLocaleString('es-CL') : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px">Sin cambios registrados</td></tr>`;

  const overlay = document.createElement('div');
  overlay.className = 'log-overlay';
  overlay.innerHTML = `
    <div class="log-box">
      <div class="log-head">
        <span><i class="bi bi-clock-history me-2"></i>Historial — OP ${escH(numOp)}</span>
        <button onclick="this.closest('.log-overlay').remove()" style="background:none;border:none;color:#fff;font-size:1.1rem;cursor:pointer"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="log-body">
        <table>
          <thead><tr><th>Campo</th><th>Antes</th><th>Después</th><th>Usuario</th><th>Fecha</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// Arrancar
cargar(1);
