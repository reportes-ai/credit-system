// Manifiesto central — secciones y sub-items conocidos del sistema

const PLACEMENT_SECTIONS = {
  home:          { label: 'HOME',                 icon: 'bi-house-door-fill',        color: '#1a3a6a' },
  clientes:      { label: 'Clientes',             icon: 'bi-people-fill',            color: '#1e40af' },
  cotizaciones:  { label: 'Cotizaciones',         icon: 'bi-calculator',             color: '#1d4ed8' },
  creditos:      { label: 'Créditos',             icon: 'bi-credit-card-2-front',    color: '#1e3a5f' },
  tesoreria:     { label: 'Tesorería',            icon: 'bi-safe2',                  color: '#78350f' },
  crm:           { label: 'CRM',                  icon: 'bi-headset',                color: '#1e3a8a' },
  cobranza:      { label: 'Cobranza',             icon: 'bi-bell-fill',              color: '#7f1d1d' },
  reporteria:    { label: 'Reportería',           icon: 'bi-bar-chart-line-fill',    color: '#064e3b' },
  comisiones:    { label: 'Comisión Ejecutivos',   icon: 'bi-cash-coin',              color: '#065f46' },
  mantenedores:  { label: 'Mantenedores',         icon: 'bi-gear-fill',              color: '#374151' },
  usuarios:      { label: 'Usuarios',             icon: 'bi-people',                 color: '#4b5563' },
  cartas:        { label: 'Cartas de Aprobación', icon: 'bi-envelope-paper',         color: '#5b21b6' },
  politica:      { label: 'Política',             icon: 'bi-shield-lock',            color: '#7c3aed' },
  simulador:     { label: 'Simulador Rentabilidad', icon: 'bi-calculator',            color: '#0369a1' },
  carga_masiva:  { label: 'Carga Masiva',         icon: 'bi-cloud-upload',           color: '#0f766e' },
};

