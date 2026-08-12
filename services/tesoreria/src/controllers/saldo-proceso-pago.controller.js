'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SALDO PRECIO EN PROCESO DE PAGO — la planilla de Tesorería, reconstruida
   desde el sistema

   Para qué: Tesorería llevaba este control en un Excel a mano ("SALDOS
   PRECIOS.xlsx", 2.500+ filas): por cada operación otorgada, cuándo llegaron
   los fundantes, cuándo vence el pago del saldo precio al dealer según su SLA,
   si ya se cargó al banco y cuándo se pagó. Esta card lo reconstruye EN VIVO
   desde el seguimiento de Post Venta — misma información, cero digitación — y
   lo exporta en el formato que la otra aplicación espera.

   De dónde sale cada dato (una sola fuente, Máxima 2):
     · Operación, dealer, ejecutivo, financiera, saldo → `postventa_seguimiento`.
     · Las FECHAS del proceso → `postventa_etapas` track SALDO (la etapa más
       avanzada define el estado; se usan NUESTROS nombres de etapa, no los de
       la planilla: su "CARGADO" es nuestro ENVIADO A PAGO, su "CARGAR" es
       nuestra ORDEN DE PAGO EMITIDA).
     · MONTO A PAGAR → la ODP de saldo (`postventa_ordenes` → `op_correlativos`),
       que incluye los gastos (la planilla pagaba saldo + gastos: por eso sus
       montos eran $45.380 sobre el saldo puro). Si aún no hay ODP se muestra
       el saldo precio del crédito, marcado como preliminar.
     · TIPO (PARQUE/CALLE) → `creditos.parque` ≠ 'NO APLICA'.
     · CLASIFICACIÓN (SOCIO/PARTNER/SUPERPARTNER) → `dealers.categoria_asignada`.

   SLA de pago (paramétrico en `postventa_config`, claves sla_saldo_*_horas):
   el saldo se paga en 24/48/72 horas HÁBILES desde la recepción de fundantes
   según la clasificación del dealer — SUPERPARTNER 24, PARTNER 48, SOCIO 72
   (default si no hay clasificación). Recepción PM cuenta desde el día hábil
   siguiente. Es la regla de la planilla ("FECHA VENCIMIENTO A 24-48 0 72
   HORAS"), ahora calculada y no digitada.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
// Motor único de etapa: una operación ANULADA o DESISTIDA no se paga, aunque
// su seguimiento de Post Venta haya quedado a medio camino.
const { ETAPA_SQL } = require('../../../../shared/etapa-credito');
// Motor único de los fijos AutoFin (Limitación al dominio + Transferencia/inscripción):
// el MISMO que usa la Orden de Pago de saldo. Solo AUTOFIN los suma; viven en el
// mantenedor Parámetros de Crédito (autofin_limitacion / autofin_inscripcion).
const { getFijosAutoFin, esAutoFin } = require('../../../postventa/src/controllers/postventa.controller');

/* Card en la landing de Tesorería + permiso (anti-hardcode) */
require('../../../../shared/migrate').enFila('saldo-proceso-pago', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      const f = { codigo: 'teso_saldo_proceso', nombre: 'Saldo Precio en Proceso de Pago',
                  href: '/tesoreria/saldo-proceso-pago', icono: 'bi-hourglass-split' };
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
        idF = r.insertId;
      }
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    }
    // SLA paramétrico (horas hábiles por clasificación del dealer)
    for (const [k, v] of [['sla_saldo_superpartner_horas', '24'], ['sla_saldo_partner_horas', '48'], ['sla_saldo_socio_horas', '72']])
      await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?)', [k, v]).catch(() => {});
    console.log('[saldo-proceso-pago] módulo listo');
  } catch (e) { console.error('[saldo-proceso-pago migration]', e.message); }
});

/* Orden del flujo SALDO: la etapa más avanzada alcanzada define el estado. */
const FLUJO = ['FUNDANTES PENDIENTES', 'FUNDANTES RECIBIDOS', 'FUNDANTES ENVIADOS',
               'LIBERADO A PAGO', 'FONDOS RECIBIDOS', 'ORDEN DE PAGO EMITIDA',
               'ENVIADO A PAGO', 'SALDO PRECIO PAGADO'];

