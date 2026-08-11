'use strict';
/* ════════════════════════════════════════════════════════════════════════
   DIFERENCIAS ENTRE LA CARGA Y NUESTROS DATOS
   La carga masiva NO pisa los montos de una operación que ya existe: acá se
   digitaron y revisaron. Pero callar la diferencia deja el error pegado para
   siempre (op 6251839: precio, pie, saldo y pagaré malos desde el alta, y
   veinte cargas después seguían igual).
   Por eso cada discrepancia queda en `carga_diferencias` y una persona decide:
   dejar el nuestro, tomar el del archivo, o escribir un tercer valor (el del
   pagaré, que es el documento que manda). El crédito solo cambia cuando
   alguien elige — la carga nunca decide sola.
   ════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { isMesCerrado } = require('../../../../shared/utils/mes-cerrado');

const ETIQUETAS = {
  valor_vehiculo:   'Precio del vehículo',
  pie:              'Pie',
  saldo_precio:     'Saldo precio',
  monto_financiado: 'Monto del pagaré',
};
const COLS_OK = new Set(Object.keys(ETIQUETAS));

const errSrv = (res, e, ctx) => {
  console.error(`[carga-diferencias ${ctx}]`, e.message);
  res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
};

/* ── GET /conteo → para el badge de la card ── */
exports.conteo = async (_req, res) => {
  try {
    const [[r]] = await pool.query(
      "SELECT COUNT(DISTINCT id_credito) ops, COUNT(*) campos FROM carga_diferencias WHERE estado='PENDIENTE'");
    res.json({ success: true, data: { operaciones: Number(r.ops), campos: Number(r.campos) }, error: null });
  } catch (e) { errSrv(res, e, 'conteo'); }
};