const PLACEMENT_ITEMS = {
  // ── HOME — chips de módulos que aparecen en la pantalla inicial ───────────
  '/clientes/':              { section:'home', href:'/clientes/',               icon:'bi-people-fill',            titulo:'Clientes' },
  '/cotizaciones/':          { section:'home', href:'/cotizaciones/',           icon:'bi-calculator',             titulo:'Cotizaciones' },
  '/creditos/':              { section:'home', href:'/creditos/',               icon:'bi-credit-card-2-front',    titulo:'Créditos' },
  '/tesoreria/':             { section:'home', href:'/tesoreria/',              icon:'bi-safe2',                  titulo:'Tesorería' },
  '/crm/':                   { section:'home', href:'/crm/',                    icon:'bi-headset',                titulo:'CRM' },
  '/cobranza/':              { section:'home', href:'/cobranza/',               icon:'bi-bell-fill',              titulo:'Cobranza' },
  '/reporteria/':            { section:'home', href:'/reporteria/',             icon:'bi-bar-chart-line-fill',    titulo:'Reportería' },
  '/politica/':              { section:'home', href:'/politica/',               icon:'bi-shield-lock',            titulo:'Política' },
  '/usuarios/':              { section:'home', href:'/usuarios/',               icon:'bi-people',                 titulo:'Usuarios' },
  '/mantenedores/':          { section:'home', href:'/mantenedores/',           icon:'bi-gear-fill',              titulo:'Mantenedores' },
  '/cartas-aprobacion/':     { section:'home', href:'/cartas-aprobacion/',      icon:'bi-envelope-paper',         titulo:'Cartas de Aprobación Antiguo' },
  '/comisiones/':            { section:'home', href:'/comisiones/',             icon:'bi-cash-coin',              titulo:'Comisión Ejecutivos' },
  '/carga-masiva/':          { section:'home', href:'/carga-masiva/',           icon:'bi-cloud-upload',           titulo:'Carga Masiva' },
  '/simulador/':             { section:'home', href:'/simulador/',              icon:'bi-calculator',             titulo:'Simulador Rentabilidad' },
  // ── CLIENTES — sub-páginas ────────────────────────────────────────────────
  'ant-laborales':           { section:'clientes',      href:'/antecedentes-laborales/', icon:'bi-briefcase',             titulo:'Antecedentes Laborales' },
  'inf-comercial':           { section:'clientes',      href:'/informacion-comercial/',  icon:'bi-building',              titulo:'Información Comercial' },
  // ── COTIZACIONES — sub-páginas ────────────────────────────────────────────
  // (sin sub-páginas actualmente)
  // ── CRÉDITOS — sub-páginas ────────────────────────────────────────────────
  // (sin sub-páginas actualmente)
  // ── COMISIONES ────────────────────────────────────────────────────────────
  'com-revision':            { section:'comisiones',    href:'/comisiones/revision/',   icon:'bi-clipboard-check',       titulo:'Revisión y Aprobación Comisiones' },
  'com-variables':           { section:'comisiones',    href:'/comisiones/variables/',  icon:'bi-sliders2',              titulo:'Mantenedor Variables Comisiones' },
  // ── TESORERÍA ─────────────────────────────────────────────────────────────
  'teso-caja':               { section:'tesoreria',     href:'/tesoreria/caja',                 icon:'bi-cash-coin',         titulo:'Caja' },
  'teso-cajas':              { section:'tesoreria',     href:'/tesoreria/cajas',                icon:'bi-cash-stack',        titulo:'Administración de Cajas' },
  'teso-cierre-caja':        { section:'tesoreria',     href:'/tesoreria/cierre-caja',          icon:'bi-journal-check',     titulo:'Cierre de Caja' },
  'teso-cuentas-transitorias':{ section:'tesoreria',    href:'/tesoreria/cuentas-transitorias', icon:'bi-arrow-left-right',  titulo:'Cuentas Transitorias' },
  'teso-brokerage':          { section:'tesoreria',     href:'/tesoreria/brokerage',            icon:'bi-building-check',    titulo:'Panel Brokerage Tesorería' },
  // ── COBRANZA ──────────────────────────────────────────────────────────────
  'cobr-prejudicial':        { section:'cobranza',      href:'/cobranza/prejudicial', icon:'bi-exclamation-triangle-fill', titulo:'Pre-judicial' },
  'cobr-judicial':           { section:'cobranza',      href:'/cobranza/judicial',    icon:'bi-file-earmark-text-fill',    titulo:'Judicial' },
  'cobr-reporteria':         { section:'cobranza',      href:'/cobranza/reporteria',  icon:'bi-clipboard-data-fill',       titulo:'Reportería Cobranzas' },
  // ── CRM ───────────────────────────────────────────────────────────────────
  'crm-gestiones':           { section:'crm',           href:'/crm/gestiones',    icon:'bi-telephone-fill',  titulo:'Gestiones de Contacto' },
  'crm-estadisticas':        { section:'crm',           href:'/crm/estadisticas', icon:'bi-bar-chart-line',  titulo:'Estadísticas CRM' },
  'crm-campanas':            { section:'crm',           href:'/crm/campanas',     icon:'bi-megaphone-fill',  titulo:'Campañas de Outbound' },
  // ── MANTENEDORES ─────────────────────────────────────────────────────────
  'tasas':                   { section:'mantenedores',  href:'/mantenedores/tasas/',              icon:'bi-percent',               titulo:'Tasas de Interés' },
  'uf':                      { section:'mantenedores',  href:'/mantenedores/uf/',                 icon:'bi-currency-dollar',        titulo:'Valores UF' },
  'dealers':                 { section:'home',          href:'/mantenedores/dealers/',            icon:'bi-building',               titulo:'Dealers' },
  'vehiculos':               { section:'mantenedores',  href:'/mantenedores/vehiculos/',          icon:'bi-car-front',              titulo:'Vehículos' },
  'comunas':                 { section:'mantenedores',  href:'/mantenedores/comunas/',            icon:'bi-geo-alt',                titulo:'Comunas' },
  'parametros':              { section:'mantenedores',  href:'/mantenedores/parametros/',         icon:'bi-sliders',                titulo:'Parámetros Crédito' },
  'factores-seguro':         { section:'mantenedores',  href:'/mantenedores/factores-seguro/',    icon:'bi-shield-check',           titulo:'Factores Seguro' },
  'tipos-documento':         { section:'mantenedores',  href:'/mantenedores/tipos-documento/',    icon:'bi-paperclip',              titulo:'Tipos de Documento' },
  'pagares':                 { section:'mantenedores',  href:'/mantenedores/pagares/',            icon:'bi-file-earmark-text',      titulo:'Pagarés AutoFácil' },
  'cuentas-bancarias':       { section:'mantenedores',  href:'/mantenedores/cuentas-bancarias/',  icon:'bi-bank',                   titulo:'Cuentas Bancarias' },
  'parques':                 { section:'mantenedores',  href:'/mantenedores/parques/',            icon:'bi-p-circle',               titulo:'Arriendo y Comisión Parques' },
  'flujo-brokerage':         { section:'mantenedores',  href:'/mantenedores/flujo-brokerage/',    icon:'bi-diagram-3',              titulo:'Flujo Crédito Brokerage' },
  'broker-validaciones':     { section:'mantenedores',  href:'/mantenedores/broker-validaciones/',icon:'bi-card-checklist',         titulo:'Documentos a Validar Brokers' },
  'financieras':             { section:'mantenedores',  href:'/mantenedores/financieras/',        icon:'bi-calculator',             titulo:'Fórmulas Financieras' },
  'comisiones-seguro':       { section:'mantenedores',  href:'/mantenedores/comisiones-seguro/',  icon:'bi-umbrella',               titulo:'Comisiones de Seguro' },
  'productos-financiera':    { section:'mantenedores',  href:'/mantenedores/productos-financiera/', icon:'bi-tags-fill',              titulo:'Productos Financiera' },
  'informes-dealernet':      { section:'clientes',      href:'/informes-dealernet/',                 icon:'bi-file-earmark-bar-graph-fill', titulo:'Informes Dealernet' },
  'bd-clientes':             { section:'mantenedores',  href:'/mantenedores/bd-clientes/',               icon:'bi-database',               titulo:'BD Clientes' },
  'bd-operaciones':          { section:'mantenedores',  href:'/mantenedores/bd-operaciones/',            icon:'bi-database-gear',          titulo:'BD Operaciones' },
  'bd-antecedentes':         { section:'mantenedores',  href:'/mantenedores/bd-antecedentes/',           icon:'bi-briefcase-fill',          titulo:'BD Antecedentes Laborales' },
  'bd-inf-comercial':        { section:'mantenedores',  href:'/mantenedores/bd-informacion-comercial/',  icon:'bi-building-fill',           titulo:'BD Información Comercial' },
  'vista-pantallas':         { section:'mantenedores',  href:'/mantenedores/vista-pantallas/',    icon:'bi-layout-wtf',             titulo:'Vista Pantallas' },
  'presupuesto':             { section:'mantenedores',  href:'/mantenedores/presupuesto/',        icon:'bi-clipboard-data',         titulo:'Presupuesto' },
  'ayuda':                   { section:'mantenedores',  href:'/mantenedores/ayuda/',              icon:'bi-question-circle',        titulo:'Ayuda' },
  'alertas':                 { section:'mantenedores',  href:'/mantenedores/alertas/',            icon:'bi-bell-fill',              titulo:'Alertas' },
  'solo-dios':               { section:'mantenedores',  href:'/mantenedores/solo-dios/',          icon:'bi-lightning-charge-fill',  titulo:'SOLO DIOS' },
  'dealer-categorias':       { section:'mantenedores',  href:'/mantenedores/dealer-categorias/',  icon:'bi-award',                  titulo:'Categoría y Potencial Dealer' },
  'impuestos':               { section:'mantenedores',  href:'/mantenedores/impuestos/',          icon:'bi-percent',                titulo:'Impuestos' },
  'definiciones':            { section:'mantenedores',  href:'/mantenedores/definiciones/',       icon:'bi-book',                   titulo:'Definiciones' },
  'feriados':                { section:'mantenedores',  href:'/mantenedores/feriados/',           icon:'bi-calendar-event',         titulo:'Feriados' },
  'estado-creditos':         { section:'mantenedores',  href:'/mantenedores/estado-creditos/',    icon:'bi-diagram-3',              titulo:'Etapas y Estados Créditos' },
  'cobranza-parametros':     { section:'mantenedores',  href:'/mantenedores/cobranza-parametros/',icon:'bi-sliders2',               titulo:'Parámetros Cobranza' },
  'preferencia-financiera':  { section:'mantenedores',  href:'/mantenedores/preferencia-financiera/', icon:'bi-bank2',              titulo:'Preferencia Financiera' },
  'respuestas-rapidas':      { section:'mantenedores',  href:'/mantenedores/respuestas-rapidas/', icon:'bi-chat-dots',              titulo:'Respuestas Rápidas del Chat' },
  'alertas-saldos':          { section:'mantenedores',  href:'/mantenedores/alertas-saldos/',     icon:'bi-bell',                   titulo:'Alertas Saldos Precio' },
  'dealernet':               { section:'mantenedores',  href:'/mantenedores/dealernet/',          icon:'bi-cloud-arrow-down',       titulo:'Mantenedor DealerNet' },
  // ── CARGA MASIVA ──────────────────────────────────────────────────────────
  'cm-cargar':               { section:'carga_masiva',  href:'/carga-masiva/#secAutofacil',       icon:'bi-upload',                 titulo:'Cargar' },
  'cm-trinidad':             { section:'carga_masiva',  href:'/carga-masiva/#secTrinidad',        icon:'bi-cloud-arrow-up',         titulo:'Carga Trinidad' },
  'cm-eq-estados':           { section:'carga_masiva',  href:'/carga-masiva/#secEqEstados',       icon:'bi-arrow-left-right',       titulo:'Equivalencias Trinidad' },
  'cm-eq-ejecs':             { section:'carga_masiva',  href:'/carga-masiva/#secEqEjecs',         icon:'bi-person-lines-fill',      titulo:'Equivalencia Ejecutivos' },
  'cm-historial':            { section:'carga_masiva',  href:'/carga-masiva/#secHistorial',       icon:'bi-clock-history',          titulo:'Historial' },
};

