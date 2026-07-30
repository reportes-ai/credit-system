'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   WORKFLOWS Y ESCALAMIENTO — mantenedor central (/mantenedores/workflows/)
   Un solo lugar donde el Administrador VE todos los workflows de la Suite
   (pasos, dónde se opera, dónde se configura) y define el ESCALAMIENTO:
   cuántas horas puede quedarse detenido un ítem antes de re-alarmar.

   Filosofía (paramétrico): la ESTRUCTURA de cada flujo vive en su módulo
   (no se rompe desde acá); lo que se abre a configuración es el escalamiento
   (horas, on/off) y los destinatarios de cada alarma (mantenedor Avisos).

   MOTOR ÚNICO de escalamiento: cada 30 min corre la "query de estancados" de
   cada workflow activo; si hay ítems detenidos más horas que lo configurado,
   dispara el aviso `wf_esc_<codigo>` (campanita con sonido, destinatarios
   configurables en Avisos) y anota ultima_alarma para no repetir hasta que
   pase otro ciclo completo de horas.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const AVISOS = require('../../../../shared/avisos');

/* ── Catálogo: pasos (estructura, informativa) + query de estancados ──────────
   horas = placeholder `?` (una sola vez). Devuelve { n } = ítems estancados. */
const CATALOGO = [
  {
    codigo: 'cartas_revision', func_responsable: 'aprob_revisar', modulo: 'Cartas de Aprobación', nombre: 'Revisión de cartas (pool de analistas)',
    pasos: [
      { label: 'Digitación (Generador)', func: 'aprob_crear' },
      { label: 'Pool de revisión (analistas)', func: 'aprob_revisar' },
      { label: 'Impresión y envío', func: 'aprob_ver' },
      { label: 'Otorgada / Desistida / Vencida', func: 'aprob_vigentes' },
    ],
    operar: '/aprobaciones/', configurar: '/mantenedores/estado-creditos/',
    descripcion: 'Cartas digitadas esperando revisión de un analista de crédito.',
    stuck: "SELECT COUNT(*) n FROM cartas_aprobacion WHERE status='PENDIENTE' AND fecha_creacion < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT('Carta #', id, ' — ', COALESCE(cliente,'s/cliente')) ref, fecha_creacion desde FROM cartas_aprobacion WHERE status='PENDIENTE' AND fecha_creacion < NOW() - INTERVAL ? HOUR ORDER BY fecha_creacion LIMIT 30",
    horas: 4,
  },
  {
    codigo: 'fundantes', func_responsable: 'fundantes_validar', modulo: 'Fundantes', nombre: 'Validación de documentos fundantes',
    pasos: [
      { label: 'Ejecutivo envía docs', func: 'fundantes_seguimiento' },
      { label: 'Validación', func: 'fundantes_validar' },
      { label: 'Rechazado → reenvío', func: 'fundantes_seguimiento' },
      { label: 'Cerrado' },
    ],
    operar: '/fundantes/', configurar: '/mantenedores/tipos-documento/',
    descripcion: 'Operaciones con fundantes ENVIADOS sin validar, o RECHAZADOS sin reenviar.',
    stuck: "SELECT COUNT(*) n FROM fundantes_seg WHERE estado IN ('ENVIADO','RECHAZADO') AND updated_at < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT('OP ', c.num_op, ' (', fs.estado, ')') ref, fs.updated_at desde FROM fundantes_seg fs JOIN creditos c ON c.id=fs.id_credito WHERE fs.estado IN ('ENVIADO','RECHAZADO') AND fs.updated_at < NOW() - INTERVAL ? HOUR ORDER BY fs.updated_at LIMIT 30",
    horas: 24,
  },
  {
    codigo: 'comision_factura', func_responsable: 'postventa_seguimiento', modulo: 'Post Venta', nombre: 'Factura de comisión del dealer',
    pasos: [
      { label: 'Crédito otorgado' },
      { label: 'Cartola enviada', func: 'aprob_cartolas' },
      { label: 'Factura recibida (Seguimiento)', func: 'postventa_seguimiento' },
      { label: 'ODP emitida', func: 'pv_com_orden_emitir' },
      { label: 'Comisión pagada', func: 'pv_com_pagar' },
    ],
    operar: '/postventa/seguimiento/', configurar: '/postventa/mantenedores/',
    descripcion: 'Créditos otorgados cuyo dealer aún no entrega la factura/boleta de comisión.',
    stuck: `SELECT COUNT(*) n FROM postventa_seguimiento s
            WHERE s.fecha_otorgado < NOW() - INTERVAL ? HOUR
              AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='COMISION' AND e.etapa='FACTURA RECIBIDA')
              AND s.fecha_otorgado > NOW() - INTERVAL 90 DAY`,
    det: `SELECT CONCAT('OP ', s.num_op) ref, s.fecha_otorgado desde FROM postventa_seguimiento s
          WHERE s.fecha_otorgado < NOW() - INTERVAL ? HOUR
            AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='COMISION' AND e.etapa='FACTURA RECIBIDA')
            AND s.fecha_otorgado > NOW() - INTERVAL 90 DAY ORDER BY s.fecha_otorgado LIMIT 30`,
    horas: 120,
  },
  {
    codigo: 'comision_odp', func_responsable: 'pv_com_orden_emitir', modulo: 'Post Venta', nombre: 'Emisión ODP de comisión',
    pasos: [
      { label: 'Factura recibida', func: 'postventa_seguimiento' },
      { label: 'ODP emitida', func: 'pv_com_orden_emitir' },
      { label: 'Enviado a pago', func: 'pv_com_seleccionar' },
      { label: 'Comisión pagada', func: 'pv_com_pagar' },
    ],
    operar: '/postventa/orden-pago-comision/', configurar: '/mantenedores/avisos/',
    descripcion: 'Facturas de comisión recibidas sin Orden de Pago emitida.',
    stuck: `SELECT COUNT(*) n FROM postventa_etapas fr
            WHERE fr.track='COMISION' AND fr.etapa='FACTURA RECIBIDA' AND fr.fecha < NOW() - INTERVAL ? HOUR
              AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=fr.id_seguimiento AND e.track='COMISION' AND e.etapa='ORDEN DE PAGO EMITIDA')`,
    det: `SELECT CONCAT('OP ', s.num_op) ref, fr.fecha desde FROM postventa_etapas fr JOIN postventa_seguimiento s ON s.id=fr.id_seguimiento
          WHERE fr.track='COMISION' AND fr.etapa='FACTURA RECIBIDA' AND fr.fecha < NOW() - INTERVAL ? HOUR
            AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=fr.id_seguimiento AND e.track='COMISION' AND e.etapa='ORDEN DE PAGO EMITIDA') ORDER BY fr.fecha LIMIT 30`,
    horas: 48,
  },
  {
    codigo: 'comision_pago', func_responsable: 'pv_com_pagar', modulo: 'Post Venta', nombre: 'Pago de comisión al dealer',
    pasos: [
      { label: 'ODP emitida', func: 'pv_com_orden_emitir' },
      { label: 'Enviado a pago', func: 'pv_com_seleccionar' },
      { label: 'Comisión pagada (asiento automático)', func: 'pv_com_pagar' },
    ],
    operar: '/postventa/comisiones-a-pagar/', configurar: '/mantenedores/avisos/',
    descripcion: 'Órdenes de pago de comisión emitidas que Contabilidad aún no marca pagadas.',
    stuck: `SELECT COUNT(*) n FROM postventa_etapas oe
            WHERE oe.track='COMISION' AND oe.etapa='ORDEN DE PAGO EMITIDA' AND oe.fecha < NOW() - INTERVAL ? HOUR
              AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=oe.id_seguimiento AND e.track='COMISION' AND e.etapa='COMISION PAGADA')`,
    det: `SELECT CONCAT('OP ', s.num_op) ref, oe.fecha desde FROM postventa_etapas oe JOIN postventa_seguimiento s ON s.id=oe.id_seguimiento
          WHERE oe.track='COMISION' AND oe.etapa='ORDEN DE PAGO EMITIDA' AND oe.fecha < NOW() - INTERVAL ? HOUR
            AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=oe.id_seguimiento AND e.track='COMISION' AND e.etapa='COMISION PAGADA') ORDER BY oe.fecha LIMIT 30`,
    horas: 72,
  },
  {
    codigo: 'saldo_odp', func_responsable: 'pv_orden_emitir', modulo: 'Post Venta', nombre: 'Emisión ODP de saldo precio',
    pasos: [
      { label: 'Fundantes recibidos', func: 'postventa_seguimiento' },
      { label: 'Fondos recibidos (cuenta de paso)', func: 'postventa_seguimiento' },
      { label: 'ODP emitida', func: 'pv_orden_emitir' },
      { label: 'Saldo precio pagado', func: 'postventa_saldos_pagar' },
    ],
    operar: '/postventa/orden-pago/', configurar: '/mantenedores/alertas-saldos/',
    descripcion: 'Operaciones con fondos de la financiera recibidos sin Orden de Pago al dealer.',
    stuck: `SELECT COUNT(*) n FROM postventa_etapas fr
            WHERE fr.track='SALDO' AND fr.etapa='FONDOS RECIBIDOS' AND fr.fecha < NOW() - INTERVAL ? HOUR
              AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=fr.id_seguimiento AND e.track='SALDO' AND e.etapa='ORDEN DE PAGO EMITIDA')`,
    det: `SELECT CONCAT('OP ', s.num_op) ref, fr.fecha desde FROM postventa_etapas fr JOIN postventa_seguimiento s ON s.id=fr.id_seguimiento
          WHERE fr.track='SALDO' AND fr.etapa='FONDOS RECIBIDOS' AND fr.fecha < NOW() - INTERVAL ? HOUR
            AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=fr.id_seguimiento AND e.track='SALDO' AND e.etapa='ORDEN DE PAGO EMITIDA') ORDER BY fr.fecha LIMIT 30`,
    horas: 24,
  },
  {
    codigo: 'saldo_pago', func_responsable: 'postventa_saldos_pagar', modulo: 'Post Venta', nombre: 'Pago de saldo precio al dealer',
    pasos: [
      { label: 'ODP emitida', func: 'pv_orden_emitir' },
      { label: 'Enviado a pago', func: 'pv_nomina_generar' },
      { label: 'Saldo precio pagado (asiento automático)', func: 'postventa_saldos_pagar' },
    ],
    operar: '/postventa/saldos-a-pagar/', configurar: '/mantenedores/alertas-saldos/',
    descripcion: 'Órdenes de pago de saldo precio emitidas sin pagar — la plata del dealer está detenida.',
    stuck: `SELECT COUNT(*) n FROM postventa_etapas oe
            WHERE oe.track='SALDO' AND oe.etapa='ORDEN DE PAGO EMITIDA' AND oe.fecha < NOW() - INTERVAL ? HOUR
              AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=oe.id_seguimiento AND e.track='SALDO' AND e.etapa='SALDO PRECIO PAGADO')`,
    det: `SELECT CONCAT('OP ', s.num_op) ref, oe.fecha desde FROM postventa_etapas oe JOIN postventa_seguimiento s ON s.id=oe.id_seguimiento
          WHERE oe.track='SALDO' AND oe.etapa='ORDEN DE PAGO EMITIDA' AND oe.fecha < NOW() - INTERVAL ? HOUR
            AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=oe.id_seguimiento AND e.track='SALDO' AND e.etapa='SALDO PRECIO PAGADO') ORDER BY oe.fecha LIMIT 30`,
    horas: 48,
  },
  {
    codigo: 'odp_proveedores', func_responsable: 'ordenes_pago_historial', modulo: 'Órdenes de Pago', nombre: 'Pago de órdenes a proveedores',
    pasos: [
      { label: 'ODP emitida', func: 'ordenes_pago_emitir' },
      { label: 'Pagada (asiento automático)', func: 'ordenes_pago_historial' },
    ],
    operar: '/ordenes-pago/historial/', configurar: '/ordenes-pago/',
    descripcion: 'Órdenes de pago a proveedores EMITIDAS sin marcar pagadas.',
    // COALESCE: fecha_emision es nullable — sin él, ODP sin fecha jamás contarían como estancadas
    stuck: "SELECT COUNT(*) n FROM ordenes_pago WHERE estado='EMITIDA' AND COALESCE(fecha_emision, created_at) < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT(COALESCE(numero, CONCAT('ODP #', id)), ' — ', COALESCE(proveedor_nombre,'s/proveedor')) ref, COALESCE(fecha_emision, created_at) desde FROM ordenes_pago WHERE estado='EMITIDA' AND COALESCE(fecha_emision, created_at) < NOW() - INTERVAL ? HOUR ORDER BY desde LIMIT 30",
    horas: 120,
  },
  {
    codigo: 'aplicacion_fondos', func_responsable: 'aplic_fondos_aprobar', modulo: 'Tesorería', nombre: 'Aplicación de Fondos (firmas)',
    pasos: [
      { label: 'Hecho (digitación)', func: 'aplic_fondos' },
      { label: 'Revisado', func: 'aplic_fondos_aprobar' },
      { label: 'Aprobado', func: 'aplic_fondos_aprobar' },
      { label: 'Procesado (aplica al crédito)', func: 'aplic_fondos_aprobar' },
    ],
    operar: '/tesoreria/aplicacion-fondos', configurar: '/mantenedores/avisos/',
    descripcion: 'Aplicaciones de fondos con firmas pendientes (HECHO/REVISADO/APROBADO sin procesar).',
    stuck: "SELECT COUNT(*) n FROM aplicaciones_fondos WHERE estado IN ('HECHO','REVISADO','APROBADO') AND updated_at < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT(correlativo, ' — OP ', num_op, ' (', estado, ')') ref, updated_at desde FROM aplicaciones_fondos WHERE estado IN ('HECHO','REVISADO','APROBADO') AND updated_at < NOW() - INTERVAL ? HOUR ORDER BY updated_at LIMIT 30",
    horas: 48,
  },
  {
    codigo: 'castigos', func_responsable: 'castigo_aprobar_finanzas', modulo: 'Tesorería', nombre: 'Castigo de saldo (doble firma)',
    pasos: [
      { label: 'Solicitud de castigo', func: 'castigo_solicitar' },
      { label: 'Firma Finanzas', func: 'castigo_aprobar_finanzas' },
      { label: 'Firma Operaciones', func: 'castigo_aprobar_operaciones' },
      { label: 'Aplicado (asiento automático)' },
    ],
    operar: '/tesoreria/castigos.html', configurar: '/mantenedores/avisos/',
    descripcion: 'Solicitudes de castigo PENDIENTES esperando alguna de las dos firmas gerenciales.',
    stuck: "SELECT COUNT(*) n FROM castigos_contables WHERE estado='PENDIENTE' AND solicitado_at < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT('OP ', num_op, ' — ', motivo) ref, solicitado_at desde FROM castigos_contables WHERE estado='PENDIENTE' AND solicitado_at < NOW() - INTERVAL ? HOUR ORDER BY solicitado_at LIMIT 30",
    horas: 72,
  },
  {
    codigo: 'dealers_incorporacion', func_responsable: 'dealer_ficha_revisar', modulo: 'Dealers', nombre: 'Incorporación de dealers (cadena de aprobación)',
    pasos: [
      { label: 'Ejecutivo crea la ficha', func: 'dealer_ficha_crear' },
      { label: 'Revisión', func: 'dealer_ficha_revisar' },
      { label: 'Niveles de autorización', nota: 'niveles paramétricos en Incorporación → Niveles' },
      { label: 'Aprobada / Rechazada' },
    ],
    operar: '/dealers-incorporacion/', configurar: '/dealers-incorporacion/niveles.html',
    descripcion: 'Fichas de dealer esperando autorización o cierre — el dealer no puede operar hasta aprobarse.',
    // TOMADA = ficha tomada para cierre y no terminada — también puede quedar botada
    stuck: "SELECT COUNT(*) n FROM dealer_fichas WHERE estado IN ('PEND_AUTORIZACION','PEND_CIERRE','TOMADA') AND updated_at < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT(COALESCE(ficha_nombre, CONCAT('Ficha #', id)), ' (', estado, ')') ref, updated_at desde FROM dealer_fichas WHERE estado IN ('PEND_AUTORIZACION','PEND_CIERRE','TOMADA') AND updated_at < NOW() - INTERVAL ? HOUR ORDER BY updated_at LIMIT 30",
    horas: 48,
  },
  {
    codigo: 'tickets_ti', func_responsable: 'ti_atender', modulo: 'Soporte', nombre: 'Atención de tickets TI',
    pasos: [
      { label: 'Usuario reporta', func: 'tickets_ti' },
      { label: 'Atención TI', func: 'ti_atender' },
      { label: 'Cerrado' },
    ],
    operar: '/soporte/tickets-ti/', configurar: '/mantenedores/tickets-ti/',
    descripcion: 'Tiene SLA y escalamiento PROPIOS (mantenedor Tickets TI). Acá solo se monitorea.',
    stuck: "SELECT COUNT(*) n FROM ti_tickets WHERE cerrado_at IS NULL AND estado <> 'CERRADO' AND created_at < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT(COALESCE(codigo, CONCAT('#', id)), ' — ', asunto) ref, created_at desde FROM ti_tickets WHERE cerrado_at IS NULL AND estado <> 'CERRADO' AND created_at < NOW() - INTERVAL ? HOUR ORDER BY created_at LIMIT 30",
    horas: 0,   // nace apagado acá: escala su propio motor (como Compras)
  },
  {
    codigo: 'digitacion_faltantes', modulo: 'Créditos', nombre: 'Digitación de datos faltantes',
    pasos: [
      { label: 'Carga masiva deja campos vacíos' },
      { label: 'Cola de digitación (bloqueo 20 min)', func: 'digitacion_faltantes' },
      { label: 'Crédito completo' },
    ],
    operar: '/carga-masiva/digitacion/', configurar: '/carga-masiva/digitacion/estadisticas.html',
    descripcion: 'Flujo informativo: el conteo de pendientes vive en la propia cola (motor único del WHERE en su módulo) — acá se documenta quiénes digitan.',
    stuck: null,   // el motor de pendientes (WHERE por tipo) vive en digitacion-faltantes; no se duplica (Máxima 1)
    horas: 0,
  },
  {
    codigo: 'compras', func_responsable: 'compras_revision', modulo: 'Compras', nombre: 'Aprobación de órdenes de compra',
    pasos: [
      { label: 'Pedidos', func: 'compras' },
      { label: 'Consolidación', func: 'compras_admin' },
      { label: 'Niveles de firma (1-3)', nota: 'casillas por nivel en mantenedor Compras' },
      { label: 'Aprobada → comprar / Rechazada → vuelve al pool', func: 'compras_revision' },
    ],
    operar: '/soporte/compras-revision/', configurar: '/mantenedores/compras/',
    descripcion: 'Tiene motor de recordatorios PROPIO por nivel (mantenedor Compras → Workflow). Acá solo se monitorea.',
    stuck: "SELECT COUNT(*) n FROM compras_ordenes WHERE estado='EN_APROBACION' AND fecha < NOW() - INTERVAL ? HOUR",
    det: "SELECT CONCAT('OC #', id, ' — nivel ', COALESCE(nivel_actual,'-'), ' ($', FORMAT(total,0), ')') ref, fecha desde FROM compras_ordenes WHERE estado='EN_APROBACION' AND fecha < NOW() - INTERVAL ? HOUR ORDER BY fecha LIMIT 30",
    horas: 0,   // nace apagado acá: escala su propio motor
  },
  {
    codigo: 'cartolas', modulo: 'Post Venta', nombre: 'Emisión y envío de cartolas',
    pasos: [
      { label: 'Carta otorgada', func: 'aprob_vigentes' },
      { label: 'Movimiento en cartola del mes' },
      { label: 'Cartola enviada al dealer', func: 'aprob_cartolas' },
      { label: 'Factura del dealer (cuadre)', func: 'postventa_seguimiento' },
    ],
    operar: '/aprobaciones/', configurar: '/postventa/mantenedores/',
    descripcion: 'Flujo informativo: la cartola es acumulativa por estado y se emite desde Cartas de Aprobación → Cartolas.',
    stuck: null,   // sin métrica de estancamiento (informativo)
    horas: 0,
  },
];

