function getToken() { return sessionStorage.getItem('token'); }
function apiHdr()   { return { 'Content-Type':'application/json', 'Authorization':'Bearer '+getToken() }; }
function logout()   { sessionStorage.removeItem('token'); sessionStorage.removeItem('usuario'); location.href='/login.html'; }


/* ─── Utils ─────────────────────────────────────────────────────────── */
function upperInputCred(el) { const s=el.selectionStart, e=el.selectionEnd; el.value=el.value.toUpperCase(); el.setSelectionRange(s,e); }
function fmtPeso(v) { return v!=null && v!=='' && v!==0 ? '$'+Math.round(Number(v)).toLocaleString('es-CL') : '—'; }

/* ─── Validador de Patente (LLLLNN) ─────────────────────────────────── */
const PATENTE_RE = /^[A-Z]{4}[0-9]{2}$/;
function patenteInput(el) {
  el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const hint = document.getElementById('patenteHint');
  el.classList.remove('patente-ok','patente-err');
  if (el.value.length === 0) { hint.textContent = ''; hint.className = 'patente-hint'; return; }
  if (PATENTE_RE.test(el.value)) {
    el.classList.add('patente-ok');
    hint.textContent = '✓ Formato válido';
    hint.className = 'patente-hint ok';
  } else {
    el.classList.add('patente-err');
    const letras = el.value.replace(/[^A-Z]/g,'').length;
    const nums   = el.value.replace(/[^0-9]/g,'').length;
    hint.textContent = letras < 4 ? `Faltan ${4-letras} letra(s)` : nums < 2 ? `Faltan ${2-nums} número(s)` : 'Formato: ABCD12';
    hint.className = 'patente-hint err';
  }
}
function patenteBlur(el) { patenteInput(el); }

/* ─── Dealer autocomplete ─────────────────────────────────────────────── */
let _dealerTimer = null;
function dealerBuscar(el) {
  clearTimeout(_dealerTimer);
  document.getElementById('iDealer').value   = '';
  document.getElementById('iDealerId').value = '';
  const q = el.value.trim();
  if (q.length < 2) { document.getElementById('iDealerDrop').classList.remove('open'); return; }
  _dealerTimer = setTimeout(async () => {
    const r = await fetch('/api/dealers?q=' + encodeURIComponent(q) + '&limit=20', { headers: apiHdr() });
    const j = await r.json();
    const drop = document.getElementById('iDealerDrop');
    if (!j.success || !j.data.rows.length) {
      drop.innerHTML = '<div class="dealer-item"><span class="di-sub">Sin resultados</span></div>';
    } else {
      drop.innerHTML = j.data.rows.map(d => {
        const parque = d.ccs_parque ? `<span class="di-sub">Parque ${d.ccs_parque}</span>` : `<span class="di-sub">Calle</span>`;
        return `<div class="dealer-item" onmousedown="dealerSeleccionar(${d.id_dealer},'${(d.nombre_indexa||d.nombre_razon||'').replace(/'/g,"\\'")}','${(d.ccs_parque||'').replace(/'/g,"\\'")}')">
          <div class="di-name">${d.nombre_indexa || d.nombre_razon}</div>${parque}
        </div>`;
      }).join('');
    }
    drop.classList.add('open');
  }, 280);
}
function dealerSeleccionar(id, nombre, parque) {
  document.getElementById('iDealerBuscar').value = nombre;
  document.getElementById('iDealer').value       = nombre;
  document.getElementById('iDealerId').value     = id;
  document.getElementById('iDealerDrop').classList.remove('open');
  // Auto-completar ubicación desde ccs_parque del dealer
  if (parque && parque.toUpperCase() !== 'PARTICULAR') {
    setUbicacion('PARQUE');
    document.getElementById('iNombreParque').value = parque;
  } else {
    setUbicacion('CALLE');
  }
}
function dealerBlur() {
  setTimeout(() => document.getElementById('iDealerDrop').classList.remove('open'), 200);
  // Si hay texto pero no se seleccionó de la lista, igual guardar el texto
  const buscar = document.getElementById('iDealerBuscar').value.trim();
  if (buscar && !document.getElementById('iDealer').value) {
    document.getElementById('iDealer').value = buscar;
  }
}

/* ─── Ubicación Parque / Calle ───────────────────────────────────────── */
function setUbicacion(tipo) {
  document.getElementById('iTipoUbicacion').value = tipo;
  document.getElementById('btnUbicParque').className = 'ubic-btn' + (tipo==='PARQUE'?' active-parque':'');
  document.getElementById('btnUbicCalle').className  = 'ubic-btn' + (tipo==='CALLE'?' active-calle':'');
  const parqueInput = document.getElementById('iNombreParque');
  parqueInput.style.display = tipo === 'PARQUE' ? 'block' : 'none';
  if (tipo !== 'PARQUE') parqueInput.value = '';
}

/* ─── Cascada de vehículos ───────────────────────────────────────────── */
async function vehApiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const r  = await fetch('/api/vehiculos/cascada?' + qs, { headers: apiHdr() });
  return r.json();
}

function fillSelect(id, opciones, placeholder, enabled) {
  const el = document.getElementById(id);
  el.innerHTML = `<option value="">— ${placeholder} —</option>` +
    opciones.map(o => `<option value="${o}">${o}</option>`).join('');
  el.disabled = !enabled;
}

async function vehCargaModelos() {
  const marca = document.getElementById('iMarca').value;
  // Resetear los selects dependientes
  fillSelect('iModelo',     [], 'Seleccione marca', false);
  fillSelect('iAnio',       [], '—',                false);
  fillSelect('iTransmision',[], 'seleccione año',   false);
  fillSelect('iCombustible',[], 'seleccione año',   false);
  document.getElementById('iTasacion').value = '';
  document.getElementById('iPermiso').value  = '';
  if (!marca) return;
  const j = await vehApiGet({ marca });
  if (j.success) fillSelect('iModelo', j.data.modelos, 'Seleccione modelo', true);
}

async function vehCargaAnios() {
  const marca  = document.getElementById('iMarca').value;
  const modelo = document.getElementById('iModelo').value;
  fillSelect('iAnio',       [], '—',              false);
  fillSelect('iTransmision',[], 'seleccione año', false);
  fillSelect('iCombustible',[], 'seleccione año', false);
  document.getElementById('iTasacion').value = '';
  document.getElementById('iPermiso').value  = '';
  if (!marca || !modelo) return;
  const j = await vehApiGet({ marca, modelo });
  if (j.success) fillSelect('iAnio', j.data.anios, 'Seleccione año', true);
}

async function vehCargaDetalle() {
  const marca  = document.getElementById('iMarca').value;
  const modelo = document.getElementById('iModelo').value;
  const anio   = document.getElementById('iAnio').value;
  fillSelect('iTransmision',[], 'seleccione año', false);
  fillSelect('iCombustible',[], 'seleccione año', false);
  document.getElementById('iTasacion').value = '';
  document.getElementById('iPermiso').value  = '';
  if (!marca || !modelo || !anio) return;
  const j = await vehApiGet({ marca, modelo, anio });
  if (j.success && j.data) {
    const d = j.data;
    fillSelect('iTransmision', d.transmisiones, 'Seleccione', !!d.transmisiones.length);
    fillSelect('iCombustible', d.combustibles,  'Seleccione', !!d.combustibles.length);
    // Si solo hay una opción, preseleccionar
    if (d.transmisiones.length === 1) document.getElementById('iTransmision').value = d.transmisiones[0];
    if (d.combustibles.length  === 1) document.getElementById('iCombustible').value  = d.combustibles[0];
    document.getElementById('iTasacion').value = d.tasacion ? fmtPeso(d.tasacion) : '';
    document.getElementById('iPermiso').value  = d.permiso  ? fmtPeso(d.permiso)  : '';
  }
}

// Carga marcas al inicio
async function vehCargaMarcas() {
  const j = await vehApiGet({});
  if (j.success) fillSelect('iMarca', j.data.marcas, 'Seleccione marca', true);
}

// Restaura los selects en cascada al cargar un crédito existente
async function vehRestaurar(marca, modelo, anio, transmision, combustible) {
  if (!marca) return;
  const jM = await vehApiGet({});
  if (jM.success) {
    fillSelect('iMarca', jM.data.marcas, 'Seleccione marca', true);
    document.getElementById('iMarca').value = marca;
  }
  if (!modelo) return;
  const jMod = await vehApiGet({ marca });
  if (jMod.success) {
    fillSelect('iModelo', jMod.data.modelos, 'Seleccione modelo', true);
    document.getElementById('iModelo').value = modelo;
  }
  if (!anio) return;
  const jA = await vehApiGet({ marca, modelo });
  if (jA.success) {
    fillSelect('iAnio', jA.data.anios, 'Seleccione año', true);
    document.getElementById('iAnio').value = anio;
  }
  const jD = await vehApiGet({ marca, modelo, anio });
  if (jD.success && jD.data) {
    const d = jD.data;
    fillSelect('iTransmision', d.transmisiones, 'Seleccione', !!d.transmisiones.length);
    fillSelect('iCombustible', d.combustibles,  'Seleccione', !!d.combustibles.length);
    if (transmision) document.getElementById('iTransmision').value = transmision;
    if (combustible) document.getElementById('iCombustible').value = combustible;
    document.getElementById('iTasacion').value = d.tasacion ? fmtPeso(d.tasacion) : '';
    document.getElementById('iPermiso').value  = d.permiso  ? fmtPeso(d.permiso)  : '';
  }
}
function showToast(msg, ok) {
  const el = document.getElementById(ok ? 'toastOk' : 'toastErr');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => el.style.display='none', 3500);
}

/* ─── Modo Edición ─────────────────────────────────────────────────── */
let _modoEditar = null;   // id_credito si estamos editando, null si es ingreso nuevo
let _modoEditarNumero = null; // numero_credito para mostrar en banner

/* ─── Tabs ─────────────────────────────────────────────────────────── */
let _tabActual = 'consulta';