// Descripciones (subtítulo) por key — se muestran cuando un sub-item se coloca en Home.
const PLACEMENT_DESCS = {
  // Clientes
  'ant-laborales':'Antecedentes laborales del cliente', 'inf-comercial':'Información comercial y perfil de deudas',
  'informes-dealernet':'Informes de la integración DealerNet',
  // Comisiones
  'com-revision':'Revisión y aprobación de comisiones de ejecutivos', 'com-variables':'Variables y parámetros del cálculo de comisiones',
  // Tesorería
  'teso-caja':'Operación de caja diaria', 'teso-cajas':'Administración de cajas', 'teso-cierre-caja':'Cierre y cuadratura de caja',
  'teso-cuentas-transitorias':'Conciliación de cuentas transitorias', 'teso-brokerage':'Panel de tesorería brokerage',
  // Cobranza
  'cobr-prejudicial':'Gestión de cobranza pre-judicial', 'cobr-judicial':'Gestión de cobranza judicial', 'cobr-reporteria':'Reportería de cobranzas',
  // CRM
  'crm-gestiones':'Gestiones de contacto con clientes', 'crm-estadisticas':'Estadísticas y métricas de CRM', 'crm-campanas':'Campañas de contacto saliente',
  // Mantenedores
  'tasas':'Gestión de tasas mensuales y anuales para créditos', 'uf':'Registro y consulta del valor de la UF',
  'dealers':'Administración de concesionarios y datos de contacto', 'vehiculos':'Base de tasación SII con marcas, modelos y valores',
  'comunas':'Gestión de regiones, provincias y comunas de Chile', 'parametros':'Gastos operacionales fijos y comisiones del crédito',
  'factores-seguro':'Tasas netas, factores y comisiones por plazo', 'tipos-documento':'Documentos de respaldo requeridos en la aprobación',
  'pagares':'Plantillas de Hoja Resumen, Contrato, Pagaré y Mandatos', 'cuentas-bancarias':'Razón social, RUT, banco y cuenta para transferencias',
  'parques':'Arriendo mensual y porcentaje de comisión por parque', 'flujo-brokerage':'Estados, etapas y documentos del flujo brokerage',
  'broker-validaciones':'Ítems de validación documental AUTOFIN y UAC', 'financieras':'Parámetros de cálculo de ingresos AutoFin y UAC',
  'comisiones-seguro':'Porcentajes de comisión por Desgravamen y Cesantía', 'productos-financiera':'Productos disponibles en la digitación por financiera',
  'bd-clientes':'Base de datos de clientes', 'bd-operaciones':'Base de datos de operaciones de crédito',
  'bd-antecedentes':'Base de datos de antecedentes laborales', 'bd-inf-comercial':'Base de datos de información comercial',
  'vista-pantallas':'Configura qué cards aparecen en Home y cada sección', 'presupuesto':'Presupuesto y metas del periodo',
  'servidor-hora':'Hora de BD, servidor y navegador; offsets y ajuste manual de zona',
  'ayuda':'Documentación y ayuda del sistema', 'alertas':'Configuración de alertas del sistema',
  'solo-dios':'Acceso directo a la BD sin filtros — edición total', 'dealer-categorias':'Niveles, metas y potencial de venta por dealer',
  'impuestos':'IVA y retención de honorarios (paramétrico)', 'definiciones':'Glosario de términos del sistema',
  'feriados':'Calendario de feriados para cálculos de plazos', 'estado-creditos':'Etapas y estados del crédito y sus transiciones',
  'cobranza-parametros':'Tramos de mora, provisiones y parámetros de cobranza', 'preferencia-financiera':'Orden de preferencia de financieras',
  'respuestas-rapidas':'Respuestas predefinidas del chat de atención', 'alertas-saldos':'Alertas por saldos de precio pendientes',
  'dealernet':'Productos y costos de la integración DealerNet',
  // Carga Masiva
  'cm-cargar':'Carga masiva de operaciones (Excel)', 'cm-trinidad':'Carga de archivos Trinidad', 'cm-eq-estados':'Equivalencias de estados Trinidad',
  'cm-eq-ejecs':'Equivalencia de ejecutivos', 'cm-historial':'Historial de cargas masivas',
};