/* ── Migración: registro paramétrico + card + avisos ── */
require('../../../../shared/migrate').enFila('workflows-escalamiento', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS wf_registro (
      codigo VARCHAR(40) PRIMARY KEY,
      recordatorio_horas INT NOT NULL DEFAULT 24,
      activo TINYINT NOT NULL DEFAULT 1,
      ultima_alarma DATETIME NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    // Escalamiento a JEFATURA: tras N ciclos de alarma sin resolverse, sube al jefe
    await pool.query('ALTER TABLE wf_registro ADD COLUMN IF NOT EXISTS ciclos_jefe INT NOT NULL DEFAULT 2').catch(() => {});
    await pool.query('ALTER TABLE wf_registro ADD COLUMN IF NOT EXISTS ciclos_seguidos INT NOT NULL DEFAULT 0').catch(() => {});
    // Historial de alarmas: qué flujo se atasca más y cuánto demora en destrancarse (SLA real)
    await pool.query(`CREATE TABLE IF NOT EXISTS wf_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      codigo VARCHAR(40) NOT NULL,
      tipo VARCHAR(12) NOT NULL DEFAULT 'ALARMA',   -- ALARMA | JEFATURA | RESUELTO
      n INT NOT NULL DEFAULT 0,                     -- ítems detenidos al alarmar
      ciclos INT NOT NULL DEFAULT 0,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_codigo (codigo, fecha))`);
    for (const w of CATALOGO)
      await pool.query('INSERT IGNORE INTO wf_registro (codigo, recordatorio_horas, activo) VALUES (?,?,?)',
        [w.codigo, w.horas, w.horas > 0 ? 1 : 0]);

    // Card en Mantenedores
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      let [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='workflows_mant' LIMIT 1");
      if (!f) {
        const [r] = await pool.query(
          "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Workflows y Escalamiento', 'workflows_mant', '/mantenedores/workflows/', 'bi-diagram-3-fill')",
          [mod.id_modulo]);
        f = { id_funcionalidad: r.insertId };
      }
      await pool.query(`INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT p.id_perfil, ?, 1 FROM perfiles p
                        WHERE (p.nombre = 'Administrador' OR p.nombre LIKE 'Gerente%' OR p.nombre LIKE 'Director%')
                          AND NOT EXISTS (SELECT 1 FROM permisos_perfil pp WHERE pp.id_perfil=p.id_perfil AND pp.id_funcionalidad=?)`,
                       [f.id_funcionalidad, f.id_funcionalidad]);
    }
  } catch (e) { console.error('[workflows migration]', e.message); }
});