/* ── GET /lista → una fila por operación con sus campos en conflicto ── */
exports.lista = async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT d.id, d.id_credito, d.campo, d.valor_sistema, d.valor_archivo, d.origen, d.created_at,
             c.num_op, c.id_financiera, c.financiera, c.ejecutivo, c.automotora,
             DATE_FORMAT(c.mes,'%Y-%m') AS mes, c.plazo, c.tascli_real, c.cuota,
             COALESCE(cl.nombre_completo,'') AS cliente
        FROM carga_diferencias d
        JOIN creditos c ON c.id = d.id_credito
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE d.estado='PENDIENTE'
       ORDER BY c.mes DESC, c.num_op, d.campo`);
    const ops = new Map();
    for (const r of rows) {
      if (!ops.has(r.id_credito)) ops.set(r.id_credito, {
        id_credito: r.id_credito, num_op: r.num_op, id_financiera: r.id_financiera,
        financiera: r.financiera, mes: r.mes, ejecutivo: r.ejecutivo, automotora: r.automotora,
        cliente: r.cliente, plazo: r.plazo, tasa: r.tascli_real, cuota: r.cuota,
        origen: r.origen, detectado: r.created_at, campos: [],
      });
      ops.get(r.id_credito).campos.push({
        id: r.id, campo: r.campo, etiqueta: ETIQUETAS[r.campo] || r.campo,
        valor_sistema: r.valor_sistema, valor_archivo: r.valor_archivo,
      });
    }
    res.json({ success: true, data: [...ops.values()], error: null });
  } catch (e) { errSrv(res, e, 'lista'); }
};

/* ── POST /resolver  { decisiones: [{ id, eleccion, valor }] } ──
   eleccion: SISTEMA (deja lo nuestro) · ARCHIVO (toma el de la carga) · MANUAL (valor escrito).
   SISTEMA no escribe nada en el crédito: solo cierra el caso. */
exports.resolver = async (req, res) => {
  try {
    const decisiones = Array.isArray(req.body?.decisiones) ? req.body.decisiones : [];
    if (!decisiones.length) return res.status(400).json({ success: false, data: null, error: 'Sin decisiones' });
    const usuario = [req.usuario?.nombre, req.usuario?.apellido].filter(Boolean).join(' ') || 'Sistema';
    let aplicados = 0, cerrados = 0;

    for (const d of decisiones) {
      const [[dif]] = await pool.query("SELECT * FROM carga_diferencias WHERE id=? AND estado='PENDIENTE'", [d.id]);
      if (!dif || !COLS_OK.has(dif.campo)) continue;

      const [[cr]] = await pool.query('SELECT id, num_op, DATE_FORMAT(mes,\'%Y-%m\') mes FROM creditos WHERE id=?', [dif.id_credito]);
      if (!cr) continue;
      // Un mes cerrado ya está liquidado: la diferencia se informa, no se aplica.
      if (await isMesCerrado(cr.mes))
        return res.status(400).json({ success: false, data: null, error: `La operación ${cr.num_op} está en un mes CERRADO (${cr.mes})` });

      let valor = null, eleccion = String(d.eleccion || '').toUpperCase();
      if (eleccion === 'ARCHIVO') valor = Number(dif.valor_archivo);
      else if (eleccion === 'MANUAL') valor = Math.round(Number(String(d.valor ?? '').replace(/[^\d]/g, '')));
      else eleccion = 'SISTEMA';
      if (eleccion !== 'SISTEMA' && !(Number.isFinite(valor) && valor > 0))
        return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${ETIQUETAS[dif.campo]}` });

      if (eleccion !== 'SISTEMA') {
        await pool.query(`UPDATE creditos SET ${dif.campo} = ?, updated_at = NOW() WHERE id = ?`, [valor, dif.id_credito]);
        aplicados++;
        auditar({ req, accion: 'EDITAR', modulo: 'carga-masiva', entidad: 'credito', entidad_id: dif.id_credito,
          detalle: `Diferencia con la carga resuelta en OP ${cr.num_op}: ${ETIQUETAS[dif.campo]} ${dif.valor_sistema} → ${valor} (${eleccion === 'ARCHIVO' ? 'valor del archivo' : 'valor digitado'})` });
      } else cerrados++;

      await pool.query(
        `UPDATE carga_diferencias SET estado='RESUELTA', eleccion=?, valor_elegido=?, resuelto_por=?, resuelto_at=NOW() WHERE id=?`,
        [eleccion, eleccion === 'SISTEMA' ? dif.valor_sistema : String(valor), usuario, dif.id]);
    }

    // La cuota depende de monto+tasa+plazo: si cambió el monto, se recalcula con
    // el motor único (nunca se deja una cuota que no cuadre con su crédito).
    const ids = [...new Set(decisiones.map(x => x.id_credito).filter(Boolean))];
    for (const idc of ids) {
      try {
        const [[c]] = await pool.query('SELECT monto_financiado, tascli_real, plazo FROM creditos WHERE id=?', [idc]);
        if (c && Number(c.monto_financiado) > 0 && Number(c.tascli_real) > 0 && Number(c.plazo) > 0) {
          const core = require('../../../../api-gateway/public/js/rentabilidad-core');
          const cu = Math.round(core.cuotaFrancesa(Number(c.monto_financiado), Number(c.tascli_real) / 100, Number(c.plazo)));
          if (cu > 0) await pool.query('UPDATE creditos SET cuota=? WHERE id=?', [cu, idc]);
        }
      } catch (_) {}
    }

    res.json({ success: true, data: { aplicados, cerrados }, error: null });
  } catch (e) { errSrv(res, e, 'resolver'); }
};

/* ── GET /historial → las ya resueltas (auditoría, solo lectura) ── */
exports.historial = async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT d.id, d.num_op, d.id_financiera, d.campo, d.valor_sistema, d.valor_archivo,
             d.valor_elegido, d.eleccion, d.resuelto_por, d.resuelto_at, d.origen
        FROM carga_diferencias d WHERE d.estado='RESUELTA'
       ORDER BY d.resuelto_at DESC LIMIT 300`);
    res.json({ success: true, data: rows.map(r => ({ ...r, etiqueta: ETIQUETAS[r.campo] || r.campo })), error: null });
  } catch (e) { errSrv(res, e, 'historial'); }
};