// ── Registro COMBINADO de sub-items: manifiesto (curado) + funcionalidades de BD ──
// Evita que el manifiesto se desincronice: cualquier funcionalidad con href que el
// manifiesto no cubra se agrega sola (clave = último segmento del href). El manifiesto
// "manda" cuando coincide el href (permite títulos/íconos/secciones curados).
function _phNorm(r) { return r ? (r.endsWith('/') ? r : r + '/') : r; }

function sectionFromHref(href) {
  const h = (href || '').toLowerCase();
  if (h.startsWith('/mantenedores/')) return 'mantenedores';
  if (h.startsWith('/tesoreria/'))    return 'tesoreria';
  if (h.startsWith('/cobranza/'))     return 'cobranza';
  if (h.startsWith('/crm/'))          return 'crm';
  if (h.startsWith('/comisiones/'))   return 'comisiones';
  if (h.startsWith('/carga-masiva/')) return 'carga_masiva';
  if (h.startsWith('/clientes/') || h.startsWith('/antecedentes-laborales/') || h.startsWith('/informacion-comercial/')) return 'clientes';
  return 'home';
}

function buildPlacementItems(funcionalidadesInfo, moduleRoutes) {
  const items = {};
  for (const [k, v] of Object.entries(PLACEMENT_ITEMS)) items[k] = { ...v, desc: PLACEMENT_DESCS[k] || v.desc || '' };
  const cubiertos = new Set(Object.values(items).map(i => _phNorm(i.href)));
  const mods = moduleRoutes instanceof Set ? moduleRoutes : new Set(moduleRoutes || []);
  (funcionalidadesInfo || []).forEach(f => {
    if (!f || !f.href) return;                          // permisos de acción (href null) → no son cards
    const h = _phNorm(f.href);
    if (cubiertos.has(h) || mods.has(h)) return;        // ya cubierto por el manifiesto o es un módulo
    const seg = String(f.href).replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!seg || items[seg]) return;                     // sin segmento o choque de clave
    items[seg] = { section: sectionFromHref(f.href), href: f.href, icon: f.icono || 'bi-grid', titulo: f.nombre || seg, desc: PLACEMENT_DESCS[seg] || '' };
    cubiertos.add(h);
  });
  return items;
}

async function loadPlacementConfig(headers) {
  try {
    const r = await fetch('/api/config/ui/placement_v2', { headers });
    const d = await r.json();
    return (d.success && d.data && typeof d.data === 'object') ? d.data : {};
  } catch { return {}; }
}