// Un aviso por workflow (destinatarios configurables en el mantenedor Avisos)
for (const w of CATALOGO) if (w.stuck) AVISOS.registrarAviso({
  evento: 'wf_esc_' + w.codigo, modulo: 'Workflows',
  nombre: 'Escalamiento: ' + w.nombre,
  descripcion: `Hay ítems detenidos más horas que lo configurado en Workflows y Escalamiento. Flujo: ${w.pasos.map(p => p.label).join(' → ')}.`,
  perfiles: '', incluir_admin: 1, prioridad: 'alta', sonido_tipo: 'dingdong',
});

AVISOS.registrarAviso({
  evento: 'wf_esc_jefatura', modulo: 'Workflows',
  nombre: 'ESCALADO A JEFATURA: workflow sin resolver',
  descripcion: 'Un workflow acumuló varios ciclos de alarma sin resolverse: se avisa al JEFE DIRECTO (usuarios.id_supervisor) de quienes pueden destrancar el paso. Acá se agregan destinatarios extra.',
  perfiles: '', incluir_admin: 1, prioridad: 'alta', sonido_tipo: 'alarma',
});

/* Jefes directos de quienes pueden ejecutar el paso responsable (matriz + id_supervisor) */
async function jefesDe(func) {
  try {
    const responsables = await AVISOS.porFuncionalidad(func);
    if (!responsables.length) return [];
    const [rows] = await pool.query(
      `SELECT DISTINCT s.id_usuario FROM usuarios u
         JOIN usuarios s ON s.id_usuario = u.id_supervisor AND s.estado = 'activo'
        WHERE u.id_usuario IN (?)`, [responsables]);
    return rows.map(r => r.id_usuario);
  } catch (e) { return []; }
}

