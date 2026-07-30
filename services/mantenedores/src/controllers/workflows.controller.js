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
    codigo: 'cartas_revision', modulo: 'Cartas de Aprobación', nombre: 'Revisión de cartas (pool de analistas)',
    pasos: [
      { label: 'Digitación (Generador)', func: 'aprob_crear' },
      { label: 'Pool de revisión (analistas)', func: 'aprob_revisar' },
      { label: 'Impresión y envío', func: 'aprob_ver' },
      { label: 'Otorgada / Desistida / Vencida', func: 'aprob_vigentes' },
    ],
    operar: '/aprobaciones/', configurar: '/mantenedores/estado-creditos/',
    descripcion: 'Cartas digitadas esperando revisión de un analista de crédito.',
    stuck: "SELECT COUNT(*) n FROM cartas_aprobacion WHERE status='PENDIENTE' AND fecha_creacion < NOW() - INTERVAL ? HOUR",
    horas: 4,
  },
  {
    codigo: 'fundantes', modulo: 'Fundantes', nombre: 'Validación de documentos fundantes',
    pasos: [
      { label: 'Ejecutivo envía docs', func: 'fundantes_seguimiento' },
      { label: 'Validación', func: 'fundantes_validar' },
      { label: 'Rechazado → reenvío', func: 'fundantes_seguimiento' },
      { label: 'Cerrado' },
    ],
    operar: '/fundantes/', configurar: '/mantenedores/tipos-documento/',
    descripcion: 'Operaciones con fundantes ENVIADOS sin validar, o RECHAZADOS sin reenviar.',
    stuck: "SELECT COUNT(*) n FROM fundantes_seg WHERE estado IN ('ENVIADO','RECHAZADO') AND updated_at < NOW() - INTERVAL ? HOUR",
    horas: 24,
  },
  {
    codigo: 'comision_factura', modulo: 'Post Venta', nombre: 'Factura de comisión del dealer',
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
    horas: 120,
  },
  {
    codigo: 'comision_odp', modulo: 'Post Venta', nombre: 'Emisión ODP de comisión',
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
    horas: 48,
  },
  {
    codigo: 'comision_pago', modulo: 'Post Venta', nombre: 'Pago de comisión al dealer',
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
    horas: 72,
  },
  {
    codigo: 'saldo_odp', modulo: 'Post Venta', nombre: 'Emisión ODP de saldo precio',
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
    horas: 24,
  },
  {
    codigo: 'saldo_pago', modulo: 'Post Venta', nombre: 'Pago de saldo precio al dealer',
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
    horas: 48,
  },
  {
    codigo: 'odp_proveedores', modulo: 'Órdenes de Pago', nombre: 'Pago de órdenes a proveedores',
    pasos: [
      { label: 'ODP emitida', func: 'ordenes_pago_emitir' },
      { label: 'Pagada (asiento automático)', func: 'ordenes_pago_historial' },
    ],
    operar: '/ordenes-pago/historial/', configurar: '/ordenes-pago/',
    descripcion: 'Órdenes de pago a proveedores EMITIDAS sin marcar pagadas.',
    stuck: "SELECT COUNT(*) n FROM ordenes_pago WHERE estado='EMITIDA' AND fecha_emision < NOW() - INTERVAL ? HOUR",
    horas: 120,
  },
  {
    codigo: 'compras', modulo: 'Compras', nombre: 'Aprobación de órdenes de compra',
    pasos: [
      { label: 'Pedidos', func: 'compras' },
      { label: 'Consolidación', func: 'compras_admin' },
      { label: 'Niveles de firma (1-3)', nota: 'casillas por nivel en mantenedor Compras' },
      { label: 'Aprobada → comprar / Rechazada → vuelve al pool', func: 'compras_revision' },
    ],
    operar: '/soporte/compras-revision/', configurar: '/mantenedores/compras/',
    descripcion: 'Tiene motor de recordatorios PROPIO por nivel (mantenedor Compras → Workflow). Acá solo se monitorea.',
    stuck: "SELECT COUNT(*) n FROM compras_ordenes WHERE estado='EN_APROBACION' AND fecha < NOW() - INTERVAL ? HOUR",
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

/* ── Motor de escalamiento (cada 30 min) ── */
async function escalar() {
  try {
    const [regs] = await pool.query('SELECT * FROM wf_registro');
    for (const r of regs) {
      const w = CATALOGO.find(x => x.codigo === r.codigo);
      if (!w || !w.stuck || !r.activo || !(r.recordatorio_horas > 0)) continue;
      // No repetir la alarma hasta que pase otro ciclo completo de horas
      if (r.ultima_alarma && (Date.now() - new Date(r.ultima_alarma).getTime()) / 36e5 < r.recordatorio_horas) continue;
      const [[{ n }]] = await pool.query(w.stuck, [r.recordatorio_horas]);
      if (!n) continue;
      await pool.query('UPDATE wf_registro SET ultima_alarma=NOW() WHERE codigo=?', [r.codigo]);
      await AVISOS.avisar('wf_esc_' + r.codigo, {
        titulo: '⏰ ' + w.nombre + ': ' + n + ' detenida' + (n === 1 ? '' : 's'),
        mensaje: `${n} ítem${n === 1 ? '' : 's'} lleva${n === 1 ? '' : 'n'} más de ${r.recordatorio_horas} h sin avanzar en "${w.nombre}".`,
        href: w.operar,
      }).catch(() => {});
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
        operar: w.operar, configurar: w.configurar, medible: !!w.stuck,
        recordatorio_horas: r.recordatorio_horas, activo: !!r.activo,
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
    await pool.query(
      `INSERT INTO wf_registro (codigo, recordatorio_horas, activo) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE recordatorio_horas=VALUES(recordatorio_horas), activo=VALUES(activo)`,
      [w.codigo, horas, activo]);
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'workflow_escalamiento',
      entidad_id: w.codigo, detalle: `Escalamiento de "${w.nombre}": ${activo ? horas + ' h' : 'desactivado'}` });
    res.json({ success: true, data: { codigo: w.codigo, recordatorio_horas: horas, activo: !!activo }, error: null });
  } catch (e) { console.error('[workflows set]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
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

module.exports = { getAll, setUno, pasoGet, pasoSet };
