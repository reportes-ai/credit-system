// Manifiesto central de todos los sub-items por sección
// Los módulos del HOME vienen de /api/auth/mis-permisos (BD dinámica)
// Los sub-items de cada sección están acá definidos estáticamente

const PLACEMENT_SECTIONS = {
  home:         { label: 'HOME',         icon: 'bi-house-door-fill',       color: '#1a3a6a' },
  mantenedores: { label: 'Mantenedores', icon: 'bi-gear-fill',             color: '#374151' },
  tesoreria:    { label: 'Tesorería',    icon: 'bi-cash-stack',            color: '#065f46' },
  cobranza:     { label: 'Cobranza',     icon: 'bi-bell-fill',             color: '#92400e' },
  crm:          { label: 'CRM',          icon: 'bi-people-fill',           color: '#1e40af' },
};

const PLACEMENT_ITEMS = {
  // ── MANTENEDORES ─────────────────────────────────────────────────────────
  'tasas':              { section:'mantenedores', href:'/mantenedores/tasas/',            icon:'bi-percent',               titulo:'Tasas de Interés',          desc:'Gestión de tasas mensuales y anuales para créditos' },
  'uf':                 { section:'mantenedores', href:'/mantenedores/uf/',               icon:'bi-currency-dollar',        titulo:'Valores UF',                desc:'Registro y consulta del valor de la Unidad de Fomento' },
  'dealers':            { section:'mantenedores', href:'/mantenedores/dealers/',          icon:'bi-building',               titulo:'Dealers',                   desc:'Administración de concesionarios y datos de contacto' },
  'vehiculos':          { section:'mantenedores', href:'/mantenedores/vehiculos/',        icon:'bi-car-front',              titulo:'Vehículos',                 desc:'Base de tasación SII con marcas, modelos y valores' },
  'comunas':            { section:'mantenedores', href:'/mantenedores/comunas/',          icon:'bi-geo-alt',                titulo:'Comunas',                   desc:'Gestión de regiones, provincias y comunas de Chile' },
  'parametros':         { section:'mantenedores', href:'/mantenedores/parametros/',       icon:'bi-sliders',                titulo:'Parámetros Crédito',        desc:'Gastos operacionales fijos y comisiones del crédito' },
  'factores-seguro':    { section:'mantenedores', href:'/mantenedores/factores-seguro/',  icon:'bi-shield-check',           titulo:'Factores Seguro',           desc:'Tasas netas, factores calculados y comisiones por plazo' },
  'tipos-documento':    { section:'mantenedores', href:'/mantenedores/tipos-documento/',  icon:'bi-paperclip',              titulo:'Tipos de Documento',        desc:'Documentos de respaldo requeridos en aprobación' },
  'pagares':            { section:'mantenedores', href:'/mantenedores/pagares/',          icon:'bi-file-earmark-text',      titulo:'Pagarés Autofacil',         desc:'Plantillas de Hoja Resumen, Contrato, Pagaré y Mandatos' },
  'cuentas-bancarias':  { section:'mantenedores', href:'/mantenedores/cuentas-bancarias/',icon:'bi-bank',                   titulo:'Cuentas Bancarias',         desc:'Banco, RUT y número de cuenta para pagos' },
  'parques':            { section:'mantenedores', href:'/mantenedores/parques/',          icon:'bi-p-circle',               titulo:'Arriendo y Comisión Parques',desc:'Arriendo mensual y comisión por parque' },
  'flujo-brokerage':    { section:'mantenedores', href:'/mantenedores/flujo-brokerage/',  icon:'bi-diagram-3',              titulo:'Flujo Crédito Brokerage',   desc:'Estados, etapas y documentos del flujo brokereado' },
  'broker-validaciones':{ section:'mantenedores', href:'/mantenedores/broker-validaciones/',icon:'bi-card-checklist',       titulo:'Docs a Validar Brokers',    desc:'Ítems de validación documental requeridos' },
  'financieras':        { section:'mantenedores', href:'/mantenedores/financieras/',      icon:'bi-calculator',             titulo:'Fórmulas Financieras',      desc:'Parámetros de cálculo de ingresos y comisiones' },
  'comisiones-seguro':  { section:'mantenedores', href:'/mantenedores/comisiones-seguro/',icon:'bi-shield-check',           titulo:'Comisiones de Seguro',      desc:'Porcentajes de comisión sobre prima por plazo' },
  'politica':           { section:'mantenedores', href:'/politica/',                      icon:'bi-shield-lock',            titulo:'Política de Crédito',       desc:'Política de crédito AutoFácil' },
  'carga-masiva':       { section:'mantenedores', href:'/carga-masiva/',                  icon:'bi-cloud-upload',           titulo:'Carga Masiva',              desc:'Importación masiva de operaciones desde Excel' },
  'vista-pantallas':    { section:'mantenedores', href:'/mantenedores/vista-pantallas/',  icon:'bi-layout-wtf',             titulo:'Vista Pantallas',           desc:'Configura dónde aparece cada módulo del sistema' },
  'solo-dios':          { section:'mantenedores', href:'/mantenedores/solo-dios/',        icon:'bi-lightning-charge-fill',  titulo:'SOLO DIOS',                 desc:'Acceso directo a la BD sin filtros' },
  // ── TESORERÍA ─────────────────────────────────────────────────────────────
  'teso-caja':              { section:'tesoreria', href:'/tesoreria/caja',                icon:'bi-cash-coin',              titulo:'Caja',                      desc:'Pago de cuotas de créditos desde la caja asignada' },
  'teso-cajas':             { section:'tesoreria', href:'/tesoreria/cajas',               icon:'bi-cash-stack',             titulo:'Administración de Cajas',   desc:'Gestión de cajas y permisos por usuario cajero' },
  'teso-cierre-caja':       { section:'tesoreria', href:'/tesoreria/cierre-caja',         icon:'bi-journal-check',          titulo:'Cierre de Caja',            desc:'Movimientos por fecha, usuario o total de cajas' },
  'teso-cuentas-transitorias':{ section:'tesoreria', href:'/tesoreria/cuentas-transitorias',icon:'bi-arrow-left-right',    titulo:'Cuentas Transitorias',      desc:'Saldos a favor de clientes por pagos en exceso' },
  'teso-brokerage':         { section:'tesoreria', href:'/tesoreria/brokerage',           icon:'bi-building-check',         titulo:'Brokerage',                 desc:'Facturas de dealers, pagos y transferencias' },
  // ── COBRANZA ──────────────────────────────────────────────────────────────
  'cobr-prejudicial': { section:'cobranza', href:'/cobranza/prejudicial', icon:'bi-exclamation-triangle-fill', titulo:'Pre-judicial',        desc:'Créditos en mora entre 1 y 90 días' },
  'cobr-judicial':    { section:'cobranza', href:'/cobranza/judicial',    icon:'bi-file-earmark-text-fill',    titulo:'Judicial',            desc:'Créditos con 91+ días de mora, acciones legales' },
  'cobr-reporteria':  { section:'cobranza', href:'/cobranza/reporteria',  icon:'bi-clipboard-data-fill',       titulo:'Reportería Cobranzas',desc:'Reportes de gestión, rendimiento y moras históricas' },
  // ── CRM ───────────────────────────────────────────────────────────────────
  'crm-gestiones':    { section:'crm', href:'/crm/gestiones',    icon:'bi-telephone-fill', titulo:'Gestiones de Contacto', desc:'Interacciones con clientes: inbound, outbound, leads' },
  'crm-estadisticas': { section:'crm', href:'/crm/estadisticas', icon:'bi-bar-chart-line', titulo:'Estadísticas CRM',      desc:'Dashboard de rendimiento por ejecutivo y canal' },
  'crm-campanas':     { section:'crm', href:'/crm/campanas',     icon:'bi-megaphone-fill', titulo:'Campañas de Outbound',  desc:'Crea y gestiona campañas de contacto masivo' },
};

// Dado el config placement_v2, devuelve el section efectivo de un item
function effectiveSection(itemKey, placement) {
  return (placement && placement[itemKey]) ? placement[itemKey] : PLACEMENT_ITEMS[itemKey]?.section;
}

// Carga el placement guardado desde config_ui
async function loadPlacementConfig(headers) {
  try {
    const r = await fetch('/api/config/ui/placement_v2', { headers });
    const d = await r.json();
    return (d.success && d.data && typeof d.data === 'object') ? d.data : {};
  } catch { return {}; }
}