/* Horario hábil Chile: lun–sáb 08–20 h (sábado es día top de venta).
   Fuera de horario el motor NO alarma (nadie despierta un domingo a las 3 AM);
   las horas siguen corriendo en las queries y la alarma sale al abrir el día. */
function enHorarioHabil() {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour12: false, weekday: 'short', hour: 'numeric' })
      .formatToParts(new Date());
    const dia = p.find(x => x.type === 'weekday').value;
    const hora = Number(p.find(x => x.type === 'hour').value) % 24;
    return dia !== 'Sun' && hora >= 8 && hora < 20;
  } catch (e) { return true; }   // si falla el timezone, mejor alarmar que callar
}

/* ── Motor de escalamiento (cada 30 min) ── */
async function escalar() {
  try {
    if (!enHorarioHabil()) return;
    const [regs] = await pool.query('SELECT * FROM wf_registro');
    for (const r of regs) {
      const w = CATALOGO.find(x => x.codigo === r.codigo);
      if (!w || !w.stuck || !r.activo || !(r.recordatorio_horas > 0)) continue;
      // No repetir la alarma hasta que pase otro ciclo completo de horas
      if (r.ultima_alarma && (Date.now() - new Date(r.ultima_alarma).getTime()) / 36e5 < r.recordatorio_horas) continue;
      const [[{ n }]] = await pool.query(w.stuck, [r.recordatorio_horas]);
      if (!n) {   // se destrancó: el contador de ciclos vuelve a cero
        if (r.ciclos_seguidos) {
          await pool.query('UPDATE wf_registro SET ciclos_seguidos=0 WHERE codigo=?', [r.codigo]);
          await pool.query("INSERT INTO wf_log (codigo, tipo, n, ciclos) VALUES (?,'RESUELTO',0,?)", [r.codigo, r.ciclos_seguidos]).catch(() => {});
        }
        continue;
      }
      const ciclos = (r.ciclos_seguidos || 0) + 1;
      await pool.query('UPDATE wf_registro SET ultima_alarma=NOW(), ciclos_seguidos=? WHERE codigo=?', [ciclos, r.codigo]);
      await pool.query("INSERT INTO wf_log (codigo, tipo, n, ciclos) VALUES (?,'ALARMA',?,?)", [r.codigo, n, ciclos]).catch(() => {});
      await AVISOS.avisar('wf_esc_' + r.codigo, {
        titulo: '⏰ ' + w.nombre + ': ' + n + ' detenida' + (n === 1 ? '' : 's'),
        mensaje: `${n} ítem${n === 1 ? '' : 's'} lleva${n === 1 ? '' : 'n'} más de ${r.recordatorio_horas} h sin avanzar en "${w.nombre}".` + (ciclos > 1 ? ` (${ciclos}° aviso)` : ''),
        href: w.operar,
      }).catch(() => {});
      // ESCALAMIENTO A JEFATURA: tras N ciclos sin resolverse, al jefe directo
      // (usuarios.id_supervisor) de quienes pueden destrancar el paso responsable.
      if (w.func_responsable && r.ciclos_jefe > 0 && ciclos >= r.ciclos_jefe && (ciclos - r.ciclos_jefe) % r.ciclos_jefe === 0) {
        const jefes = await jefesDe(w.func_responsable);
        await pool.query("INSERT INTO wf_log (codigo, tipo, n, ciclos) VALUES (?,'JEFATURA',?,?)", [r.codigo, n, ciclos]).catch(() => {});
        await AVISOS.avisar('wf_esc_jefatura', {
          titulo: '🚨 ESCALADO A JEFATURA — ' + w.nombre,
          mensaje: `"${w.nombre}" acumula ${ciclos} avisos sin resolverse (${n} ítem${n === 1 ? '' : 's'} detenido${n === 1 ? '' : 's'} > ${r.recordatorio_horas} h). Tu equipo es responsable de destrancarlo.`,
          href: w.operar,
        }, { extra: jefes }).catch(() => {});
      }
    }
  } catch (e) { console.error('[workflows escalar]', e.message); }
}
setInterval(escalar, 30 * 60 * 1000);
setTimeout(escalar, 2 * 60 * 1000);