async function slaHoras() {
  const out = { SUPERPARTNER: 24, PARTNER: 48, SOCIO: 72 };
  try {
    const [rows] = await pool.query("SELECT clave, valor FROM postventa_config WHERE clave LIKE 'sla_saldo_%_horas'");
    for (const r of rows) {
      const m = /sla_saldo_(\w+)_horas/.exec(r.clave);
      const n = parseInt(r.valor, 10);
      if (m && Number.isFinite(n) && n > 0) out[m[1].toUpperCase()] = n;
    }
  } catch (_) {}
  return out;
}

/* Suma N días HÁBILES (lun-vie) a una fecha. La planilla no considera feriados
   y acá tampoco: mismo criterio para que cuadre contra lo histórico. */
function sumarHabiles(fecha, dias) {
  const d = new Date(fecha);
  let n = 0;
  while (n < dias) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return d;
}
const ymd = d => d ? new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }) : null;

/* GET /api/saldo-proceso-pago?estado=&q=&desde=&hasta=&todo=1
   Sin `todo`, muestra solo las que NO están pagadas (el "en proceso" del nombre). */
exports.listar = async (req, res) => {
  try {
    const q     = String(req.query.q || '').trim();
    const estado= String(req.query.estado || '').trim().toUpperCase();
    const todo  = req.query.todo === '1';
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : null;

    const [segs] = await pool.query(`
      SELECT s.id, s.num_op, s.nombre_dealer, s.ejecutivo, s.financiera,
             s.saldo_precio,
             COALESCE(s.fecha_otorgado, c.fecha_otorgado) AS fecha_otorgado,
             /* RUT: el del seguimiento y, si quedó vacío, el del crédito o la ficha */
             COALESCE(NULLIF(s.rut_dealer,''), NULLIF(c.rut_dealer,''), di.rut) AS rut_dealer,
             c.parque, c.id_financiera,
             /* Clasificación: ficha por id_dealer primero, por RUT de respaldo; asignada y si no, propuesta */
             COALESCE(NULLIF(di.categoria_asignada,''), NULLIF(d.categoria_asignada,''),
                      NULLIF(di.categoria_propuesta,''), NULLIF(d.categoria_propuesta,'')) AS categoria_asignada,
             ${ETAPA_SQL('c')} AS etapa_credito,
             oc.numero AS odp_numero, oc.monto AS odp_monto, oc.pagada AS odp_pagada
        FROM postventa_seguimiento s
        LEFT JOIN creditos c  ON c.id = s.id_credito
        LEFT JOIN dealers  di ON di.id_dealer = c.id_dealer
        LEFT JOIN dealers  d  ON d.rut = COALESCE(NULLIF(s.rut_dealer,''), c.rut_dealer)
        LEFT JOIN postventa_ordenes po ON po.id_seguimiento = s.id
        LEFT JOIN op_correlativos  oc ON oc.origen='SALDO' AND oc.origen_id = po.id AND oc.anulada=0
       ORDER BY s.id DESC LIMIT 20000`);

    // Todas las etapas SALDO en UNA query, pivoteadas en código.
    const ids = segs.map(s => s.id);
    const etapasDe = new Map();
    for (let i = 0; i < ids.length; i += 1000) {
      const [es] = await pool.query(
        "SELECT id_seguimiento, etapa, fecha FROM postventa_etapas WHERE track='SALDO' AND id_seguimiento IN (?)",
        [ids.slice(i, i + 1000)]);
      es.forEach(e => {
        const m = etapasDe.get(e.id_seguimiento) || {};
        // Si una etapa se repitió (devoluciones), manda la más reciente.
        if (!m[e.etapa] || new Date(e.fecha) > new Date(m[e.etapa])) m[e.etapa] = e.fecha;
        etapasDe.set(e.id_seguimiento, m);
      });
    }

    const sla = await slaHoras();
    const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    const diasEntre = (a, b) => Math.round((new Date(ymd(b)) - new Date(ymd(a))) / 86400000);

    /* Operaciones muertas fuera: a una anulada/desistida no se le paga saldo.
       (La 88558 y la 88027, anuladas hoy, seguían apareciendo "en proceso".) */
    const vivas = segs.filter(s => !['ANULADO', 'DESISTIDO', 'RECHAZADO', 'NO OTORGADO']
      .includes(String(s.etapa_credito || '').toUpperCase()));

    const fijos = await getFijosAutoFin();   // Limitación + Transferencia (solo AUTOFIN)
    let data = vivas.map(s => {
      const et = etapasDe.get(s.id) || {};
      let estadoActual = 'SIN ETAPAS';
      for (let i = FLUJO.length - 1; i >= 0; i--) if (et[FLUJO[i]]) { estadoActual = FLUJO[i]; break; }

      const recep = et['FUNDANTES RECIBIDOS'] || null;
      const ampm  = recep ? (new Date(recep).getHours() < 13 ? 'AM' : 'PM') : null;
      const clasif = String(s.categoria_asignada || 'SOCIO').toUpperCase();
      const horas  = sla[clasif] || sla.SOCIO || 72;
      // PM cuenta desde el día hábil siguiente (regla de la planilla)
      const venc = recep ? ymd(sumarHabiles(ampm === 'PM' ? sumarHabiles(recep, 1) : recep, Math.ceil(horas / 24))) : null;

      const pagado = et['SALDO PRECIO PAGADO'] || null;
      const dRec = recep ? new Date(recep) : null;
      return {
        num_op: s.num_op,
        id_financiera: s.id_financiera || null,
        f_otorgado: ymd(s.fecha_otorgado),
        dealer: s.nombre_dealer, rut_dealer: s.rut_dealer,
        ejecutivo: s.ejecutivo, financiera: s.financiera,
        hora_recepcion: dRec ? String(dRec.getHours()).padStart(2, '0') + ':' + String(dRec.getMinutes()).padStart(2, '0') : null,
        tipo_dealer: (s.parque && s.parque !== 'NO APLICA') ? 'PARQUE' : 'CALLE',
        clasificacion: s.categoria_asignada || null,
        /* Desglose del pago: saldo precio + fijos AutoFin (Limitación y Transferencia,
           mismo motor que la ODP; $0 fuera de AUTOFIN). El TOTAL es la ODP cuando
           existe (monto congelado al emitir) y la suma calculada si aún no hay. */
        monto: Number(s.saldo_precio || 0),
        limitacion: esAutoFin(s.financiera) ? (fijos.autofin_limitacion || 0) : 0,
        transferencia: esAutoFin(s.financiera) ? (fijos.autofin_inscripcion || 0) : 0,
        monto_total: s.odp_monto != null ? Number(s.odp_monto)
          : Number(s.saldo_precio || 0)
            + (esAutoFin(s.financiera) ? (fijos.autofin_limitacion || 0) + (fijos.autofin_inscripcion || 0) : 0),
        monto_preliminar: s.odp_monto == null,             // sin ODP aún: total calculado, no congelado
        odp: s.odp_numero || null,
        estado: estadoActual,
        pagado: !!pagado,
        f_recepcion: ymd(recep), ampm,
        f_venc_sla: venc, sla_horas: recep ? horas : null,
        f_fund_enviados: ymd(et['FUNDANTES ENVIADOS']),
        f_liberado: ymd(et['LIBERADO A PAGO']),
        f_odp: ymd(et['ORDEN DE PAGO EMITIDA']),
        f_banco: ymd(et['ENVIADO A PAGO']),
        f_pagado: ymd(pagado),
        dias_pend_fundantes: (recep && !et['FUNDANTES ENVIADOS']) ? diasEntre(recep, hoy) : null,
        dias_para_pago: (venc && !pagado) ? diasEntre(hoy, venc) : null,   // negativo = atrasado
      };
    });

    if (!todo)   data = data.filter(r => !r.pagado);
    if (estado)  data = data.filter(r => r.estado === estado);
    if (desde)   data = data.filter(r => r.f_recepcion && r.f_recepcion >= desde);
    if (hasta)   data = data.filter(r => r.f_recepcion && r.f_recepcion <= hasta);
    if (q) {
      const t = q.toUpperCase();
      data = data.filter(r => [r.num_op, r.id_financiera, r.dealer, r.rut_dealer, r.ejecutivo, r.financiera, r.odp, r.estado]
        .some(v => String(v == null ? '' : v).toUpperCase().includes(t)));
    }

    const resumen = {
      n: data.length,
      monto: data.reduce((a, r) => a + (r.monto_total || 0), 0),   // el chip Total = lo que realmente se paga
      atrasados: data.filter(r => r.dias_para_pago != null && r.dias_para_pago < 0).length,
      por_estado: {},
    };
    data.forEach(r => { resumen.por_estado[r.estado] = (resumen.por_estado[r.estado] || 0) + 1; });

    res.json({ success: true, data, resumen, flujo: FLUJO, error: null });
  } catch (e) {
    console.error('[saldo-proceso-pago]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
