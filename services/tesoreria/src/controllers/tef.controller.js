'use strict';
/* TEF masiva Banco Internacional — endpoints para las tres pantallas de pago.
   El motor (formato, validaciones, cupo, registro) vive en shared/tef-internacional.js. */
const pool = require('../../../../shared/config/database');
const tef = require('../../../../shared/tef-internacional');

const PLATAFORMAS = ['SALDOS', 'COMISIONES', 'PARQUES'];

/* GET /api/tef/cupo → { mes, usados, gratis, restantes, por_plataforma } */
async function cupo(req, res) {
  try { res.json({ success: true, data: await tef.cupoMes(), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
}

/* Comisiones de parques: la página manda { parque, odp_numero }; los datos bancarios salen de la
   ficha del parque (parques_ficha, fuente única) y el monto de la ODP emitida. */
async function filasParques(items) {
  const out = [];
  for (const it of items) {
    const [[p]] = await pool.query(
      `SELECT p.nombre, f.rut, f.razon_social, f.banco, f.cuenta_tipo, f.num_cuenta, f.rut_cuenta, f.nombre_cuenta, f.correo_confirmacion
         FROM parques_comisiones p LEFT JOIN parques_ficha f ON f.id_parque = p.id WHERE p.nombre = ? LIMIT 1`, [it.parque]);
    const [[odp]] = await pool.query('SELECT monto FROM op_correlativos WHERE numero = ? AND anulada = 0 LIMIT 1', [it.odp_numero || '']);
    out.push({ ref: it.parque, rut: p?.rut_cuenta || p?.rut, nombre: p?.razon_social || p?.nombre_cuenta || it.parque, banco: p?.banco,
      tipo_cuenta: p?.cuenta_tipo, num_cuenta: p?.num_cuenta, correo: p?.correo_confirmacion, monto: odp?.monto || 0,
      motivo: `Pago com parque ${it.odp_numero || ''}` });   // cabe en los 30 del banco
  }
  return out;
}

/* POST /api/tef/internacional { plataforma, filas:[...] } → archivo xlsx en base64 + resumen */
async function generar(req, res) {
  try {
    const plataforma = String(req.body?.plataforma || '').toUpperCase();
    if (!PLATAFORMAS.includes(plataforma)) return res.status(400).json({ success: false, data: null, error: 'Plataforma inválida' });
    let filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    if (!filas.length) return res.status(400).json({ success: false, data: null, error: 'No hay pagos para incluir' });
    if (plataforma === 'PARQUES') filas = await filasParques(filas);
    /* Segregación de funciones ANTES de generar el archivo (Pato, 14-09-2026): generar el TEF
       registra el pago, así que quien mandó a pago las operaciones no puede generarlo. El 14-09
       JM mandó a pago 7 saldos y generó el TEF: el archivo salió pero el pago se rechazó y las
       operaciones quedaron "enviadas" sin asiento. Mismo motor que «Confirmar pago». */
    if (plataforma === 'SALDOS' || plataforma === 'COMISIONES') {
      const pv = require('../../../postventa/src/controllers/postventa.controller');
      const ids = filas.map(f => Number(f.id)).filter(Boolean);
      if (ids.length) {
        const choque = await pv.opsMandadasAPagoPor(ids, pv.loginDe(req.usuario), plataforma === 'SALDOS' ? 'SALDO' : 'COMISION');
        if (choque.length)
          return res.status(403).json({ success: false, data: null,
            error: `No se puede generar el TEF: tú mandaste a pago ${choque.length === 1 ? 'la operación' : 'las operaciones'} ${choque.join(', ')} y el archivo registra el pago. Debe generarlo otra persona (segregación de funciones).` });
      }
    }
    const r = await tef.construirTEF({ plataforma, filas, usuario: req.usuario });
    res.json({ success: true, data: { archivo_base64: r.buffer.toString('base64'), nombre_archivo: r.nombre_archivo, cargos: r.cargos,
      monto_total: r.monto_total, excluidas: r.excluidas, divididas: r.divididas, cupo: r.cupo }, error: null });
  } catch (e) {
    console.error('[tef generar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
}

module.exports = { cupo, generar };