function cambiarTab(tab) {
  _tabActual = tab;
  document.querySelectorAll('.tab-card[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  // En ingreso: si hay alguna fin-card activa la usamos como empresa seleccionada,
  // sino auto-seleccionamos la primera
  if (tab === 'ingreso') {
    const activa = document.querySelector('.fin-card.active');
    const empresa = activa ? activa.dataset.empresa : null;
    // Brokerage: redirigir directamente a su formulario específico
    if (empresa === 'AUTOFIN') { window.location.href = '/creditos/digitacion-autofin'; return; }
    if (empresa === 'UNIDAD')  { window.location.href = '/creditos/digitacion-unidad';  return; }
    if (activa) {
      _setEmpresaIngreso(empresa);
    } else {
      // Sin selección: auto-seleccionar AutoFácil
      const autofacil = document.querySelector('.fin-card[data-empresa="AUTOFACIL"]');
      if (autofacil) { autofacil.classList.add('active'); _setEmpresaIngreso('AUTOFACIL'); }
    }
  }
}

/* ─── Financieras (multi-toggle filtro / selector ingreso) ─────────── */
let _empresasFiltro = new Set(); // vacío = todas

function toggleFinanciera(el) {
  const empresa = el.dataset.empresa;
  if (_tabActual === 'ingreso') {
    // Brokerage: AutoFin y Unidad tienen su propio formulario diferenciado
    if (empresa === 'AUTOFIN')  { window.location.href = '/creditos/digitacion-autofin';  return; }
    if (empresa === 'UNIDAD')   { window.location.href = '/creditos/digitacion-unidad';   return; }
    if (empresa === 'CFC')      { alert('CFC es una financiera de brokerage en preparación. Por ahora está disponible solo como filtro de consulta.'); return; }
    if (empresa === 'AFA')      { alert('AFA (Auto Fácil Ahora) es una financiera en preparación. Por ahora está disponible solo como filtro de consulta.'); return; }
    // AutoFácil: formulario integrado en esta página
    document.querySelectorAll('.fin-card').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    _setEmpresaIngreso(empresa);
  } else {
    // Modo consulta: multi-toggle
    el.classList.toggle('active');
    if (_empresasFiltro.has(empresa)) _empresasFiltro.delete(empresa);
    else                              _empresasFiltro.add(empresa);
    aplicarFiltroEmpresa();
  }
}

function _setEmpresaIngreso(empresa) {
  document.getElementById('iEmpresa').value = empresa;
  const selFin = document.getElementById('iFinanciera');
  if (selFin) {
    if (selFin.options) { const opt = Array.from(selFin.options).find(o => o.value === empresa); if (opt) selFin.value = empresa; }
    else selFin.value = empresa;   // input hidden (página solo AutoFácil)
  }
}

function sincronizarEmpresaCard(empresa) {
  document.getElementById('iEmpresa').value = empresa;
  document.querySelectorAll('.fin-card').forEach(c => c.classList.toggle('active', c.dataset.empresa === empresa));
}

/* Filtra lista por empresas seleccionadas (sin filtro estado) */
function _filtrarPorEmpresa(lista) {
  if (_empresasFiltro.size === 0) return lista;
  return lista.filter(c => {
    const fin = (c.financiera || c.empresa || 'AUTOFACIL').toUpperCase().replace(/[^A-Z]/g,'');
    return [..._empresasFiltro].some(f => fin.includes(f.replace(/[^A-Z]/g,'')));
  });
}

function aplicarFiltroEmpresa() {
  buscarCreditos(1);
}
function _aplicarFiltroEmpresaLocal() {
  const baseEmpresa = _filtrarPorEmpresa(_todosCreditos);
  const lista = _filtroProceso
    ? baseEmpresa.filter(c => !ESTADOS_FUERA_PROCESO.has(c.estado))
    : _aplicarFiltroEstado(baseEmpresa);
  renderConsulta(lista);
}

/* backward-compat (sincronizarEmpresaCard se llama desde iFinanciera.onchange) */
function seleccionarEmpresa(el) { toggleFinanciera(el); }

/* ─── RUT formatter ─────────────────────────────────────────────────── */
function formatRUT(raw) {
  let c = raw.replace(/[^0-9kK]/g,'').toUpperCase();
  if (c.length < 2) return c;
  const dv=c.slice(-1), body=c.slice(0,-1);
  let fmt='';
  for (let i=body.length; i>0; i-=3) fmt=body.slice(Math.max(0,i-3),i)+(fmt?'.'+fmt:'');
  return fmt+'-'+dv;
}
// Dígito verificador (módulo 11) — misma lógica que el resto de las páginas
function calcDV(body) {
  const digits = String(body).replace(/\D/g,'');
  if (!digits) return null;
  const serie = [2,3,4,5,6,7];
  const suma = digits.split('').reverse().reduce((a,d,i)=>a + parseInt(d)*serie[i%6], 0);
  const resto = 11 - (suma % 11);
  return resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
}
// true = válido, false = DV incorrecto, null = incompleto
function validarRUT(clean) {
  clean = String(clean).replace(/[^0-9kK]/g,'').toUpperCase();
  if (clean.length < 7 || clean.length > 9) return null;
  return calcDV(clean.slice(0,-1)) === clean.slice(-1).toUpperCase();
}
function onRutInputCred(el) {
  const c=el.value.replace(/[^0-9kK]/g,'').toUpperCase();
  if (c.length>=2) el.value=formatRUT(el.value);
  const hint=document.getElementById('iRutHint');
  const v=validarRUT(c);
  if (v===true)      { el.style.borderColor='#059669'; if(hint){hint.style.color='#059669'; hint.textContent='✓ RUT válido';} }
  else if (v===false){ el.style.borderColor='#dc2626'; if(hint){hint.style.color='#dc2626'; hint.textContent='✗ Dígito verificador incorrecto (debería ser '+calcDV(c.slice(0,-1))+')';} }
  else if (c.length>0){ el.style.borderColor=''; if(hint){hint.style.color='#9ca3af'; hint.textContent='Ingresa el RUT completo con dígito verificador';} }
  else               { el.style.borderColor=''; if(hint) hint.textContent=''; }
}

/* ═══════════════════════════════════════════════════════════════════
   CONSULTA CRÉDITOS
═══════════════════════════════════════════════════════════════════ */
let _todosCreditos = [];   // lista completa (sin filtro estado)
let _filtroProceso = false;
let _filtroSinEstado = false;   // Estados → "Sin Estado" (créditos sin estado de cartera = Brokerage)

// Estados que se consideran "terminales" o activos (NO son "en proceso")
const ESTADOS_FUERA_PROCESO = new Set(['VIGENTE','CANCELADO','PREPAGADO','CASTIGADO','EN MORA','OTORGADO','CURSADO','DESISTIDO']);
// Estados del nuevo flujo AutoFácil
const LABEL_ESTADO = {
  INGRESO:'Ingresado', REVISION:'Ingresado',
  CARGA_RESPALDOS:'Carga Respaldos',
  EN_ANALISIS:'En Análisis',
  CARTA_APROBACION:'Carta Aprobación',
  EMISION_DOCUMENTOS:'Emisión Documentos',
  CARGA_DOCUMENTOS_AF:'Carga Docs. AF',
  VALIDACION_FIRMA:'Validación Firma',
  VIGENTE:'Vigente', 'EN MORA':'En Mora',
  CANCELADO:'Cancelado', PREPAGADO:'Prepagado', CASTIGADO:'Castigado',
  OTORGADO:'Otorgado', CURSADO:'Cursado', DESISTIDO:'Desistido',
};

/* ── Lógica de mora real (igual que cobranza) ── */
function _cuotasVencidas(c) {
  if (!c.fecha_primera_cuota) return 0;
  const fp  = new Date(c.fecha_primera_cuota);
  const hoy = new Date();
  const diff = (hoy.getFullYear() - fp.getFullYear()) * 12 + (hoy.getMonth() - fp.getMonth());
  const ajuste = hoy.getDate() >= fp.getDate() ? 1 : 0;
  return Math.min(Number(c.plazo) || 0, Math.max(0, diff + ajuste));
}
function _enMoraReal(c) {
  // Solo cartera propia (tiene estado_cartera); brokerage → null → no aplica.
  if (!c.estado_cartera) return false;
  // null = importado sin tracking de pagos → mora no aplica
  if (c.cuotas_pagadas === null || c.cuotas_pagadas === undefined) return false;
  return (_cuotasVencidas(c) - Number(c.cuotas_pagadas || 0)) > 0;
}

/* ── Filtro client-side por estado ── */
const _CART_ESTADOS = ['VIGENTE','EN MORA','VENCIDO','TERMINADO','PREPAGADO','CASTIGADO'];
const _cartUp = e => { const u = String(e || '').toUpperCase(); return u === 'MORA' ? 'EN MORA' : u; };
function _aplicarFiltroEstado(lista) {
  const estado = document.getElementById('searchEstado').value;
  if (!estado) return lista;
  // Estados de cartera → por el estado VIVO ya calculado (estado_cartera), no por la etapa.
  if (_CART_ESTADOS.includes(estado)) return lista.filter(c => _cartUp(c.estado_cartera) === estado);
  if (estado === '__PROCESO__') return lista.filter(c => !ESTADOS_FUERA_PROCESO.has(c.estado));
  return lista.filter(c => c.estado === estado);
}

let _paginaActual = 1;
const _LIMIT_PAG  = 100;
let _lastStats = {};
let _lastTotal  = 0;
let _sortColCred = '';      // columna de orden (vacío = orden por defecto: mes/id desc)
let _sortDirCred = 'desc';

function toggleSortCred(col) {
  if (_sortColCred === col) _sortDirCred = (_sortDirCred === 'asc') ? 'desc' : 'asc';
  else { _sortColCred = col; _sortDirCred = 'asc'; }
  buscarCreditos(1);
}
function limpiarRangoFecha() {
  const a = document.getElementById('searchFDesde'), b = document.getElementById('searchFHasta');
  if (a) a.value = ''; if (b) b.value = '';
  const m = document.getElementById('searchMes'); if (m) m.value = '';
  buscarCreditos(1);
}

/* ── Filtro por mes (rellena el rango de fecha de otorgamiento) ── */
const _MESES_NOM = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function llenarMeses() {
  const sel = document.getElementById('searchMes'); if (!sel) return;
  const now = new Date(); let html = '<option value="">Todos los meses</option>';
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    html += `<option value="${ym}">${_MESES_NOM[d.getMonth()]} ${d.getFullYear()}</option>`;
  }
  sel.innerHTML = html;
}
function filtrarPorMes() {
  const v = document.getElementById('searchMes').value;
  const fd = document.getElementById('searchFDesde'), fh = document.getElementById('searchFHasta');
  if (!v) { if (fd) fd.value = ''; if (fh) fh.value = ''; }
  else {
    const [y, m] = v.split('-').map(Number);
    const ultimo = new Date(y, m, 0).getDate();   // último día del mes
    if (fd) fd.value = `${v}-01`;
    if (fh) fh.value = `${v}-${String(ultimo).padStart(2, '0')}`;
  }
  buscarCreditos(1);
}

/* Exportar a Excel TODOS los casos que cumplen los filtros actuales
   (misma query que la búsqueda, paginando el servidor hasta traer todo). */
