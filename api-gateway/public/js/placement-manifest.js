// Manifiesto central — todos los sub-items conocidos del sistema
// Los módulos del HOME son dinámicos (BD), no están aquí

const PLACEMENT_SECTIONS = {
  home:         { label: 'HOME',         icon: 'bi-house-door-fill',  color: '#1a3a6a' },
  mantenedores: { label: 'Mantenedores', icon: 'bi-gear-fill',        color: '#374151' },
  comisiones:   { label: 'Comisiones',   icon: 'bi-cash-coin',        color: '#065f46' },
  tesoreria:    { label: 'Tesorería',    icon: 'bi-safe2',            color: '#78350f' },
  cobranza:     { label: 'Cobranza',     icon: 'bi-bell-fill',        color: '#7f1d1d' },
  crm:          { label: 'CRM',          icon: 'bi-people-fill',      color: '#1e3a8a' },
};

const PLACEMENT_ITEMS = {
  // ── MANTENEDORES ─────────────────────────────────────────────────────────
  'tasas':              { section:'mantenedores', href:'/mantenedores/tasas/',            icon:'bi-percent',               titulo:'Tasas de Interés' },
  'uf':                 { section:'mantenedores', href:'/mantenedores/uf/',               icon:'bi-currency-dollar',        titulo:'Valores UF' },
  'dealers':            { section:'mantenedores', href:'/mantenedores/dealers/',          icon:'bi-building',               titulo:'Dealers' },
  'vehiculos':          { section:'mantenedores', href:'/mantenedores/vehiculos/',        icon:'bi-car-front',              titulo:'Vehículos' },
  'comunas':            { section:'mantenedores', href:'/mantenedores/comunas/',          icon:'bi-geo-alt',                titulo:'Comunas' },
  'parametros':         { section:'mantenedores', href:'/mantenedores/parametros/',       icon:'bi-sliders',                titulo:'Parámetros Crédito' },
  'factores-seguro':    { section:'mantenedores', href:'/mantenedores/factores-seguro/',  icon:'bi-shield-check',           titulo:'Factores Seguro' },
  'tipos-documento':    { section:'mantenedores', href:'/mantenedores/tipos-documento/',  icon:'bi-paperclip',              titulo:'Tipos de Documento' },
  'pagares':            { section:'mantenedores', href:'/mantenedores/pagares/',          icon:'bi-file-earmark-text',      titulo:'Pagarés Autofacil' },
  'cuentas-bancarias':  { section:'mantenedores', href:'/mantenedores/cuentas-bancarias/',icon:'bi-bank',                   titulo:'Cuentas Bancarias' },
  'parques':            { section:'mantenedores', href:'/mantenedores/parques/',          icon:'bi-p-circle',               titulo:'Arriendo Parques' },
  'flujo-brokerage':    { section:'mantenedores', href:'/mantenedores/flujo-brokerage/',  icon:'bi-diagram-3',              titulo:'Flujo Brokerage' },
  'broker-validaciones':{ section:'mantenedores', href:'/mantenedores/broker-validaciones/',icon:'bi-card-checklist',       titulo:'Docs Validar Brokers' },
  'financieras':        { section:'mantenedores', href:'/mantenedores/financieras/',      icon:'bi-calculator',             titulo:'Fórmulas Financieras' },
  'comisiones-seguro':  { section:'mantenedores', href:'/mantenedores/comisiones-seguro/',icon:'bi-shield-half',            titulo:'Comisiones Seguro' },
  'bd-clientes':        { section:'mantenedores', href:'/mantenedores/bd-clientes/',      icon:'bi-database',               titulo:'BD Clientes' },
  'bd-operaciones':     { section:'mantenedores', href:'/mantenedores/bd-operaciones/',   icon:'bi-database-gear',          titulo:'BD Operaciones' },
  'politica':           { section:'mantenedores', href:'/politica/',                      icon:'bi-shield-lock',            titulo:'Política de Crédito' },
  'carga-masiva':       { section:'mantenedores', href:'/carga-masiva/',                  icon:'bi-cloud-upload',           titulo:'Carga Masiva' },
  'vista-pantallas':    { section:'mantenedores', href:'/mantenedores/vista-pantallas/',  icon:'bi-layout-wtf',             titulo:'Vista Pantallas' },
  'solo-dios':          { section:'mantenedores', href:'/mantenedores/solo-dios/',        icon:'bi-lightning-charge-fill',  titulo:'SOLO DIOS' },
  // ── COMISIONES ────────────────────────────────────────────────────────────
  'com-revision':       { section:'comisiones', href:'/comisiones/revision/',   icon:'bi-clipboard-check',  titulo:'Revisión Comisiones' },
  'com-variables':      { section:'comisiones', href:'/comisiones/variables/',  icon:'bi-sliders2',          titulo:'Variables Comisiones' },
  // ── TESORERÍA ─────────────────────────────────────────────────────────────
  'teso-caja':              { section:'tesoreria', href:'/tesoreria/caja',                icon:'bi-cash-coin',        titulo:'Caja' },
  'teso-cajas':             { section:'tesoreria', href:'/tesoreria/cajas',               icon:'bi-cash-stack',       titulo:'Administración Cajas' },
  'teso-cierre-caja':       { section:'tesoreria', href:'/tesoreria/cierre-caja',         icon:'bi-journal-check',    titulo:'Cierre de Caja' },
  'teso-cuentas-transitorias':{ section:'tesoreria', href:'/tesoreria/cuentas-transitorias',icon:'bi-arrow-left-right',titulo:'Cuentas Transitorias' },
  'teso-brokerage':         { section:'tesoreria', href:'/tesoreria/brokerage',           icon:'bi-building-check',   titulo:'Brokerage' },
  // ── COBRANZA ──────────────────────────────────────────────────────────────
  'cobr-prejudicial': { section:'cobranza', href:'/cobranza/prejudicial', icon:'bi-exclamation-triangle-fill', titulo:'Pre-judicial' },
  'cobr-judicial':    { section:'cobranza', href:'/cobranza/judicial',    icon:'bi-file-earmark-text-fill',    titulo:'Judicial' },
  'cobr-reporteria':  { section:'cobranza', href:'/cobranza/reporteria',  icon:'bi-clipboard-data-fill',       titulo:'Reportería Cobranzas' },
  // ── CRM ───────────────────────────────────────────────────────────────────
  'crm-gestiones':    { section:'crm', href:'/crm/gestiones',    icon:'bi-telephone-fill', titulo:'Gestiones de Contacto' },
  'crm-estadisticas': { section:'crm', href:'/crm/estadisticas', icon:'bi-bar-chart-line', titulo:'Estadísticas CRM' },
  'crm-campanas':     { section:'crm', href:'/crm/campanas',     icon:'bi-megaphone-fill', titulo:'Campañas Outbound' },
};

async function loadPlacementConfig(headers) {
  try {
    const r = await fetch('/api/config/ui/placement_v2', { headers });
    const d = await r.json();
    return (d.success && d.data && typeof d.data === 'object') ? d.data : {};
  } catch { return {}; }
}
