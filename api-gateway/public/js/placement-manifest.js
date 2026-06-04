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
  simulador:     { label: 'Simulador Rentabilidad', icon: 'bi-calculator',           color: '#0369a1' },
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
  '/politica/':              { section:'home', href:'/politica/',               icon:'bi-shield-lock',            titulo:'Política de Crédito' },
  '/usuarios/':              { section:'home', href:'/usuarios/',               icon:'bi-people',                 titulo:'Usuarios' },
  '/mantenedores/':          { section:'home', href:'/mantenedores/',           icon:'bi-gear-fill',              titulo:'Mantenedores' },
  '/cartas-aprobacion/':     { section:'home', href:'/cartas-aprobacion/',      icon:'bi-envelope-paper',         titulo:'Cartas de Aprobación' },
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
  'com-revision':            { section:'comisiones',    href:'/comisiones/revision/',   icon:'bi-clipboard-check',       titulo:'Revisión Comisiones' },
  'com-variables':           { section:'comisiones',    href:'/comisiones/variables/',  icon:'bi-sliders2',              titulo:'Variables Comisiones' },
  // ── TESORERÍA ─────────────────────────────────────────────────────────────
  'teso-caja':               { section:'tesoreria',     href:'/tesoreria/caja',                 icon:'bi-cash-coin',         titulo:'Caja' },
  'teso-cajas':              { section:'tesoreria',     href:'/tesoreria/cajas',                icon:'bi-cash-stack',        titulo:'Administración Cajas' },
  'teso-cierre-caja':        { section:'tesoreria',     href:'/tesoreria/cierre-caja',          icon:'bi-journal-check',     titulo:'Cierre de Caja' },
  'teso-cuentas-transitorias':{ section:'tesoreria',    href:'/tesoreria/cuentas-transitorias', icon:'bi-arrow-left-right',  titulo:'Cuentas Transitorias' },
  'teso-brokerage':          { section:'tesoreria',     href:'/tesoreria/brokerage',            icon:'bi-building-check',    titulo:'Brokerage' },
  // ── COBRANZA ──────────────────────────────────────────────────────────────
  'cobr-prejudicial':        { section:'cobranza',      href:'/cobranza/prejudicial', icon:'bi-exclamation-triangle-fill', titulo:'Pre-judicial' },
  'cobr-judicial':           { section:'cobranza',      href:'/cobranza/judicial',    icon:'bi-file-earmark-text-fill',    titulo:'Judicial' },
  'cobr-reporteria':         { section:'cobranza',      href:'/cobranza/reporteria',  icon:'bi-clipboard-data-fill',       titulo:'Reportería Cobranzas' },
  // ── CRM ───────────────────────────────────────────────────────────────────
  'crm-gestiones':           { section:'crm',           href:'/crm/gestiones',    icon:'bi-telephone-fill',  titulo:'Gestiones de Contacto' },
  'crm-estadisticas':        { section:'crm',           href:'/crm/estadisticas', icon:'bi-bar-chart-line',  titulo:'Estadísticas CRM' },
  'crm-campanas':            { section:'crm',           href:'/crm/campanas',     icon:'bi-megaphone-fill',  titulo:'Campañas Outbound' },
  // ── MANTENEDORES ─────────────────────────────────────────────────────────
  'tasas':                   { section:'mantenedores',  href:'/mantenedores/tasas/',              icon:'bi-percent',               titulo:'Tasas de Interés' },
  'uf':                      { section:'mantenedores',  href:'/mantenedores/uf/',                 icon:'bi-currency-dollar',        titulo:'Valores UF' },
  'dealers':                 { section:'mantenedores',  href:'/mantenedores/dealers/',            icon:'bi-building',               titulo:'Dealers' },
  'vehiculos':               { section:'mantenedores',  href:'/mantenedores/vehiculos/',          icon:'bi-car-front',              titulo:'Vehículos' },
  'comunas':                 { section:'mantenedores',  href:'/mantenedores/comunas/',            icon:'bi-geo-alt',                titulo:'Comunas' },
  'parametros':              { section:'mantenedores',  href:'/mantenedores/parametros/',         icon:'bi-sliders',                titulo:'Parámetros Crédito' },
  'factores-seguro':         { section:'mantenedores',  href:'/mantenedores/factores-seguro/',    icon:'bi-shield-check',           titulo:'Factores Seguro' },
  'tipos-documento':         { section:'mantenedores',  href:'/mantenedores/tipos-documento/',    icon:'bi-paperclip',              titulo:'Tipos de Documento' },
  'pagares':                 { section:'mantenedores',  href:'/mantenedores/pagares/',            icon:'bi-file-earmark-text',      titulo:'Pagarés Autofacil' },
  'cuentas-bancarias':       { section:'mantenedores',  href:'/mantenedores/cuentas-bancarias/',  icon:'bi-bank',                   titulo:'Cuentas Bancarias' },
  'parques':                 { section:'mantenedores',  href:'/mantenedores/parques/',            icon:'bi-p-circle',               titulo:'Arriendo Parques' },
  'flujo-brokerage':         { section:'mantenedores',  href:'/mantenedores/flujo-brokerage/',    icon:'bi-diagram-3',              titulo:'Flujo Brokerage' },
  'broker-validaciones':     { section:'mantenedores',  href:'/mantenedores/broker-validaciones/',icon:'bi-card-checklist',         titulo:'Docs Validar Brokers' },
  'financieras':             { section:'mantenedores',  href:'/mantenedores/financieras/',        icon:'bi-calculator',             titulo:'Fórmulas Financieras' },
  'comisiones-seguro':       { section:'mantenedores',  href:'/mantenedores/comisiones-seguro/',  icon:'bi-shield-half',            titulo:'Comisiones Seguro' },
  'bd-clientes':             { section:'mantenedores',  href:'/mantenedores/bd-clientes/',               icon:'bi-database',               titulo:'BD Clientes' },
  'bd-operaciones':          { section:'mantenedores',  href:'/mantenedores/bd-operaciones/',            icon:'bi-database-gear',          titulo:'BD Operaciones' },
  'bd-antecedentes':         { section:'mantenedores',  href:'/mantenedores/bd-antecedentes/',           icon:'bi-briefcase-fill',          titulo:'BD Antecedentes Laborales' },
  'bd-inf-comercial':        { section:'mantenedores',  href:'/mantenedores/bd-informacion-comercial/',  icon:'bi-building-fill',           titulo:'BD Información Comercial' },
  'vista-pantallas':         { section:'mantenedores',  href:'/mantenedores/vista-pantallas/',    icon:'bi-layout-wtf',             titulo:'Vista Pantallas' },
  'solo-dios':               { section:'mantenedores',  href:'/mantenedores/solo-dios/',          icon:'bi-lightning-charge-fill',  titulo:'SOLO DIOS' },
};

async function loadPlacementConfig(headers) {
  try {
    const r = await fetch('/api/config/ui/placement_v2', { headers });
    const d = await r.json();
    return (d.success && d.data && typeof d.data === 'object') ? d.data : {};
  } catch { return {}; }
}