async function exportarCreditosExcel() {
  const btn = document.getElementById('btnExpXls');
  const txt = btn.innerHTML;
  btn.disabled = true;
  try {
    if (!window.XLSX) await new Promise((okL, badL) => {
      const s = document.createElement('script');
      s.src = '/js/xlsx.full.min.js'; s.onload = okL; s.onerror = badL;
      document.head.appendChild(s);
    });
    // mismos filtros que buscarCreditos()
    const base = new URLSearchParams({ limit: 500 });
    const q = document.getElementById('searchQ').value.trim();
    if (q) base.set('q', q);
    if (_empresasFiltro.size === 1) base.set('financiera', [..._empresasFiltro][0]);
    const fDesde = document.getElementById('searchFDesde')?.value || '';
    const fHasta = document.getElementById('searchFHasta')?.value || '';
    if (fDesde) base.set('fecha_desde', fDesde);
    if (fHasta) base.set('fecha_hasta', fHasta);
    if (_sortColCred) { base.set('sort', _sortColCred); base.set('dir', _sortDirCred); }
    const estadoSel = document.getElementById('searchEstado').value;
    if (_filtroProceso) base.set('estado', '__PROCESO__');
    else if (_filtroSinEstado) base.set('estado', '__SIN_ESTADO__');
    else if (estadoSel) base.set('estado', estadoSel);

    let rows = [], page = 1, pages = 1;
    do {
      base.set('page', page);
      btn.innerHTML = `<i class="bi bi-hourglass-split me-1"></i>Exportando… ${rows.length.toLocaleString('es-CL')}`;
      const r = await fetch('/api/creditos?' + base, { headers: apiHdr() });
      const j = await r.json();
      if (!j.success) throw new Error(j.error);
      rows = rows.concat(_filtrarPorEmpresa(j.data || []));
      pages = j.pagination?.pages || 1;
      page++;
    } while (page <= pages && page <= 200);   // tope defensivo 100.000 filas

    const fmtF = s => s ? String(s).slice(0, 10) : '';
    const out = rows.map(c => ({
      'N° OP': c.numero_credito || '', 'RUT': c.rut_cliente || '', 'Cliente': c.nombre_cliente || '',
      'Financiera': c.financiera || '', 'ID Financiera': c.id_financiera || '',
      'Fecha': fmtF(c.fecha_otorgamiento || c.created_at), 'Monto Financiado': +c.monto_financiado || 0,
      'Marca': c.marca || '', 'Modelo': c.modelo || '', 'Año': c.anio || '', 'Patente': c.patente || '',
      'Cuota': +c.cuota || 0, 'Plazo': c.plazo || '', 'Etapa': c.estado || '',
      'Estado Cartera': c.estado_cartera || '', 'Días Atraso': c.dias_atraso || '',
      'Dealer': c.dealer || '', 'Ejecutivo': c.ejecutivo || '',
    }));
    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'creditos');
    XLSX.writeFile(wb, `creditos_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) { alert('Error al exportar: ' + e.message); }
  btn.disabled = false; btn.innerHTML = txt;
}

async function buscarCreditos(page = 1) {
  _paginaActual = page;
  const q = document.getElementById('searchQ').value.trim();
  const res = document.getElementById('resultadosConsulta');
  res.innerHTML = '<div class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Buscando…</div>';
  try {
    const estadoSel = document.getElementById('searchEstado').value;
    const params = new URLSearchParams({ page, limit: _LIMIT_PAG });
    if (q) params.set('q', q);
    if (_empresasFiltro.size === 1) params.set('financiera', [..._empresasFiltro][0]);
    const fDesde = document.getElementById('searchFDesde')?.value || '';
    const fHasta = document.getElementById('searchFHasta')?.value || '';
    if (fDesde) params.set('fecha_desde', fDesde);
    if (fHasta) params.set('fecha_hasta', fHasta);
    if (_sortColCred) { params.set('sort', _sortColCred); params.set('dir', _sortDirCred); }
    // Estado: server-side (paginación correcta). EN MORA es calculado → client-side.
    if (_filtroProceso) params.set('estado', '__PROCESO__');
    else if (_filtroSinEstado) params.set('estado', '__SIN_ESTADO__');
    else if (estadoSel) params.set('estado', estadoSel);   // incl. cartera (VIGENTE/EN MORA/…) → server-side por estado vivo
    const r = await fetch('/api/creditos?' + params, { headers: apiHdr() });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    _todosCreditos = j.data || [];
    const pag   = j.pagination || {};
    const stats = j.stats      || {};

    // Stats desde servidor (desglose completo, sin importar el filtro de estado activo)
    _lastStats = stats;
    _lastTotal = (j.statsTotal != null ? j.statsTotal : pag.total) || 0;
    actualizarStats(_lastStats, _lastTotal);

    // El servidor ya filtró por estado/cartera (estado vivo) → solo se filtra por empresa.
    let baseEmpresa = _filtrarPorEmpresa(_todosCreditos);
    renderConsulta(baseEmpresa);
    renderPaginacion(pag);
  } catch(e) {
    res.innerHTML = `<div class="empty-state" style="color:#ef4444"><i class="bi bi-exclamation-triangle"></i>${e.message}</div>`;
  }
}

function renderPaginacion(pag) {
  let el = document.getElementById('pagCreditos');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pagCreditos';
    el.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 0;flex-wrap:wrap;font-size:.83rem';
    document.getElementById('resultadosConsulta').after(el);
  }
  if (!pag.pages || pag.pages <= 1) { el.innerHTML = ''; return; }
  const p = pag.page, total = pag.pages;
  const btnStyle = (activo) => `style="border:1px solid #d1d5db;border-radius:6px;padding:4px 10px;cursor:pointer;background:${activo?'#0141A2':'#fff'};color:${activo?'#fff':'#374151'};font-weight:${activo?'700':'400'}"`;
  let html = `<span style="color:#6b7280">Página ${p} de ${total} (${pag.total.toLocaleString('es-CL')} registros)</span>`;
  if (p > 1)     html += `<button ${btnStyle(false)} onclick="buscarCreditos(1)">«</button><button ${btnStyle(false)} onclick="buscarCreditos(${p-1})">‹</button>`;
  html += `<button ${btnStyle(true)} disabled>${p}</button>`;
  if (p < total) html += `<button ${btnStyle(false)} onclick="buscarCreditos(${p+1})">›</button><button ${btnStyle(false)} onclick="buscarCreditos(${total})">»</button>`;
  el.innerHTML = html;
}

function actualizarStats(stats, totalServidor) {
  // stats es el objeto {ESTADO: count} del servidor — totales reales
  const g = (e) => (stats[e] || 0);
  const ingresados = g('INGRESO') + g('REVISION');
  // Formato es-CL: punto = miles (conteos enteros, sin decimales). Ver feedback_formato_numeros.
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (typeof v === 'number') ? v.toLocaleString('es-CL') : v; };
  set('statTotal', totalServidor || 0); set('statTotalEt', totalServidor || 0);
  // Etapas (originación)
  set('statDigitado', g('DIGITADO'));
  set('statRevision', ingresados);
  set('statAprobado', g('APROBADO'));
  set('statCartaAprobacion', g('CARTA_APROBACION'));
  set('statOtorgados', g('OTORGADO'));   // "Cursado" de AutoFin = nuestro Otorgado
  set('statRechazados', g('CANCELADO'));   // CANCELADO = rechazados + anulados
  set('statDesistidos', g('DESISTIDO'));
  set('statPrepagadoEt', g('PREPAGADO'));
  set('statAnulado', g('ANULADO'));
  // Estados (cartera)
  set('statVigentes', g('VIGENTE'));
  set('statMora', g('EN MORA') || 0);
  set('statVencido', g('VENCIDO'));
  set('statTerminado', g('TERMINADO'));
  set('statPrepagado', g('PREPAGADO'));
  set('statCastigado', g('CASTIGADO'));
  // "Sin Estado" = sin estado de cartera (los de Brokerage) → hace cuadrar la fila con el Total.
  const carteraSum = g('VIGENTE') + (g('EN MORA') || 0) + g('VENCIDO') + g('TERMINADO') + g('PREPAGADO') + g('CASTIGADO');
  set('statSinEstado', Math.max(0, (totalServidor || 0) - carteraSum));
  // Resaltar badge ingresados
  const chipRev = document.querySelector('.stat-revision');
  if (chipRev) chipRev.classList.toggle('con-pendientes', ingresados > 0);
  const chipPro = document.getElementById('chipProceso');
  if (chipPro) chipPro.classList.toggle('activo', _filtroProceso);
}

function filtrarPorEstado(estado) {
  _filtroSinEstado = (estado === '__SIN_ESTADO__');
  if (estado === '__PROCESO__') {
    _filtroProceso = true;
    document.getElementById('searchEstado').value = '';
  } else {
    _filtroProceso = false;
    document.getElementById('searchEstado').value = _filtroSinEstado ? '' : estado;
  }
  const chipPro = document.getElementById('chipProceso');
  if (chipPro) chipPro.classList.toggle('activo', _filtroProceso);
  buscarCreditos(1);
}

function renderConsulta(list) {
  const res = document.getElementById('resultadosConsulta');
  if (!list.length) {
    res.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i>Sin resultados para esta búsqueda.</div>';
    return;
  }
  const fmtF = s => s ? new Date(s).toLocaleDateString('es-CL') : '—';
  const fmtM = v => v ? '$'+Number(v).toLocaleString('es-CL') : '—';
  const finTag = f => {
    const color = f==='AUTOFIN'?'#dbeafe;color:#1d4ed8' : f&&f.includes('UNIDAD')?'#fce7f3;color:#9d174d':'#f1f5f9;color:#374151';
    return `<span style="font-size:.7rem;font-weight:700;background:${color};border-radius:4px;padding:2px 7px">${f||'—'}</span>`;
  };
  // Estado de CARTERA (2da dimensión, solo recursos propios). Etapa = c.estado.
  const CART_COL = { VIGENTE:'#16a34a', MORA:'#d97706', 'EN MORA':'#d97706', VENCIDO:'#dc2626', TERMINADO:'#0f766e', PREPAGADO:'#7c3aed', CASTIGADO:'#111827' };
  const carteraTag = (ec, dias, fin) => {
    if (!ec) return '<span style="color:#cbd5e1">—</span>';
    const col = CART_COL[ec] || '#64748b';
    // AutoFácil en mora/vencido/castigado: días de atraso al costado.
    const esAF = String(fin || '').toUpperCase() === 'AUTOFACIL';
    const enMora = ['MORA', 'EN MORA', 'VENCIDO', 'CASTIGADO'].includes(String(ec).toUpperCase());
    const suf = (esAF && enMora && Number(dias) > 0) ? ` (${Number(dias)} días)` : '';
    return `<span style="font-size:.68rem;font-weight:800;color:#fff;background:${col};border-radius:10px;padding:2px 9px">${ec}${suf}</span>`;
  };
  const sArrow = col => { const a = _sortColCred===col; return `<span style="color:${a?'#0141A2':'#cbd5e1'};font-size:.72em">${a?(_sortDirCred==='asc'?'▲':'▼'):'⇅'}</span>`; };
  const sTh = (label, col, cls='', st='') => `<th class="${cls}" onclick="toggleSortCred('${col}')" style="cursor:pointer;user-select:none;white-space:nowrap;${st}" title="Ordenar mayor/menor">${label} ${sArrow(col)}</th>`;
  res.innerHTML = `<div class="table-responsive">
    <table class="cred-table" style="min-width:0;width:100%;table-layout:auto">
      <thead>
        <tr>
          ${sTh('N° OP','numero_credito')}
          ${sTh('RUT','rut_cliente')}
          ${sTh('Cliente','nombre_cliente')}
          ${sTh('Financiera','financiera')}
          ${sTh('ID Financiera','id_financiera')}
          ${sTh('Fecha','fecha_otorgamiento')}
          ${sTh('Monto','monto_financiado','num')}
          <th>Vehículo</th>
          ${sTh('Cuota','cuota','num')}
          ${sTh('Plazo','plazo','','text-align:center')}
          ${sTh('Etapa','estado','','text-align:center')}
          <th style="text-align:center;white-space:nowrap">Estado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${list.map(c => `
        <tr>
          <td class="num-cred">${c.numero_credito||'—'}</td>
          <td class="mono" style="white-space:nowrap">${c.rut_cliente||'—'}</td>
          <td>${c.nombre_cliente||'—'}</td>
          <td>${finTag(c.financiera)}</td>
          <td class="mono" style="font-size:.78rem;color:#6b7280">${c.id_financiera||'—'}</td>
          <td style="white-space:nowrap;font-size:.78rem;color:#6b7280">${fmtF(c.fecha_otorgamiento||c.created_at)}</td>
          <td class="num" style="color:#059669;font-weight:700">${fmtM(c.monto_financiado)}</td>
          <td style="font-size:.8rem">${[c.marca,c.modelo,c.anio].filter(Boolean).join(' ')||'—'}</td>
          <td class="num" style="color:var(--navy);font-weight:800">${fmtPeso(c.cuota)}</td>
          <td style="text-align:center">${c.plazo?c.plazo+' m':'—'}</td>
          <td style="text-align:center"><span class="badge-estado badge-${(c.estado||'').replace(' ','-')}">${c.estado||'—'}</span></td>
          <td style="text-align:center">${carteraTag(c.estado_cartera, c.dias_atraso, c.financiera)}</td>
          <td style="text-align:center">
            <button class="btn-ver-detalle" onclick="location.href='/creditos/revisar?id=${c.id_credito}'">
              <i class="bi bi-eye me-1"></i>Ver
            </button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

/* ─── Detalle crédito ────────────────────────────────────────────────── */
let _creditoEditId   = null;
let _detalleData     = null;
let _savedCreditData = null;

async function abrirDetalle(id) {
  const panel = document.getElementById('detallePanel');
  document.getElementById('detalleBody').innerHTML = '<div class="text-center py-5"><div class="spinner-border spinner-border-sm"></div></div>';
  panel.classList.add('open');
  try {
    const r = await fetch('/api/creditos/'+id, { headers: apiHdr() });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    const c = j.data;
    _creditoEditId  = c.id_credito;
    _detalleData    = c;
    document.getElementById('dNumCred').textContent  = c.numero_credito || '—';
    document.getElementById('dNombre').textContent   = c.nombre_cliente || '—';
    document.getElementById('dRut').textContent      = c.rut_cliente    || '—';
    const fmtD = s => s ? new Date(s).toLocaleDateString('es-CL') : '—';
    document.getElementById('detalleBody').innerHTML = `
      <div class="ds">
        <div class="ds-title" style="display:flex;justify-content:space-between;align-items:center">
          <span><i class="bi bi-car-front-fill"></i>Vehículo</span>
          ${c.financiera ? `<span style="font-size:.72rem;font-weight:800;background:#dbeafe;color:#1d4ed8;border-radius:6px;padding:2px 10px">${c.financiera}</span>` : ''}
        </div>
        <div class="ds-grid">
          ${item('Tipo',        c.tipo_vehiculo)}
          ${item('Marca',       c.marca)}
          ${item('Modelo',      c.modelo)}
          ${item('Año',         c.anio)}
          ${item('Transmisión', c.transmision)}
          ${item('Combustible', c.combustible)}
          ${item('Tasación',    fmtPeso(c.tasacion))}
          ${item('Perm. Circ.', fmtPeso(c.permiso_circulacion))}
          ${item('Patente',     c.patente)}
          ${item('Color',       c.color)}
          ${item('Motor',       c.motor)}
          ${item('Chasis',      c.chasis)}
          ${item('Dealer',      c.dealer)}
          ${item('Ubicación',   c.tipo_ubicacion ? (c.tipo_ubicacion === 'PARQUE' ? '🏢 Parque' + (c.nombre_parque ? ': '+c.nombre_parque : '') : '🛣️ Calle') : null)}
        </div>
      </div>
      <div class="ds">
        <div class="ds-title"><i class="bi bi-bank2"></i>Financiamiento</div>
        <div class="ds-grid">
          ${item('Fecha Otorgamiento', fmtD(c.fecha_otorgamiento))}
          ${item('Fecha 1ª Cuota',     fmtD(c.fecha_primera_cuota))}
          ${item('Valor Vehículo',     fmtPeso(c.valor_vehiculo))}
          ${item('Pie',                fmtPeso(c.pie))}
          ${item('Saldo Precio',       fmtPeso(c.saldo_precio))}
          ${item('Gastos Operativos',  fmtPeso(c.gastos_operativos))}
          ${item('Seguros',            fmtPeso(c.seguros))}
          ${item('Monto Financiado',   fmtPeso(c.monto_financiado))}
          ${item('Plazo',              c.plazo ? c.plazo+' meses' : '—')}
          ${item('Tasa Mensual',       c.tasa_mensual ? Number(c.tasa_mensual).toFixed(2)+'%' : '—')}
        </div>
        <div style="margin-top:14px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border:2px solid #93c5fd;border-radius:10px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:.7rem;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.06em">Cuota Mensual</div>
            <div style="font-size:1.5rem;font-weight:900;color:var(--navy)">${fmtPeso(c.cuota)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:.7rem;font-weight:700;color:#9ca3af;text-transform:uppercase">Ejecutivo</div>
            <div style="font-size:.88rem;font-weight:700;color:#374151">${c.ejecutivo||'—'}</div>
          </div>
        </div>
      </div>
      <button class="amort-btn-detalle" onclick="abrirAmortDesdeDetalle()">
        <i class="bi bi-table"></i>Ver Tabla de Amortización
        <span style="font-size:.72rem;font-weight:600;opacity:.7">— desglose cuota por cuota</span>
      </button>
      <div class="ds">
        <div class="ds-title"><i class="bi bi-sliders"></i>Estado y Observaciones</div>
        <div class="row g-2">
          <div class="col-md-4">
            <label class="form-label">Estado</label>
            <select id="dEstado" class="form-select">
              <option value="INGRESO"            ${c.estado==='INGRESO'            ?'selected':''}>Ingresado</option>
              <option value="CARGA_RESPALDOS"    ${c.estado==='CARGA_RESPALDOS'    ?'selected':''}>Carga Respaldos</option>
              <option value="EN_ANALISIS"        ${c.estado==='EN_ANALISIS'        ?'selected':''}>En Análisis</option>
              <option value="CARTA_APROBACION"   ${c.estado==='CARTA_APROBACION'   ?'selected':''}>Carta Aprobación</option>
              <option value="EMISION_DOCUMENTOS" ${c.estado==='EMISION_DOCUMENTOS' ?'selected':''}>Emisión Documentos</option>
              <option value="CARGA_DOCUMENTOS_AF"${c.estado==='CARGA_DOCUMENTOS_AF'?'selected':''}>Carga Docs. AF</option>
              <option value="VALIDACION_FIRMA"   ${c.estado==='VALIDACION_FIRMA'   ?'selected':''}>Validación Firma</option>
              <option value="VIGENTE"            ${c.estado==='VIGENTE'            ?'selected':''}>Vigente</option>
              <option value="EN MORA"            ${c.estado==='EN MORA'            ?'selected':''}>En Mora</option>
              <option value="CANCELADO"          ${c.estado==='CANCELADO'          ?'selected':''}>Cancelado</option>
              <option value="PREPAGADO"          ${c.estado==='PREPAGADO'          ?'selected':''}>Prepagado</option>
              <option value="CASTIGADO"          ${c.estado==='CASTIGADO'          ?'selected':''}>Castigado</option>
              <optgroup label="── Broker (AUTOFIN / UNIDAD) ──">
              <option value="OTORGADO"           ${c.estado==='OTORGADO'           ?'selected':''}>Otorgado</option>
              <option value="CURSADO"            ${c.estado==='CURSADO'            ?'selected':''}>Cursado</option>
              <option value="DESISTIDO"          ${c.estado==='DESISTIDO'          ?'selected':''}>Desistido</option>
              </optgroup>
            </select>
          </div>
          <div class="col-12">
            <label class="form-label">Observaciones</label>
            <textarea id="dObservaciones" class="form-control" rows="3">${c.observaciones||''}</textarea>
          </div>
        </div>
      </div>`;
  } catch(e) {
    document.getElementById('detalleBody').innerHTML = `<div class="empty-state" style="color:#ef4444"><i class="bi bi-exclamation-triangle"></i>${e.message}</div>`;
  }
}

function item(label, val) {
  return `<div class="ds-item"><div class="ds-label">${label}</div><div class="ds-val">${val||'—'}</div></div>`;
}

function cerrarDetalle() {
  document.getElementById('detallePanel').classList.remove('open');
  _creditoEditId = null;
}

async function guardarEstadoDetalle() {
  if (!_creditoEditId) return;
  const body = {
    estado:        document.getElementById('dEstado').value,
    observaciones: document.getElementById('dObservaciones').value.trim(),
  };
  try {
    const r = await fetch('/api/creditos/'+_creditoEditId, { method:'PUT', headers:apiHdr(), body:JSON.stringify(body) });
    const j = await r.json();
    if (j.success) {
      showToast('Cambios guardados', true);
      cerrarDetalle();
      buscarCreditos(1);
    } else showToast(j.error||'Error', false);
  } catch(e) { showToast('Error de conexión', false); }
}

/* ═══════════════════════════════════════════════════════════════════
   INGRESO DE CRÉDITOS
═══════════════════════════════════════════════════════════════════ */
async function buscarClienteCred(fromReturn = false) {
  const rut = document.getElementById('iRut').value.trim().toUpperCase();
  if (!rut) return;
  const v = validarRUT(rut);
  if (v === false) { showToast('RUT inválido: dígito verificador incorrecto', false); return; }
  if (v === null)  { showToast('Ingresa el RUT completo con dígito verificador', false); return; }
  const msg = document.getElementById('rutClienteFoundMsg');
  try {
    // Traer datos del cliente y los tres timestamps en paralelo
    const [rCliente, rAntLab, rInfoCom] = await Promise.all([
      fetch('/api/clientes/rut/'           + encodeURIComponent(rut), { headers:apiHdr() }),
      fetch('/api/antecedentes-laborales/' + encodeURIComponent(rut), { headers:apiHdr() }),
      fetch('/api/informacion-comercial/'  + encodeURIComponent(rut), { headers:apiHdr() }),
    ]);
    const [jCliente, jAntLab, jInfoCom] = await Promise.all([
      rCliente.json(), rAntLab.json(), rInfoCom.json(),
    ]);

    if (jCliente.success && jCliente.data) {
      const c      = jCliente.data;
      const nombre = [c.nombres, c.apellido_paterno, c.apellido_materno].filter(Boolean).join(' ')
                   || c.razon_social || rut;
      document.getElementById('iNombreCliente').value = nombre;

      // Fechas de actualización (link a actualizar; ámbar >60d, rojo >90d)
      const hoy    = new Date();
      const DAY    = 24 * 60 * 60 * 1000;
      const rutEnc = encodeURIComponent(rut);
      const volver = '&return=' + encodeURIComponent('/creditos');
      const HREFS  = {
        'Datos Personales': '/clientes?rut='           + rutEnc + volver,
        'Ant. Laborales':   '/antecedentes-laborales?rut=' + rutEnc + volver,
        'Inf. Comercial':   '/informacion-comercial?rut='  + rutEnc + volver,
      };
      const itemFecha = (label, val) => {
        const href = HREFS[label];
        if (!val) return `<div class="fecha-item"><span class="fi-label">${label}</span><a class="fi-val danger" href="${href}" title="Actualizar ${label}">Sin datos<i class="bi bi-pencil-square fi-edit"></i></a></div>`;
        const d    = new Date(val);
        const dias = Math.floor((hoy - d) / DAY);
        const cls  = dias > 90 ? 'danger' : dias > 60 ? 'warn' : '';
        const txt  = d.toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'2-digit' });
        return `<div class="fecha-item"><span class="fi-label">${label}</span><a class="fi-val${cls?' '+cls:''}" href="${href}" title="Actualizar ${label} (${dias} días)">${txt}<i class="bi bi-pencil-square fi-edit"></i></a></div>`;
      };
      const fechasHtml = [
        itemFecha('Datos Personales', c.fecha_actualizacion),
        itemFecha('Ant. Laborales',   jAntLab.success  && jAntLab.data  ? jAntLab.data.updated_at  : null),
        itemFecha('Inf. Comercial',   jInfoCom.success && jInfoCom.data ? jInfoCom.data.updated_at : null),
      ].join('');

      msg.innerHTML = `<div class="rut-found">
        <div class="rut-found-nombre"><i class="bi bi-person-check"></i>${nombre} — ${rut}</div>
        <div class="rut-found-fechas">${fechasHtml}</div>
      </div>`;
      msg.style.display = 'block';
    } else if (fromReturn) {
      // Volvimos de crear el cliente y aún no aparece → permitir ingreso manual (evita bucle de redirección)
      msg.innerHTML = `<div style="color:#ef4444;font-size:.82rem"><i class="bi bi-exclamation-circle me-1"></i>Cliente no encontrado. Ingresa el nombre manualmente.</div>`;
      msg.style.display = 'block';
    } else {
      // Igual que en Cartas de Aprobación: abrir el formulario de creación de cliente y volver con el RUT
      const rutEnc = encodeURIComponent(rut);
      msg.innerHTML = `<div style="color:#c2410c;font-size:.82rem"><i class="bi bi-exclamation-triangle-fill me-1"></i>Cliente no encontrado — se abrirá el formulario de creación…</div>`;
      msg.style.display = 'block';
      setTimeout(() => { window.location.href = '/clientes/?rutPre=' + rutEnc + '&return=/creditos'; }, 1500);
      return;
    }
    // Habilitar botón cotizaciones
    const btnCotiz = document.getElementById('btnVerCotiz');
    if (btnCotiz) btnCotiz.disabled = false;
  } catch(e) { showToast('Error al buscar cliente', false); }
}

/* ─── Helpers de formato (créditos) ────────────────────────────────────── */
function parseCLP(id) {
  return parseInt((document.getElementById(id)?.value||'').replace(/\$/g,'').replace(/\./g,'').replace(/[^0-9]/g,''))||0;
}
function credPesoInput(el) {
  const raw = el.value.replace(/\$/g,'').replace(/\./g,'').replace(/[^0-9]/g,'');
  const n   = parseInt(raw);
  el.value  = (!isNaN(n) && n > 0) ? '$' + n.toLocaleString('es-CL') : '';
  credRecalcular();
}
function credTasaInput(el) {
  const raw = el.value.replace(/%/g,'');
  el.value  = raw ? raw + '%' : '';
  credTasaManual = raw.trim() !== '';  // flag: usuario editó manualmente
  const pos = Math.max(0, el.value.length - 1);
  try { el.setSelectionRange(pos, pos); } catch(e){}
  credRecalcular();
}
function credTasaFocus(el) {
  if (el.value.endsWith('%')) {
    const pos = el.value.length - 1;
    setTimeout(()=>{ try { el.setSelectionRange(pos, pos); } catch(e){} }, 0);
  }
}

/* ─── Motor de cálculo (créditos) ───────────────────────────────────────── */
const CRED_SEG_RATES = {
  6:  { d:0.00898,  r:0.006745, c:0.036162, dr:0.015847, dc:0.045806, rc:0.043406, drc:0.053186 },
  12: { d:0.018641, r:0.011634, c:0.037883, dr:0.030715, dc:0.057977, rc:0.05042,  drc:0.071008 },
  24: { d:0.027538, r:0.012248, c:0.042101, dr:0.040474, dc:0.072041, rc:0.055409, drc:0.08613  },
  36: { d:0.035518, r:0.012761, c:0.04712,  dr:0.049208, dc:0.08613,  rc:0.061121, drc:0.1012   },
  48: { d:0.043623, r:0.029018, c:0.052853, dr:0.075269, dc:0.101322, rc:0.085069, drc:0.136622 },
  72: { d:0.054964, r:0.034875, c:0.058985, dr:0.093853, dc:0.120825, rc:0.098177, drc:0.164822 },
};
function credPlazoBracket(n) { for (const b of [6,12,24,36,48,72]) if (n<=b) return b; return 72; }
function credPmt(r,n,pv) { if(Math.abs(r)<1e-10) return pv/n; return (window.AF_RENT_CORE ? AF_RENT_CORE.cuotaFrancesa(pv,r,n) : pv*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1)); }
// CAE → MOTOR ÚNICO /js/cae-core.js. Devuelve fracción (contrato local: *100 al mostrar).
function credCAE(saldo,cuota,plazo) {
  const v = window.AF_CAE ? AF_CAE.cae(saldo,cuota,plazo) : null;
  return v==null ? null : v/100;
}
function credComboKey(d,r,c) {
  if(d&&r&&c) return 'drc'; if(d&&r) return 'dr'; if(d&&c) return 'dc';
  if(r&&c) return 'rc'; if(d) return 'd'; if(r) return 'r'; if(c) return 'c'; return null;
}
function credFmtP(n) { if(!n&&n!==0) return '—'; return '$'+Math.round(n).toLocaleString('es-CL'); }

let credParams = {};
let credUF = 0;
let credTasas = {};
let credTasaManual = false;

async function credCargarParams() {
  try {
    const [rP, rU, rT] = await Promise.all([
      fetch('/api/parametros-credito', { headers: apiHdr() }),
      fetch('/api/uf/vigente',         { headers: apiHdr() }),
      fetch('/api/tasas/vigente',      { headers: apiHdr() }),
    ]);
    const [jP, jU, jT] = await Promise.all([rP.json(), rU.json(), rT.json()]);

    if (jP.success) credParams = jP.data.obj || {};
    if (jU.success && jU.data) credUF = parseFloat(jU.data.valor) || 0;
    if (jT.success && jT.data) {
      credTasas.menor = parseFloat(jT.data.tasa_mensual_menor) || 0;
      credTasas.mayor = parseFloat(jT.data.tasa_mensual_mayor) || 0;
    }
    // Pre-cargar parámetros en inputs rentabilidades
    const elCF = document.getElementById('ciRcCostoFondo');
    if (elCF && !elCF.value) elCF.value = (credParams.costo_fondo||0).toFixed(4).replace('.',',');
    const elPE = document.getElementById('ciRcPctEjec');
    if (elPE && !elPE.value) elPE.value = (credParams.pct_ejecutivo||0).toFixed(2).replace('.',',');
    credActualizarGastos();
    credRecalcular();
  } catch(e) {}
}

// Determina tramo ≤200 UF / >200 UF y auto-setea la tasa si no es manual
function credActualizarTramo(montoFin) {
  const elHint = document.getElementById('hintTasa');
  if (!credUF || !montoFin || !credTasas.menor) {
    if (elHint) elHint.textContent = 'Tasa vigente según tramo';
    return;
  }
  const esTramoMenor = montoFin <= 200 * credUF;
  const tasa = esTramoMenor ? credTasas.menor : credTasas.mayor;
  if (elHint) elHint.textContent = esTramoMenor
    ? `≤200 UF → ${Number(tasa).toFixed(2)}% mensual`
    : `>200 UF → ${Number(tasa).toFixed(2)}% mensual`;
  if (!credTasaManual) {
    const iTasa = document.getElementById('iTasa');
    if (iTasa) iTasa.value = Number(tasa).toFixed(2) + '%';
  }
}

// Pre-calcula monto a financiar (sin tasa) para determinar tramo
function credCalcMontoFin(p) {
  const saldo  = p.valorVehiculo - p.pie;
  const gastos = p.prenda + p.retiro + p.limitacion + p.admin + p.inscripcion + p.gps + p.reparaciones;
  const subSin = saldo + gastos;
  const pb     = credPlazoBracket(p.plazo);
  const rates  = CRED_SEG_RATES[pb] || CRED_SEG_RATES[72];
  const key    = credComboKey(p.chkD, p.chkR, p.chkC);
  const segs   = key ? (rates[key] || 0) * subSin : 0;
  return subSin + segs - (p.bono || 0);
}

function credActualizarGastos() {
  const p = credParams;
  const chkGps = document.getElementById('chkCGps');
  const chkRep = document.getElementById('chkCRep');
  const set = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=credFmtP(v); };
  set('cgPrenda',      p.prenda            || 0);
  set('cgRetiro',      p.retiro_gestion    || 0);
  set('cgLimitacion',  p.limitacion_dominio|| 0);
  set('cgAdmin',       p.gastos_admin      || 0);
  set('cgInscripcion', p.inscripcion       || 0);
  set('cgGps',         chkGps?.checked ? (p.gps_24meses          || 0) : 0);
  set('cgReparaciones',chkRep?.checked ? (p.reparaciones_menores || 0) : 0);
}

function credLeerInputs() {
  const p = credParams;
  const chkGps  = document.getElementById('chkCGps');
  const chkRep  = document.getElementById('chkCRep');
  const tasaRaw = (document.getElementById('iTasa').value||'').replace(/%/g,'').replace(',','.');
  return {
    valorVehiculo: parseCLP('iValorVehiculo'),
    pie:           parseCLP('iPie'),
    plazo:         parseInt(document.getElementById('iPlazo').value)||48,
    tasa:          parseFloat(tasaRaw)||0,
    diasPrimeraCuota: credDiasPrimeraCuota(),
    prenda:        p.prenda             || 0,
    retiro:        p.retiro_gestion     || 0,
    limitacion:    p.limitacion_dominio || 0,
    admin:         p.gastos_admin       || 0,
    inscripcion:   p.inscripcion        || 0,
    gps:           chkGps?.checked ? (p.gps_24meses          || 0) : 0,
    reparaciones:  chkRep?.checked ? (p.reparaciones_menores || 0) : 0,
    bono:          parseCLP('iBonoFin'),
    chkD:          document.getElementById('chkCDesg')?.checked ?? true,
    chkR:          document.getElementById('chkCRdh')?.checked  ?? true,
    chkC:          document.getElementById('chkCCesa')?.checked ?? true,
  };
}

function credDiasPrimeraCuota() {
  const elCuota = document.getElementById('iFechaPrimeraCuota');
  const elOtorg = document.getElementById('iFechaOtorg');
  if (!elCuota?.value) return 30;
  const fechaCuota = new Date(elCuota.value + 'T00:00:00');
  const fechaRef   = elOtorg?.value ? new Date(elOtorg.value + 'T00:00:00') : new Date();
  const diff = Math.round((fechaCuota - fechaRef) / 86400000);
  return diff > 0 ? diff : 30;
}
function credActualizarDias() {
  const elH = document.getElementById('hintDias');
  if (!elH) return;
  const elO = document.getElementById('iFechaOtorg');
  const elC = document.getElementById('iFechaPrimeraCuota');
  if (elO?.value && elC?.value) {
    const dias = Math.round((new Date(elC.value+'T00:00:00') - new Date(elO.value+'T00:00:00')) / 86400000);
    elH.textContent = dias > 0 ? dias + ' días entre otorgamiento y 1ª cuota' : '⚠️ Fecha inválida';
  } else {
    elH.textContent = '—';
  }
}

function credCalc(p) {
  const saldoPrecio = p.valorVehiculo - p.pie;
  const gastosOp = p.prenda + p.retiro + p.limitacion + p.admin + p.inscripcion + p.gps + p.reparaciones;
  const subSin = saldoPrecio + gastosOp;
  const pb = credPlazoBracket(p.plazo);
  const rates = CRED_SEG_RATES[pb] || CRED_SEG_RATES[72];
  const key = credComboKey(p.chkD, p.chkR, p.chkC);
  let segDesg=0, segRdh=0, segCesa=0;
  if (key) {
    const totalNet = (rates[key]||0) * subSin;
    const sumInd = (p.chkD?rates.d:0)+(p.chkR?rates.r:0)+(p.chkC?rates.c:0);
    if (sumInd>0) {
      if (p.chkD) segDesg = totalNet*(rates.d/sumInd);
      if (p.chkR) segRdh  = totalNet*(rates.r/sumInd);
      if (p.chkC) segCesa = totalNet*(rates.c/sumInd);
    }
  }
  const totalSeguros = segDesg + segRdh + segCesa;
  const subCon = subSin + totalSeguros;
  const montoFin = subCon - p.bono;
  const tasaD = p.tasa / 100;
  const extraDias = (p.diasPrimeraCuota||30) - 30;
  const capitalAjustado = montoFin + montoFin * tasaD * extraDias / 30;
  const cuota = credPmt(tasaD, p.plazo, capitalAjustado);
  const totalPagado = cuota * p.plazo;
  const cae = credCAE(saldoPrecio, cuota, p.plazo);
  const ambosFactor = credAmbosFactor ? credAmbosFactor(p.plazo) : 1.173526;
  return { saldoPrecio, gastosOp, subSin, segDesg, segRdh, segCesa, totalSeguros, subCon, montoFin,
           cuota, totalPagado, cae, pb, rates, combo: key, ambosFactor };
}

function credRecalcular() {
  credActualizarGastos();
  let p = credLeerInputs();
  const saldo = p.valorVehiculo - p.pie;
  document.getElementById('iSaldoPrecio').value = saldo > 0 ? '$' + saldo.toLocaleString('es-CL') : '';
  document.getElementById('rCCPlazo').textContent = (p.plazo||48) + ' meses';
  // Siempre mostrar saldo precio en el resumen
  if (saldo > 0) document.getElementById('rCCSaldoPrecio').textContent = credFmtP(saldo);
  // Auto-switch tasa según tramo 200 UF
  if (p.valorVehiculo) {
    credActualizarTramo(credCalcMontoFin(p));
    if (!credTasaManual) p = credLeerInputs(); // re-leer con tasa actualizada
  }
  if (!p.valorVehiculo || !p.tasa) {
    ['rCCGastos','rCCSubSin','rCCSegD','rCCSegR','rCCSegC',
     'rCCSubCon','rCCBono','rCCMontoFin','rCCCuota','rCCCae','rCCTotal'].forEach(id => {
      const el=document.getElementById(id); if(el) el.textContent='—';
    });
    ['iGastosOp','iSeguros','iMontoFin','iCuota'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    return;
  }
  const r = credCalcFull ? credCalcFull(credLeerInputsFull ? credLeerInputsFull() : p) : credCalc(p);
  _credLastResult = { r, p };
  const f = credFmtP;
  document.getElementById('rCCSaldoPrecio').textContent = f(r.saldoPrecio);
  document.getElementById('rCCGastos').textContent      = f(r.gastosOp);
  document.getElementById('rCCSubSin').textContent      = f(r.subSin);
  document.getElementById('rCCSegD').textContent        = r.segDesg  > 0 ? f(r.segDesg)  : '—';
  document.getElementById('rCCSegR').textContent        = r.segRdh   > 0 ? f(r.segRdh)   : '—';
  document.getElementById('rCCSegC').textContent        = r.segCesa  > 0 ? f(r.segCesa)  : '—';
  document.getElementById('rCCSubCon').textContent      = f(r.subCon);
  document.getElementById('rCCBono').textContent        = p.bono > 0 ? f(p.bono) : '—';
  document.getElementById('rCCMontoFin').textContent    = f(r.montoFin);
  document.getElementById('rCCCuota').textContent       = f(r.cuota);
  document.getElementById('rCCCae').textContent         = r.cae != null ? (r.cae*100).toFixed(2)+'%' : '—';
  document.getElementById('rCCTotal').textContent       = f(r.totalPagado);
  document.getElementById('iGastosOp').value = Math.round(r.gastosOp);
  document.getElementById('iSeguros').value  = Math.round(r.totalSeguros);
  document.getElementById('iMontoFin').value = Math.round(r.montoFin);
  document.getElementById('iCuota').value    = Math.round(r.cuota);
  // Actualizar pestaña activa si corresponde
  if (credCurrentTab === 'seguros')        credRenderSegurosTab(r, p);
  if (credCurrentTab === 'rentabilidades') credRenderRentabilidades();
}

function credCalcular() { credRecalcular(); }

/* ════════════════════════════════════════════════════════════════════
   TABS INTERNOS (Simulador / Seguros / Rentabilidades)
════════════════════════════════════════════════════════════════════ */
let credCurrentTab = 'simulador';

function credCambiarTab(tab) {
  credCurrentTab = tab;
  document.querySelectorAll('#credTabsNav .ctab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.ctab === tab));
  ['simulador','seguros','rentabilidades'].forEach(t => {
    const el = document.getElementById('credTab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'seguros') {
    credBuildSegTable();
    if (_credLastResult) credRenderSegurosTab(_credLastResult.r, _credLastResult.p);
  }
  if (tab === 'rentabilidades') {
    credRenderRentabilidades();
  }
}

/* ── Datos de display seguros (igual que cotizaciones) ── */
const CRED_SEG_DISPLAY = [
  [6,  0.898,  0.675,  3.616,  1.585,  4.581,  4.341,  5.319 ],
  [12, 1.864,  1.163,  3.788,  3.072,  5.798,  5.042,  7.101 ],
  [24, 2.754,  1.225,  4.210,  4.047,  7.204,  5.541,  8.613 ],
  [36, 3.552,  1.276,  4.712,  4.921,  8.613,  6.112,  10.120],
  [48, 4.362,  2.902,  5.285,  7.527,  10.132, 8.507,  13.662],
  [72, 5.496,  3.488,  5.899,  9.385,  12.083, 9.818,  16.482],
];

function credBuildSegTable() {
  const tbody = document.getElementById('ciSegTableBody');
  if (!tbody || tbody.children.length) return;
  tbody.innerHTML = CRED_SEG_DISPLAY.map(([pz,d,rdh,c,dr,dc,rc,drc]) => `
    <tr>
      <td><strong>${pz}</strong></td>
      <td>${d.toFixed(3)}%</td><td>${rdh.toFixed(3)}%</td><td>${c.toFixed(3)}%</td>
      <td>${dr.toFixed(3)}%</td><td>${dc.toFixed(3)}%</td>
      <td>${rc.toFixed(3)}%</td><td>${drc.toFixed(3)}%</td>
    </tr>`).join('');
}

function credAmbosFactor(plazo) {
  if (plazo <= 12) return 1.15163;
  if (plazo <= 24) return 1.154908;
  if (plazo <= 36) return 1.166801;
  return 1.173526;
}
function credPvf(r, n, p) {
  if (window.AF_RENT_CORE) return AF_RENT_CORE.valorPresenteAnualidad(p, r, n);
  if (Math.abs(r) < 1e-10) return p * n;
  return p * (1 - Math.pow(1 + r, -n)) / r;
}
function credParseTasa(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/%/g,'').replace(',','.')) || 0;
}
function credComboLabel(d, r, c) {
  const parts = [];
  if (d) parts.push('Desgravamen'); if (r) parts.push('RDH'); if (c) parts.push('Cesantía');
  return parts.length ? parts.join(' + ') : 'Ninguno';
}
function credPctf(n, dec=2) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(dec).replace('.', ',') + '%';
}

/* Resultado completo incluyendo rentabilidad */
function credCalcFull(p) {
  const base = credCalc(p);
  const costoFondoD = (p.costoFondo || 0) / 100;
  const ingTasa    = costoFondoD > 0 ? credPvf(costoFondoD, p.plazo, base.cuota) - base.montoFin : 0;
  // Ingreso por seguros = % traspaso AutoFin PAREJO sobre cada prima (modelo 2026-07:
  // RDH incluye desgravamen; la penetración ya no determina el %). Igual que AF_RENT.
  const pctTraspaso = ((credParams.seg_pct_traspaso_autofin > 0 ? credParams.seg_pct_traspaso_autofin : 30)) / 100;
  const ingSeguros = Math.round((base.segDesg + base.segRdh + base.segCesa) * pctTraspaso);
  const totalIngresos = ingTasa + ingSeguros;
  // Comisión ejecutivo = % del MONTO FINANCIADO (no del saldo precio), igual que AF_RENT/backend.
  const comEjecutivo  = base.montoFin * ((p.pctEjec||0) / 100);
  const totalCostos   = (p.dealer||0) + (p.patio||0) + comEjecutivo + (p.corfo||0) + (p.bono||0);
  const rentabilidad  = totalIngresos - totalCostos;
  const pb            = credPlazoBracket(p.plazo);
  const rates         = CRED_SEG_RATES[pb] || CRED_SEG_RATES[72];
  return {
    ...base,
    ingTasa, ingSeguros, totalIngresos,
    comEjecutivo, totalCostos, rentabilidad,
    pctMonto:    base.montoFin > 0   ? (rentabilidad / base.montoFin)   * 100 : 0,
    pctVehiculo: p.valorVehiculo > 0 ? (rentabilidad / p.valorVehiculo) * 100 : 0,
    pb, rates,
  };
}

let _credLastResult = null;

function credRenderSegurosTab(r, p) {
  credBuildSegTable();
  const tbody = document.getElementById('ciSegTableBody');
  if (tbody) {
    Array.from(tbody.rows).forEach(row => {
      const b = parseInt(row.cells[0].textContent);
      row.style.background = b === r.pb ? '#dbeafe' : '';
      row.style.fontWeight = b === r.pb ? '700' : '';
    });
  }
  const sEl = id => { const el=document.getElementById(id); if(el) el.textContent=id; };
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
  const comboRate = (r.combo && r.rates) ? (r.rates[r.combo]||0) : 0;
  set('ciS2Plazo',        p.plazo + ' meses');
  set('ciS2Bracket',      r.pb + ' meses');
  set('ciS2Combo',        credComboLabel(p.chkD, p.chkR, p.chkC));
  set('ciS2Base',         credFmtP(r.subSin));
  set('ciS2TasaNeta',     credPctf(comboRate * 100, 4));
  set('ciS2TotalSeguros', credFmtP(r.totalSeguros));
  set('ciS2Desg',         p.chkD ? credFmtP(r.segDesg) : '—');
  set('ciS2Rdh',          p.chkR ? credFmtP(r.segRdh)  : '—');
  set('ciS2Cesa',         p.chkC ? credFmtP(r.segCesa) : '—');
  set('ciS2Ambos',        r.ambosFactor ? r.ambosFactor.toFixed(6) : '—');
  set('ciS2IngSeg',       credFmtP(r.ingSeguros));
}

function credLeerInputsFull() {
  const base = credLeerInputs();
  return {
    ...base,
    costoFondo: credParseTasa(document.getElementById('ciRcCostoFondo')?.value) || (credParams.costo_fondo || 0),
    pctEjec:    credParseTasa(document.getElementById('ciRcPctEjec')?.value)    || (credParams.pct_ejecutivo || 0),
    dealer:     parseInt((document.getElementById('ciRcDealer')?.value||'').replace(/\D/g,'')) || 0,
    patio:      parseInt((document.getElementById('ciRcPatio')?.value||'').replace(/\D/g,''))  || 0,
    corfo:      parseInt((document.getElementById('ciRcCorfo')?.value||'').replace(/\D/g,''))  || 0,
  };
}

function credRenderRentabilidades() {
  const p = credLeerInputsFull();
  if (!p.valorVehiculo && !p.pie) return;
  const normal = credCalcFull(p);

  const tasaRawProp = (document.getElementById('ciRcTasaProp')?.value||'').replace('%','').replace(',','.');
  const tasaProp = parseFloat(tasaRawProp) || p.tasa;
  const propuesto = credCalcFull({ ...p, tasa: tasaProp });

  const uac = credCalcFull({
    ...p,
    tasa: credTasas.mayor || p.tasa,
    chkD: false, chkR: false, chkC: false,
    prenda: 0, limitacion: 0, inscripcion: 0,
  });

  const f = credFmtP;
  function pctf2(n) { return credPctf(n, 2); }
  function pctf4(n) { return credPctf(n, 4); }
  function rentBg(v) { return v >= 0 ? 'background:#d1fae5' : 'background:#fee2e2'; }
  function rentCl(v) { return v >= 0 ? 'color:#065f46;font-weight:800' : 'color:#7f1d1d;font-weight:800'; }

  const rows = [
    { section: 'SUPUESTOS' },
    { label:'Tasa Mensual',   v:[pctf4(p.tasa),     null,         pctf4(credTasas.mayor||p.tasa)], propInput:true },
    { label:'Costo de Fondo', v:[pctf4(p.costoFondo), pctf4(p.costoFondo), pctf4(p.costoFondo)] },
    { label:'Seguros',        v:[(p.chkD||p.chkR||p.chkC)?'Sí':'No', (p.chkD||p.chkR||p.chkC)?'Sí':'No', 'No'] },
    { label:'G. Notariales',  v:[(p.prenda||p.limitacion||p.inscripcion)?'Sí':'No', (p.prenda||p.limitacion||p.inscripcion)?'Sí':'No', 'No'] },
    { section: 'OPERACIÓN' },
    { label:'Monto a Financiar', v:[f(normal.montoFin),    f(propuesto.montoFin),    f(uac.montoFin)] },
    { label:'Cuota Mensual',     v:[f(normal.cuota),       f(propuesto.cuota),       f(uac.cuota)],    bold:true },
    { label:'Total a Pagar',     v:[f(normal.totalPagado), f(propuesto.totalPagado), f(uac.totalPagado)] },
    { section: 'RENTABILIDAD' },
    { label:'Ingreso por Tasa',    v:[f(normal.ingTasa),     f(propuesto.ingTasa),     f(uac.ingTasa)] },
    { label:'Ingreso por Seguros', v:[f(normal.ingSeguros),  f(propuesto.ingSeguros),  f(uac.ingSeguros)] },
    { label:'Total Ingresos',      v:[f(normal.totalIngresos),f(propuesto.totalIngresos),f(uac.totalIngresos)], bold:true },
    { label:'Comisión Dealer',     v:[f(p.dealer), f(p.dealer), f(p.dealer)] },
    { label:'Comisión Patio',      v:[f(p.patio),  f(p.patio),  f(p.patio)] },
    { label:'Comisión Ejecutivo',  v:[f(normal.comEjecutivo), f(propuesto.comEjecutivo), f(uac.comEjecutivo)] },
    { label:'Comisión CORFO',      v:[f(p.corfo), f(p.corfo), f(p.corfo)] },
    { label:'Total Costos',        v:[f(normal.totalCostos), f(propuesto.totalCostos), f(uac.totalCostos)], bold:true },
    { label:'RENTABILIDAD',
      v:[f(normal.rentabilidad), f(propuesto.rentabilidad), f(uac.rentabilidad)],
      rentRow:[normal.rentabilidad, propuesto.rentabilidad, uac.rentabilidad] },
    { label:'% sobre Monto',    v:[pctf2(normal.pctMonto),    pctf2(propuesto.pctMonto),    pctf2(uac.pctMonto)] },
    { label:'% sobre Vehículo', v:[pctf2(normal.pctVehiculo), pctf2(propuesto.pctVehiculo), pctf2(uac.pctVehiculo)] },
  ];

  const tbody = document.getElementById('ciRentTableBody');
  if (!tbody) return;
  tbody.innerHTML = rows.map(row => {
    if (row.section) return `<tr style="background:#f0f4f8"><td colspan="4" style="padding:7px 12px;font-size:.75rem;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">── ${row.section} ──</td></tr>`;
    if (row.rentRow) {
      const [rn,rp,ru] = row.rentRow;
      return `<tr>
        <td style="font-weight:800">${row.label}</td>
        <td class="text-center" style="${rentBg(rn)};${rentCl(rn)}">${row.v[0]}</td>
        <td class="text-center" style="${rentBg(rp)};${rentCl(rp)}">${row.v[1]}</td>
        <td class="text-center" style="${rentBg(ru)};${rentCl(ru)}">${row.v[2]}</td>
      </tr>`;
    }
    if (row.propInput) {
      return `<tr>
        <td>${row.label}</td>
        <td class="text-center">${row.v[0]}</td>
        <td class="text-center"><input type="text" id="ciRcTasaProp" value="${credPctf(tasaProp,4)}"
          style="width:90px;border-radius:6px;border:1.5px solid #d1d5db;padding:3px 6px;font-size:.82rem"
          inputmode="decimal" oninput="credRenderRentabilidades()"></td>
        <td class="text-center">${row.v[2]}</td>
      </tr>`;
    }
    const bld = row.bold ? 'font-weight:700' : '';
    return `<tr>
      <td style="${bld}">${row.label}</td>
      <td class="text-center" style="${bld}">${row.v[0]}</td>
      <td class="text-center" style="${bld}">${row.v[1]}</td>
      <td class="text-center" style="${bld}">${row.v[2]}</td>
    </tr>`;
  }).join('');
}

function credLimpiarFinanciero() {
  ['iValorVehiculo','iPie','iBonoFin','iFechaPrimeraCuota'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  document.getElementById('iSaldoPrecio').value = '';
  document.getElementById('iPlazo').value = '48';
  document.getElementById('iTasa').value = '';
  credTasaManual = false;  // permite que el tramo auto-setee la tasa
  ['chkCDesg','chkCRdh','chkCCesa','chkCRep','chkCGps'].forEach(id => {
    const el = document.getElementById(id); if(el) el.checked = true;
  });
  credRecalcular();
}

/* ─── Modal cotizaciones ─────────────────────────────────────────────────── */
async function abrirCotizaciones() {
  const rut = document.getElementById('iRut').value.trim().toUpperCase();
  if (!rut) return;
  const overlay = document.getElementById('cotOverlay');
  const body    = document.getElementById('cotBody');
  overlay.classList.add('open');
  body.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm"></div></div>';
  try {
    const r = await fetch('/api/cotizaciones/rut/' + encodeURIComponent(rut), { headers: apiHdr() });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    const rows = j.data;
    if (!rows.length) {
      body.innerHTML = '<div class="text-center py-5 text-muted"><i class="bi bi-inbox fs-2 d-block mb-2"></i>No hay cotizaciones para este RUT</div>';
      return;
    }
    body.innerHTML = rows.map(c => {
      const fecha = new Date(c.fecha_cotizacion).toLocaleString('es-CL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
      return `<div class="cot-row" onclick="cotSeleccionar(${c.id_cotizacion})">
        <div class="cot-row-top">
          <div>
            <div class="cot-row-date">${fecha}</div>
            <div class="cot-row-meta">
              <span>Vehículo: ${credFmtP(c.valor_vehiculo)}</span>
              <span>Plazo: ${c.plazo} m</span>
              <span>Tasa: ${Number(c.tasa_mensual).toFixed(2)}%</span>
            </div>
          </div>
          <div class="text-end">
            <div style="font-size:.68rem;color:#9ca3af;text-transform:uppercase">Cuota mensual</div>
            <div class="cot-row-cuota">${credFmtP(c.cuota)}</div>
          </div>
        </div>
      </div>`;
    }).join('');
    // Store rows for selection
    window._cotRows = rows;
  } catch(e) {
    body.innerHTML = `<div class="text-center py-4 text-danger"><i class="bi bi-exclamation-triangle me-1"></i>${e.message}</div>`;
  }
}

function cotSeleccionar(id) {
  const cot = (window._cotRows||[]).find(c => c.id_cotizacion === id);
  if (!cot) return;
  const fmtCLP = n => n ? parseInt(n).toLocaleString('es-CL') : '';
  document.getElementById('iValorVehiculo').value = fmtCLP(cot.valor_vehiculo);
  document.getElementById('iPie').value           = fmtCLP(cot.pie);
  document.getElementById('iPlazo').value         = cot.plazo || 48;
  document.getElementById('iTasa').value          = cot.tasa_mensual ? Number(cot.tasa_mensual).toFixed(2)+'%' : '';
  let dj = {};
  try { dj = typeof cot.datos_json==='string' ? JSON.parse(cot.datos_json) : (cot.datos_json||{}); } catch{}
  const inp = dj.inputs || {};
  if (inp.bono > 0) document.getElementById('iBonoFin').value = inp.bono;
  if ('chkD' in inp) document.getElementById('chkCDesg').checked = inp.chkD;
  if ('chkR' in inp) document.getElementById('chkCRdh').checked  = inp.chkR;
  if ('chkC' in inp) document.getElementById('chkCCesa').checked = inp.chkC;
  if ('gps'  in inp) document.getElementById('chkCGps').checked  = inp.gps > 0;
  if ('reparaciones' in inp) document.getElementById('chkCRep').checked = inp.reparaciones > 0;
  if (inp.diasPrimeraCuota) {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const f = new Date(hoy.getTime() + inp.diasPrimeraCuota * 86400000);
    document.getElementById('iFechaPrimeraCuota').value = f.toISOString().split('T')[0];
  }
  credRecalcular();
  cerrarCotizaciones();
  showToast('Cotización cargada correctamente', true);
}

function cerrarCotizaciones() {
  document.getElementById('cotOverlay').classList.remove('open');
}

/* ── Campos obligatorios del Ingreso de Créditos ──────────────────────────────
   Principales de captura (Cliente, Vehículo, Financiamiento). Quedan fuera los
   calculados/automáticos (Saldo, Tasación, Permiso, Gastos, Cuota, Monto Fin.),
   las comisiones y Observaciones. */
const REQUERIDOS_CRED = [
  ['iRut','RUT Cliente'], ['iNombreCliente','Nombre Cliente'], ['iEjecutivo','Ejecutivo'],
  ['iTipoVehiculo','Tipo Vehículo'], ['iMarca','Marca'], ['iModelo','Modelo'], ['iAnio','Año'],
  ['iPatente','Patente'],
  ['iValorVehiculo','Valor Vehículo','money'], ['iPie','Pie','money'],
  ['iPlazo','Plazo'], ['iTasa','Tasa'],
  ['iFechaOtorg','Fecha Otorgamiento'], ['iFechaPrimeraCuota','Fecha 1ª Cuota'],
];
function _marcarRequeridosCred(){
  const marca = id => {
    const el = document.getElementById(id); if(!el) return;
    const cont = el.closest('[class*="col-"]') || el.parentElement;
    const lab = cont && cont.querySelector('label.form-label');
    if(lab && !lab.querySelector('.req-star')) lab.insertAdjacentHTML('beforeend',' <span class="req-star" style="color:#dc2626">*</span>');
  };
  REQUERIDOS_CRED.forEach(([id]) => marca(id));
  marca('iDealerBuscar'); // Dealer
}
function _validarRequeridosCred(){
  const faltan = [];
  const flag = (el,ok) => { if(el) el.style.borderColor = ok ? '' : '#dc2626'; };
  for(const [id,label,tipo] of REQUERIDOS_CRED){
    const el = document.getElementById(id); if(!el) continue;
    const v = (el.value||'').trim();
    const ok = tipo==='money' ? (parseInt(v.replace(/[^0-9]/g,''))||0) > 0 : v !== '';
    flag(el, ok); if(!ok) faltan.push(label);
  }
  // RUT: además, dígito verificador correcto
  const rut = (document.getElementById('iRut').value||'').trim();
  if(rut && validarRUT(rut)===false){ flag(document.getElementById('iRut'), false); faltan.push('RUT (dígito verificador)'); }
  // Dealer: input de búsqueda u oculto
  const dealer = (document.getElementById('iDealer').value || document.getElementById('iDealerBuscar').value || '').trim();
  flag(document.getElementById('iDealerBuscar'), !!dealer); if(!dealer) faltan.push('Dealer');
  return faltan;
}

async function guardarCredito() {
  const rut    = document.getElementById('iRut').value.trim().toUpperCase();
  const nombre = document.getElementById('iNombreCliente').value.trim();
  const faltan = _validarRequeridosCred();
  if (faltan.length) {
    showToast('Faltan campos obligatorios: ' + faltan.slice(0,5).join(', ') + (faltan.length>5?'…':''), false);
    return;
  }

  const body = {
    rut_cliente:         rut,
    nombre_cliente:      nombre,
    empresa:             document.getElementById('iEmpresa').value || null,
    financiera:          document.getElementById('iFinanciera').value || 'AUTOFACIL',
    estado:              document.getElementById('iEstado').value,
    fecha_otorgamiento:  document.getElementById('iFechaOtorg').value || null,
    fecha_primera_cuota: document.getElementById('iFechaPrimeraCuota').value || null,
    valor_vehiculo:      parseCLP('iValorVehiculo') || null,
    pie:                 parseCLP('iPie') || null,
    saldo_precio:        parseCLP('iSaldoPrecio') || null,
    gastos_operativos:   document.getElementById('iGastosOp').value || null,
    seguros:             document.getElementById('iSeguros').value || null,
    monto_financiado:    document.getElementById('iMontoFin').value || null,
    plazo:               document.getElementById('iPlazo').value || null,
    tasa_mensual:        parseFloat((document.getElementById('iTasa').value||'').replace('%','').replace(',','.')) || null,
    cuota:               document.getElementById('iCuota').value || null,
    tipo_vehiculo:       document.getElementById('iTipoVehiculo').value || null,
    marca:               document.getElementById('iMarca').value || null,
    modelo:              document.getElementById('iModelo').value || null,
    anio:                document.getElementById('iAnio').value || null,
    patente:             document.getElementById('iPatente').value || null,
    color:               document.getElementById('iColor').value || null,
    motor:               document.getElementById('iMotor').value || null,
    chasis:              document.getElementById('iChasis').value || null,
    transmision:         document.getElementById('iTransmision').value || null,
    combustible:         document.getElementById('iCombustible').value || null,
    tasacion:            parseInt((document.getElementById('iTasacion').value||'').replace(/[^0-9]/g,'')) || null,
    permiso_circulacion: parseInt((document.getElementById('iPermiso').value||'').replace(/[^0-9]/g,''))  || null,
    dealer:              (document.getElementById('iDealer').value || document.getElementById('iDealerBuscar').value).trim() || null,
    id_dealer:           parseInt(document.getElementById('iDealerId').value) || null,
    tipo_ubicacion:      document.getElementById('iTipoUbicacion').value || null,
    nombre_parque:       document.getElementById('iNombreParque').value.trim() || null,
    ejecutivo:           document.getElementById('iEjecutivo').value || null,
    observaciones:       document.getElementById('iObservaciones').value || null,
    datos_json: {
      bono_financiamiento: parseCLP('iBonoFin'),
      seguros: {
        desgravamen: document.getElementById('chkCDesg')?.checked ?? true,
        rdh:         document.getElementById('chkCRdh')?.checked  ?? true,
        cesantia:    document.getElementById('chkCCesa')?.checked ?? true,
      },
      gps:          document.getElementById('chkCGps')?.checked ?? true,
      reparaciones: document.getElementById('chkCRep')?.checked ?? true,
    },
  };

  try {
    if (_modoEditar) {
      // ── MODO EDICIÓN: PUT
      const r = await fetch('/api/creditos/' + _modoEditar, { method:'PUT', headers:apiHdr(), body:JSON.stringify(body) });
      const j = await r.json();
      if (j.success) {
        showToast('Crédito actualizado correctamente', true);
        setTimeout(() => { location.href = '/creditos/revisar?id=' + _modoEditar; }, 800);
      } else showToast(j.error||'Error al actualizar', false);
    } else {
      // ── MODO NUEVO: POST
      const r = await fetch('/api/creditos', { method:'POST', headers:apiHdr(), body:JSON.stringify(body) });
      const j = await r.json();
      if (j.success) {
        // Guardar datos para amortización y modal
        _savedCreditData = {
          id_credito:         j.data.id_credito,
          numero_credito:     j.data.numero_credito,
          monto_financiado:   parseFloat(body.monto_financiado)   || 0,
          tasa_mensual:       parseFloat(body.tasa_mensual)        || 0,
          plazo:              parseInt(body.plazo)                 || 0,
          fecha_primera_cuota: body.fecha_primera_cuota            || null,
          cuota:              parseFloat(body.cuota)               || 0,
        };
        // Mostrar modal de éxito
        document.getElementById('successNum').textContent = 'N° ' + j.data.numero_credito;
        document.getElementById('successOverlay').classList.add('open');
        limpiarIngreso();
        setTimeout(buscarCreditos, 300);
      } else showToast(j.error||'Error al guardar', false);
    }
  } catch(e) { showToast('Error de conexión', false); }
}

function limpiarIngreso() {
  ['iRut','iNombreCliente','iTipoVehiculo','iPatente','iColor',
   'iMotor','iChasis','iDealer','iDealerBuscar','iDealerId',
   'iFechaOtorg','iFechaPrimeraCuota','iValorVehiculo','iPie',
   'iSaldoPrecio','iGastosOp','iSeguros','iMontoFin','iPlazo','iTasa','iCuota','iObservaciones',
   'iTasacion','iPermiso','iTipoUbicacion','iNombreParque'
  ].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  fillSelect('iMarca',     [], 'Seleccione marca',  true);
  fillSelect('iModelo',    [], 'Seleccione marca',  false);
  fillSelect('iAnio',      [], '—',                 false);
  fillSelect('iTransmision',[],'seleccione año',    false);
  fillSelect('iCombustible',[],'seleccione año',    false);
  document.getElementById('iEstado').value     = 'INGRESO';
  document.getElementById('iFinanciera').value = 'AUTOFACIL';
  document.getElementById('iEmpresa').value    = '';
  document.querySelectorAll('.empresa-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('rutClienteFoundMsg').style.display = 'none';
  // Reset dealer dropdown
  document.getElementById('iDealerDrop').classList.remove('open');
  // Reset ubicación
  document.getElementById('btnUbicParque').classList.remove('active-parque');
  document.getElementById('btnUbicCalle').classList.remove('active-calle');
  document.getElementById('iNombreParque').style.display = 'none';
  // Reset patente hint
  const ph = document.getElementById('patenteHint');
  if (ph) ph.textContent = '';
  const pi = document.getElementById('iPatente');
  if (pi) { pi.classList.remove('patente-ok','patente-err'); }
  // Reset financiero
  document.getElementById('iBonoFin').value = '';
  document.getElementById('iPlazo').value   = '48';
  document.getElementById('iTasa').value    = '';
  ['chkCDesg','chkCRdh','chkCCesa','chkCRep','chkCGps'].forEach(id => {
    const el=document.getElementById(id); if(el) el.checked=true;
  });
  credRecalcular();
  // Disable cotizaciones button
  const btnCotiz = document.getElementById('btnVerCotiz');
  if (btnCotiz) btnCotiz.disabled = true;
  vehCargaMarcas(); // recargar marcas
}

/* ─── Modal Éxito ───────────────────────────────────────────────────── */
function successMenuPrincipal() {
  document.getElementById('successOverlay').classList.remove('open');
  cambiarTab('consulta');
}
function successRevisarCredito() {
  if (_savedCreditData?.id_credito) {
    location.href = '/creditos/revisar?id=' + _savedCreditData.id_credito;
  } else {
    document.getElementById('successOverlay').classList.remove('open');
    cambiarTab('consulta');
  }
}
function successTablaAmortizacion() {
  document.getElementById('successOverlay').classList.remove('open');
  if (_savedCreditData) mostrarAmortizacion(_savedCreditData);
}

/* ─── Tabla de Amortización ─────────────────────────────────────────── */
function abrirAmortDesdeDetalle() {
  if (!_detalleData) return;
  mostrarAmortizacion({
    id_credito:          _detalleData.id_credito,
    numero_credito:      _detalleData.numero_credito,
    monto_financiado:    parseFloat(_detalleData.monto_financiado)  || 0,
    tasa_mensual:        parseFloat(_detalleData.tasa_mensual)       || 0,
    plazo:               parseInt(_detalleData.plazo)                || 0,
    fecha_primera_cuota: _detalleData.fecha_primera_cuota            || null,
    cuota:               parseFloat(_detalleData.cuota)              || 0,
  });
}

function mostrarAmortizacion(d) {
  const { numero_credito, monto_financiado, tasa_mensual, plazo, fecha_primera_cuota, cuota } = d;
  if (!monto_financiado || !tasa_mensual || !plazo) {
    showToast('Datos insuficientes para generar la tabla (monto, tasa y plazo son requeridos)', false);
    return;
  }
  document.getElementById('amortNumCred').textContent = numero_credito || '—';

  // ── Resumen
  const totalPagado  = Math.round(cuota) * plazo;
  const totalInteres = totalPagado - Math.round(monto_financiado);
  const fp = v => '$' + Math.round(v).toLocaleString('es-CL');
  document.getElementById('amortSummary').innerHTML = `
    <div class="amort-sum-item"><div class="amort-sum-lbl">Monto Financiado</div><div class="amort-sum-val">${fp(monto_financiado)}</div></div>
    <div class="amort-sum-item"><div class="amort-sum-lbl">Cuota</div><div class="amort-sum-val">${fp(cuota)}</div></div>
    <div class="amort-sum-item"><div class="amort-sum-lbl">Plazo</div><div class="amort-sum-val">${plazo} meses</div></div>
    <div class="amort-sum-item"><div class="amort-sum-lbl">Total Intereses</div><div class="amort-sum-val" style="color:#dc2626">${fp(totalInteres)}</div></div>
    <div class="amort-sum-item"><div class="amort-sum-lbl">Total a Pagar</div><div class="amort-sum-val">${fp(totalPagado)}</div></div>`;

  // ── Generar filas (sistema francés)
  const tasaD = tasa_mensual / 100;
  let saldo   = monto_financiado;
  let sumCap  = 0, sumInt = 0, sumCuota = 0;

  // Fecha inicial
  let fecha = fecha_primera_cuota
    ? new Date(fecha_primera_cuota.split('T')[0] + 'T00:00:00')
    : null;

  const fmtFecha = f => f
    ? f.toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'numeric' })
    : '—';

  let rows = '';
  for (let i = 1; i <= plazo; i++) {
    const interes      = Math.round(saldo * tasaD);
    let   amort        = Math.round(cuota) - interes;
    if (i === plazo)   amort = Math.round(saldo);  // ajuste final
    const cuotaFila    = interes + amort;
    saldo              = Math.max(0, Math.round(saldo - amort));
    sumCap  += amort;  sumInt += interes;  sumCuota += cuotaFila;

    // Avanzar un mes
    const fechaFila = fecha ? new Date(fecha) : null;
    if (fecha) { fecha.setMonth(fecha.getMonth() + 1); }

    rows += `<tr>
      <td class="td-num">${i}</td>
      <td>${fmtFecha(fechaFila)}</td>
      <td class="td-cap">${fp(amort)}</td>
      <td class="td-int">${fp(interes)}</td>
      <td class="td-cuota">${fp(cuotaFila)}</td>
      <td class="td-saldo">${fp(saldo)}</td>
    </tr>`;
  }
  document.getElementById('amortBody').innerHTML = rows;
  document.getElementById('amortFoot').innerHTML = `
    <tr>
      <td colspan="2">TOTAL</td>
      <td>${fp(sumCap)}</td>
      <td>${fp(sumInt)}</td>
      <td>${fp(sumCuota)}</td>
      <td>—</td>
    </tr>`;

  document.getElementById('amortOverlay').classList.add('open');
}

function cerrarAmort() {
  document.getElementById('amortOverlay').classList.remove('open');
}

/* ─── Modo Edición — Carga y helpers ───────────────────────────────── */
async function cargarModoEdicion(idCredito) {
  try {
    const r = await fetch('/api/creditos/' + idCredito, { headers: apiHdr() });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Error al cargar crédito');
    const c = j.data;
    _modoEditar = idCredito;
    _modoEditarNumero = c.numero_credito;

    // Cambiar a tab ingreso forzando AutoFácil (sin redirigir a otras páginas)
    document.querySelectorAll('.tab-card[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'ingreso'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panelIngreso').classList.add('active');
    _tabActual = 'ingreso';
    document.querySelectorAll('.fin-card').forEach(cc => cc.classList.remove('active'));
    const afCard = document.querySelector('.fin-card[data-empresa="AUTOFACIL"]');
    if (afCard) afCard.classList.add('active');
    _setEmpresaIngreso(c.financiera || 'AUTOFACIL');

    // Mostrar banner edición
    document.getElementById('editModeBanner').classList.add('visible');
    document.getElementById('editModeNum').textContent = c.numero_credito || '—';

    // Cambiar texto del botón guardar
    const btnG = document.getElementById('btnGuardarCredito');
    if (btnG) {
      btnG.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Actualizar Crédito';
      btnG.classList.add('btn-guardar-edit');
    }

    // ── Cliente
    document.getElementById('iRut').value          = c.rut_cliente  || '';
    document.getElementById('iNombreCliente').value = c.nombre_cliente || '';
    document.getElementById('iFinanciera').value    = c.financiera   || 'AUTOFACIL';
    setEjecutivoCred(c.ejecutivo || '');
    document.getElementById('iEstado').value        = c.estado       || 'INGRESO';
    document.getElementById('iObservaciones').value = c.observaciones || '';

    // ── Fechas
    if (c.fecha_otorgamiento)  document.getElementById('iFechaOtorg').value         = c.fecha_otorgamiento.split('T')[0];
    if (c.fecha_primera_cuota) document.getElementById('iFechaPrimeraCuota').value  = c.fecha_primera_cuota.split('T')[0];

    // ── Financiero
    const parsePeso = s => s ? String(Math.round(Number(s))).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '';
    document.getElementById('iValorVehiculo').value = parsePeso(c.valor_vehiculo);
    document.getElementById('iPie').value           = parsePeso(c.pie);
    document.getElementById('iPlazo').value         = c.plazo || '48';
    document.getElementById('iTasa').value          = c.tasa_mensual ? Number(c.tasa_mensual).toFixed(2)+'%' : '';

    // ── Vehículo (texto directo)
    document.getElementById('iPatente').value = c.patente || '';
    document.getElementById('iColor').value   = c.color   || '';
    document.getElementById('iMotor').value   = c.motor   || '';
    document.getElementById('iChasis').value  = c.chasis  || '';

    // ── Tipo vehículo
    const iTipoV = document.getElementById('iTipoVehiculo');
    if (c.tipo_vehiculo) iTipoV.value = c.tipo_vehiculo;

    // ── Dealer
    document.getElementById('iDealerBuscar').value = c.dealer || '';
    document.getElementById('iDealer').value       = c.dealer || '';
    if (c.id_dealer) document.getElementById('iDealerId').value = c.id_dealer;

    // ── Ubicación (DB column is nombre_parque_mgmt, VIEW alias is nombre_parque)
    if (c.tipo_ubicacion) setUbicacion(c.tipo_ubicacion);
    const nombreParque = c.nombre_parque || c.nombre_parque_mgmt || '';
    if (nombreParque) document.getElementById('iNombreParque').value = nombreParque;

    // ── Datos JSON (seguros, GPS, etc.)
    try {
      const dj = typeof c.datos_json === 'string' ? JSON.parse(c.datos_json) : (c.datos_json || {});
      if (dj.seguros) {
        const chkD = document.getElementById('chkCDesg'); if (chkD) chkD.checked = dj.seguros.desgravamen ?? true;
        const chkR = document.getElementById('chkCRdh');  if (chkR) chkR.checked = dj.seguros.rdh         ?? true;
        const chkC = document.getElementById('chkCCesa'); if (chkC) chkC.checked = dj.seguros.cesantia    ?? true;
      }
      const chkG = document.getElementById('chkCGps'); if (chkG) chkG.checked = dj.gps          ?? true;
      const chkP = document.getElementById('chkCRep'); if (chkP) chkP.checked = dj.reparaciones  ?? true;
      if (dj.bono_financiamiento) document.getElementById('iBonoFin').value = String(Math.round(dj.bono_financiamiento)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    } catch(_) {}

    // ── Vehículo cascada (marca → modelo → año → transmisión/combustible)
    await vehRestaurar(c.marca, c.modelo, c.anio ? String(c.anio) : null, c.transmision, c.combustible);

    // Recalcular con los datos cargados
    credRecalcular();

    // Habilitar cotizaciones
    const btnCotiz = document.getElementById('btnVerCotiz');
    if (btnCotiz) btnCotiz.disabled = !c.rut_cliente;

    // Scroll al top del panel ingreso
    document.getElementById('panelIngreso').scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch(e) {
    showToast('Error al cargar crédito para edición: ' + e.message, false);
  }
}

function cancelarEdicion() {
  if (_modoEditar) {
    location.href = '/creditos/revisar?id=' + _modoEditar;
  } else {
    _modoEditar = null;
    _modoEditarNumero = null;
    document.getElementById('editModeBanner').classList.remove('visible');
    const btnG = document.getElementById('btnGuardarCredito');
    if (btnG) { btnG.innerHTML = '<i class="bi bi-floppy me-1"></i>Guardar Crédito'; btnG.classList.remove('btn-guardar-edit'); }
    cambiarTab('consulta');
  }
}

/* ─── Ejecutivos (select con default = usuario logueado) ───────────── */
let _ejecutivosCred = [];
async function cargarEjecutivosCred() {
  const sel = document.getElementById('iEjecutivo');
  if (!sel) return;
  try {
    const r = await fetch('/api/cartas-ejecutivos', { headers: apiHdr() });
    const j = await r.json();
    _ejecutivosCred = j.data || [];
  } catch (e) { _ejecutivosCred = []; }
  const prev = sel.value; // preservar valor (ej. modo edición ya cargado)
  sel.innerHTML = '<option value="">— Seleccione —</option>' +
    _ejecutivosCred.map(e => `<option value="${e.nombre}">${e.nombre}</option>`).join('');
  if (prev) { setEjecutivoCred(prev); return; }
  // Default: ejecutivo comercial = usuario logueado (calce por mail; se muestra el nombre)
  if (!_modoEditar) {
    const yo = JSON.parse(sessionStorage.getItem('usuario') || 'null');
    const miMail = yo && yo.email ? yo.email.toLowerCase().trim() : '';
    if (miMail) {
      const m = _ejecutivosCred.find(e => (e.mail || '').toLowerCase().trim() === miMail);
      if (m) sel.value = m.nombre;
    }
  }
}
// Setea el ejecutivo en el select; si no está en la lista, lo agrega como opción
function setEjecutivoCred(nombre) {
  const sel = document.getElementById('iEjecutivo');
  if (!sel) return;
  if (nombre && !Array.from(sel.options).some(o => o.value === nombre)) {
    const o = document.createElement('option');
    o.value = nombre; o.textContent = nombre;
    sel.appendChild(o);
  }
  sel.value = nombre || '';
}

/* ─── Init ─────────────────────────────────────────────────────────── */
llenarMeses();
buscarCreditos(1);
vehCargaMarcas();
credCargarParams();
cargarEjecutivosCred();
// Fechas por defecto
(function() {
  const hoy = new Date().toISOString().split('T')[0];
  const elOtorg = document.getElementById('iFechaOtorg');
  if (elOtorg && !elOtorg.value) elOtorg.value = hoy;
  const el30 = document.getElementById('iFechaPrimeraCuota');
  if (el30 && !el30.value) {
    const d30 = new Date(); d30.setDate(d30.getDate()+30);
    el30.value = d30.toISOString().split('T')[0];
  }
  credActualizarDias();
})();

// ── Detectar ?editar=<id> ── //
(function() {
  const params  = new URLSearchParams(location.search);
  const editId  = params.get('editar');
  if (editId) cargarModoEdicion(editId);
})();

// ── Volver desde actualizar datos: ?rut=<rut> → abrir Ingreso y recargar fechas ── //
(function() {
  const rut = new URLSearchParams(location.search).get('rut');
  if (!rut) return;
  cambiarTab('ingreso');
  const el = document.getElementById('iRut');
  if (el) { el.value = rut; onRutInputCred(el); buscarClienteCred(true); }
})();
// ── Marcar con * los campos obligatorios del Ingreso de Créditos ── //
(function(){ try { _marcarRequeridosCred(); } catch(_){} })();
document.addEventListener('keydown', e => {
  if (e.key==='Escape') { cerrarDetalle(); cerrarCotizaciones(); cerrarAmort(); }
});