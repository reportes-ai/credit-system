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

/* Qué campos existen y cómo se llaman: catálogo ÚNICO en shared/campos-carga-dif.js,
   el mismo que usa la carga para detectarlas. Antes la lista estaba acá y también
   allá, así que un campo agregado en un lado aparecía sin nombre en el otro. */
const { POR_COL, normFecha } = require('../../../../shared/campos-carga-dif');
const ETIQUETAS = Object.fromEntries(Object.entries(POR_COL).map(([k, v]) => [k, v.etiqueta]));
const COLS_OK = new Set(Object.keys(POR_COL));

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
        // tipo y grupo viajan a la pantalla: sin ellos un dealer o una fecha se
        // mostrarían como "$NaN" (la vista formateaba todo como peso).
        tipo: POR_COL[r.campo]?.tipo || 'peso', grupo: POR_COL[r.campo]?.grupo || 'Montos',
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
    const omitidosCerrado = [];   // operaciones de meses cerrados: se informan, no se tocan

    for (const d of decisiones) {
      const [[dif]] = await pool.query("SELECT * FROM carga_diferencias WHERE id=? AND estado='PENDIENTE'", [d.id]);
      if (!dif || !COLS_OK.has(dif.campo)) continue;

      const [[cr]] = await pool.query('SELECT id, num_op, DATE_FORMAT(mes,\'%Y-%m\') mes FROM creditos WHERE id=?', [dif.id_credito]);
      if (!cr) continue;
      /* Un mes cerrado ya está liquidado: la diferencia se informa, no se aplica.
         Se SALTA esa decisión y se sigue con las demás. Antes cortaba el lote
         entero con un 400; desde que las diferencias se resuelven en masa al
         terminar la carga, una sola operación de un mes cerrado habría dejado
         sin aplicar las otras doscientas. */
      if (await isMesCerrado(cr.mes)) { omitidosCerrado.push(`${cr.num_op} (${cr.mes})`); continue; }

      /* El valor se valida SEGÚN EL TIPO del campo: desde que el contraste dejó
         de ser solo de montos, exigir un número > 0 habría rechazado un dealer
         o una marca — y peor, un `Number('MITSUBISHI')` es NaN, así que la
         elección se caía sin decir por qué. */
      const tipo = POR_COL[dif.campo]?.tipo || 'peso';
      let valor = null, eleccion = String(d.eleccion || '').toUpperCase();
      const crudo = eleccion === 'ARCHIVO' ? dif.valor_archivo : String(d.valor ?? '');
      if (eleccion === 'ARCHIVO' || eleccion === 'MANUAL') {
        if (tipo === 'peso')       valor = Math.round(Number(String(crudo).replace(/[^\d-]/g, '')));
        else if (tipo === 'fecha') valor = normFecha(crudo) || null;
        else                       valor = String(crudo).trim() || null;
      } else eleccion = 'SISTEMA';

      if (eleccion !== 'SISTEMA') {
        const valido = tipo === 'peso'  ? (Number.isFinite(valor) && valor > 0)
                     : tipo === 'fecha' ? /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''))
                     : !!valor;
        if (!valido)
          return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${ETIQUETAS[dif.campo]}` });
      }

      if (eleccion !== 'SISTEMA') {
        await pool.query(`UPDATE creditos SET ${dif.campo} = ?, updated_at = NOW() WHERE id = ?`, [valor, dif.id_credito]);
        aplicados++;
        auditar({ req, accion: 'EDITAR', modulo: 'carga-masiva', entidad: 'credito', entidad_id: dif.id_credito,
          detalle: `Diferencia con la carga resuelta en OP ${cr.num_op}: ${ETIQUETAS[dif.campo]} ${dif.valor_sistema} → ${valor} (${eleccion === 'ARCHIVO' ? 'valor del archivo' : 'valor digitado'})` });
      } else cerrados++;

      /* Un campo puede volver a diferir en una carga posterior, pero la llave única
         uk_dif (id_credito, campo, estado) solo admite UNA fila RESUELTA por campo:
         sin este DELETE el UPDATE chocaba con la resolución vieja y el lote entero
         moría en 500 a mitad de camino (op 26080622, 25-08-2026). Queda la última
         resolución; el historial completo vive en audit_log (auditar de arriba). */
      await pool.query(
        "DELETE FROM carga_diferencias WHERE id_credito=? AND campo=? AND estado='RESUELTA' AND id<>?",
        [dif.id_credito, dif.campo, dif.id]);
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

    res.json({ success: true, data: { aplicados, cerrados, omitidos_mes_cerrado: omitidosCerrado }, error: null });
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
    res.json({ success: true, data: rows.map(r => ({
      ...r, etiqueta: ETIQUETAS[r.campo] || r.campo, tipo: POR_COL[r.campo]?.tipo || 'peso',
    })), error: null });
  } catch (e) { errSrv(res, e, 'historial'); }
};