/* ── API del mantenedor ── */
const getAll = async (req, res) => {
  try {
    const [regs] = await pool.query('SELECT * FROM wf_registro');
    // QUIÉNES por paso: la fuente es la MISMA matriz de Perfiles y Permisos
    // (permisos_perfil por funcionalidad) — acá solo se muestra y edita, no se copia.
    const funcs = [...new Set(CATALOGO.flatMap(w => w.pasos.map(p => p.func)).filter(Boolean))];
    const quienesPorFunc = {};
    if (funcs.length) {
      const [qs] = await pool.query(`
        SELECT f.codigo, p.nombre perfil FROM permisos_perfil pp
        JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
        JOIN perfiles p ON p.id_perfil = pp.id_perfil
        WHERE f.codigo IN (?) AND pp.habilitado = 1 ORDER BY p.nombre`, [funcs]);
      qs.forEach(q => (quienesPorFunc[q.codigo] = quienesPorFunc[q.codigo] || []).push(q.perfil));
    }
    const data = [];
    for (const w of CATALOGO) {
      const r = regs.find(x => x.codigo === w.codigo) || { recordatorio_horas: w.horas, activo: w.horas > 0 };
      let estancados = null;
      if (w.stuck && r.recordatorio_horas > 0) {
        try { const [[{ n }]] = await pool.query(w.stuck, [r.recordatorio_horas]); estancados = n; } catch (_) {}
      }
      data.push({
        codigo: w.codigo, modulo: w.modulo, nombre: w.nombre, descripcion: w.descripcion,
        pasos: w.pasos.map(p => ({ ...p, quienes: p.func ? (quienesPorFunc[p.func] || []) : null })),
        operar: w.operar, configurar: w.configurar, medible: !!w.stuck, con_detalle: !!w.det,
        recordatorio_horas: r.recordatorio_horas, activo: !!r.activo,
        ciclos_jefe: r.ciclos_jefe != null ? r.ciclos_jefe : 2, ciclos_seguidos: r.ciclos_seguidos || 0,
        ultima_alarma: r.ultima_alarma || null, estancados,
      });
    }
    res.json({ success: true, data, error: null });
  } catch (e) { console.error('[workflows getAll]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const setUno = async (req, res) => {
  try {
    const w = CATALOGO.find(x => x.codigo === req.params.codigo);
    if (!w) return res.status(404).json({ success: false, data: null, error: 'Workflow desconocido' });
    const horas = Math.max(0, parseInt(req.body.recordatorio_horas, 10) || 0);
    const activo = req.body.activo ? 1 : 0;
    const ciclosJefe = Math.max(0, parseInt(req.body.ciclos_jefe, 10) || 0);
    await pool.query(
      `INSERT INTO wf_registro (codigo, recordatorio_horas, activo, ciclos_jefe) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE recordatorio_horas=VALUES(recordatorio_horas), activo=VALUES(activo), ciclos_jefe=VALUES(ciclos_jefe)`,
      [w.codigo, horas, activo, ciclosJefe]);
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'workflow_escalamiento',
      entidad_id: w.codigo, detalle: `Escalamiento de "${w.nombre}": ${activo ? horas + ' h' + (ciclosJefe ? ', jefatura tras ' + ciclosJefe + ' ciclos' : ', sin jefatura') : 'desactivado'}` });
    res.json({ success: true, data: { codigo: w.codigo, recordatorio_horas: horas, activo: !!activo }, error: null });
  } catch (e) { console.error('[workflows set]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/workflows/:codigo/estancados → los ítems detenidos con su referencia (num_op, correlativo…) */
const estancadosDetalle = async (req, res) => {
  try {
    const w = CATALOGO.find(x => x.codigo === req.params.codigo);
    if (!w || !w.det) return res.status(404).json({ success: false, data: null, error: 'Workflow sin detalle de estancados' });
    const [[reg]] = await pool.query('SELECT recordatorio_horas FROM wf_registro WHERE codigo=?', [w.codigo]);
    const horas = (reg && reg.recordatorio_horas > 0) ? reg.recordatorio_horas : (w.horas || 24);
    const [rows] = await pool.query(w.det, [horas]);
    res.json({ success: true, data: { nombre: w.nombre, horas, operar: w.operar, items: rows }, error: null });
  } catch (e) { console.error('[workflows estancados]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/workflows/:codigo/log → últimas 40 alarmas/resoluciones (historial SLA) */
const logGet = async (req, res) => {
  try {
    const w = CATALOGO.find(x => x.codigo === req.params.codigo);
    if (!w) return res.status(404).json({ success: false, data: null, error: 'Workflow desconocido' });
    const [rows] = await pool.query('SELECT tipo, n, ciclos, fecha FROM wf_log WHERE codigo=? ORDER BY fecha DESC LIMIT 40', [w.codigo]);
    res.json({ success: true, data: { nombre: w.nombre, items: rows }, error: null });
  } catch (e) { console.error('[workflows log]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── QUIÉNES de un paso: leer y editar la matriz real ──
   GET /api/workflows/paso/:func → perfiles (marcados los con permiso) + overrides por persona
   PUT /api/workflows/paso/:func { perfiles:[ids], usuarios_si:[ids], usuarios_no:[ids] }
   Escribe en permisos_perfil / permisos_usuario — la MISMA matriz del módulo Usuarios
   (una sola fuente de datos). El caché de permisos es de 60 s: aplica al minuto. */
const FUNCS_VALIDAS = () => new Set(CATALOGO.flatMap(w => w.pasos.map(p => p.func)).filter(Boolean));

const pasoGet = async (req, res) => {
  try {
    const func = req.params.func;
    if (!FUNCS_VALIDAS().has(func)) return res.status(404).json({ success: false, data: null, error: 'Paso desconocido' });
    const [[f]] = await pool.query('SELECT id_funcionalidad, nombre FROM funcionalidades WHERE codigo=? LIMIT 1', [func]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Funcionalidad no existe' });
    const [perfiles] = await pool.query(`
      SELECT p.id_perfil, p.nombre,
             COALESCE((SELECT pp.habilitado FROM permisos_perfil pp WHERE pp.id_perfil=p.id_perfil AND pp.id_funcionalidad=?), 0) AS habilitado
      FROM perfiles p ORDER BY p.nombre`, [f.id_funcionalidad]);
    const [usuarios] = await pool.query(`
      SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) nombre, pf.nombre perfil,
             (SELECT pu.habilitado FROM permisos_usuario pu WHERE pu.id_usuario=u.id_usuario AND pu.id_funcionalidad=?) AS override
      FROM usuarios u LEFT JOIN perfiles pf ON pf.id_perfil=u.id_perfil
      WHERE u.estado='activo' ORDER BY nombre`, [f.id_funcionalidad]);
    res.json({ success: true, data: { func, nombre: f.nombre, perfiles, usuarios }, error: null });
  } catch (e) { console.error('[workflows pasoGet]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const pasoSet = async (req, res) => {
  try {
    const func = req.params.func;
    if (!FUNCS_VALIDAS().has(func)) return res.status(404).json({ success: false, data: null, error: 'Paso desconocido' });
    const [[f]] = await pool.query('SELECT id_funcionalidad, nombre FROM funcionalidades WHERE codigo=? LIMIT 1', [func]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Funcionalidad no existe' });
    const idf = f.id_funcionalidad;
    const perfiles = (req.body.perfiles || []).map(Number).filter(Boolean);
    // Guardia: no dejar el paso SIN NADIE que pueda ejecutarlo (salvo confirmación explícita)
    const forzados = (req.body.usuarios_si || []).length;
    if (!perfiles.length && !forzados && !req.body.confirmar)
      return res.status(409).json({ success: false, data: { requiere_confirmacion: true },
        error: 'El paso quedaría SIN NADIE que pueda ejecutarlo (0 cargos y 0 personas forzadas). Confirma para guardar igual.' });
    // Perfiles: habilitar los marcados, deshabilitar el resto (misma matriz de Usuarios)
    const [todos] = await pool.query('SELECT id_perfil FROM perfiles');
    for (const { id_perfil } of todos) {
      const on = perfiles.includes(Number(id_perfil)) ? 1 : 0;
      await pool.query(`INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)
                        ON DUPLICATE KEY UPDATE habilitado=VALUES(habilitado)`, [id_perfil, idf, on]);
    }
    // Overrides por persona: si=fuerza acceso, no=fuerza bloqueo, quitar=vuelve al perfil
    const si = (req.body.usuarios_si || []).map(Number).filter(Boolean);
    const no = (req.body.usuarios_no || []).map(Number).filter(Boolean);
    await pool.query('DELETE FROM permisos_usuario WHERE id_funcionalidad=?', [idf]);
    for (const id of si) await pool.query('INSERT INTO permisos_usuario (id_usuario, id_funcionalidad, habilitado) VALUES (?,?,1)', [id, idf]);
    for (const id of no) await pool.query('INSERT INTO permisos_usuario (id_usuario, id_funcionalidad, habilitado) VALUES (?,?,0)', [id, idf]);
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'workflow_paso',
      entidad_id: func, detalle: `Quiénes de "${f.nombre}" (${func}): ${perfiles.length} perfiles, ${si.length} personas forzadas, ${no.length} bloqueadas` });
    res.json({ success: true, data: { func }, error: null });
  } catch (e) { console.error('[workflows pasoSet]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, setUno, pasoGet, pasoSet, estancadosDetalle, logGet };
