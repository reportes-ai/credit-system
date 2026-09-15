'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DESCUENTOS DE COMISIÓN POR OPERACIÓN — ingreso MANUAL por N° de operación
   (Pato, 15-09-2026). Complementa al motor automático de la cláusula novena
   (descuentosDelMes en comisiones.controller) cuando ese switch está apagado o
   cuando Operaciones necesita registrar el hecho a mano.

     · ANULACIÓN: se descuenta el 100% (dcto_pct_anul) de lo que se le pagó al
       ejecutivo por esa operación. Glosa: "Descuento por anulación de OP12345".
     · PREPAGO: se ingresa el N° de cuotas pagadas. Hasta dcto_cuotas_t1 (3)
       cuotas → dcto_pct_t1 (100%); hasta dcto_cuotas_t2 (6) → dcto_pct_t2 (50%);
       más cuotas → no corresponde descuento. Glosa: "Descuento por prepago de
       OP12345, 3 cuotas pagadas".

   "Lo que se le pagó por esa operación" sale de UN solo lugar, en cascada:
     1. la FOTO FIRME de la aprobación del mes en que se comisionó
        (comisiones_aprobaciones.foto_json._creditos[num_op]) × semana corrida
     2. si no hay foto (mes anterior a la foto o no aprobado): el motor único con
        las variables y el factor de ajuste de ese mes (misma fórmula que la
        reversa automática).

   El descuento se imputa al mes de Revisión que se está mirando, entra en
   calcularMes como una línea más de `descuentos` (misma forma que las
   automáticas) y por lo tanto baja el monto que va a la Nómina y a
   Remuneraciones. Un ejecutivo con la comisión APROBADA (foto firme) no admite
   descuentos nuevos: hay que Rechazar, ingresar y volver a Aprobar.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { esPlazoMenor } = require('../../../../shared/comision-ejecutivo');

require('../../../../shared/migrate').enFila('comisiones-descuentos', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comisiones_descuentos_op (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        mes              CHAR(7)       NOT NULL,            /* mes de Revisión al que se imputa */
        num_op           BIGINT        NOT NULL,
        ejecutivo        VARCHAR(150)  NOT NULL,
        tipo             VARCHAR(12)   NOT NULL,            /* ANULACION | PREPAGO */
        cuotas_pagadas   INT           NULL,
        mes_origen       CHAR(7)       NULL,                /* mes en que se comisionó la op */
        comision_pagada  DECIMAL(15,2) NOT NULL DEFAULT 0,
        fuente           VARCHAR(20)   NULL,                /* APROBADA (foto firme) | CALCULADA */
        pct              DECIMAL(6,4)  NOT NULL DEFAULT 0,
        descuento        DECIMAL(15,2) NOT NULL DEFAULT 0,
        glosa            VARCHAR(200)  NOT NULL,
        comentario       VARCHAR(400)  NULL,
        estado           VARCHAR(10)   NOT NULL DEFAULT 'ACTIVO',   /* ACTIVO | ANULADO */
        creado_por_id    INT NULL, creado_por VARCHAR(150) NULL, creado_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        anulado_por_id   INT NULL, anulado_por VARCHAR(150) NULL, anulado_at DATETIME NULL, anulado_motivo VARCHAR(300) NULL,
        INDEX idx_cdo_mes (mes, estado),
        INDEX idx_cdo_op (num_op, estado)
      )`);
    // Tramos por CUOTAS PAGADAS (el ingreso manual se mide en cuotas, no en meses)
    for (const [clave, valor, etiqueta, descripcion, tipo] of [
      ['dcto_cuotas_t1', 3, 'Prepago manual — cuotas tramo 1', 'Prepago ingresado a mano con hasta este N° de cuotas pagadas descuenta el % del tramo 1', 'factor'],
      ['dcto_cuotas_t2', 6, 'Prepago manual — cuotas tramo 2', 'Prepago ingresado a mano con hasta este N° de cuotas pagadas descuenta el % del tramo 2. Con más cuotas no hay descuento', 'factor'],
    ]) await pool.query('INSERT IGNORE INTO comisiones_variables (clave, valor, etiqueta, descripcion, tipo) VALUES (?,?,?,?,?)', [clave, valor, etiqueta, descripcion, tipo]);

    await pool.query(`INSERT IGNORE INTO funcionalidades (id_funcionalidad, id_modulo, nombre, codigo, href, icono) VALUES
      (7800005, 150001, 'Revisión — ingresar descuentos por prepago o anulación', 'com_dcto_ingresar', NULL, NULL)`);
    for (const perfil of ['ADMINISTRADOR', 'ANALISTA DE OPERACIONES', 'GERENTE DE OPERACIONES%']) {
      const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE UPPER(nombre) LIKE ? ORDER BY id_perfil LIMIT 1', [perfil]);
      if (p) await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad)
                               SELECT ?, id_funcionalidad FROM funcionalidades WHERE codigo = 'com_dcto_ingresar'`, [p.id_perfil]);
    }
    console.log('[comisiones-descuentos] tabla + variables + permiso OK');
  } catch (e) { console.error('[comisiones-descuentos migration]', e.message); }
});

const R = n => Math.round(Number(n) || 0);
const clp = n => '$' + R(n).toLocaleString('es-CL');

/* Comisión efectivamente pagada al ejecutivo por una operación (cascada foto → motor). */
async function comisionPagadaOp(num_op) {
  const [[cr]] = await pool.query(
    `SELECT c.id, c.num_op, c.ejecutivo, c.monto_financiado, c.plazo, COALESCE(cl.nombre_completo, '') AS nombre_cliente,
            DATE_FORMAT(c.fecha_otorgado, '%Y-%m') AS mes_origen,
            UPPER(COALESCE(c.estado_credito,'')) AS estado_credito, UPPER(COALESCE(c.estado_cartera,'')) AS estado_cartera,
            (SELECT COUNT(*) FROM cuotas_credito q WHERE q.id_credito = c.id AND q.fecha_pago IS NOT NULL) AS cuotas_pagadas_bd
     FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente WHERE c.num_op = ? LIMIT 1`, [num_op]);
  if (!cr) return { error: `Operación ${num_op} no existe` };
  if (!cr.mes_origen) return { error: `La operación ${num_op} nunca fue otorgada: no se pagó comisión por ella`, credito: cr };
  if (!cr.ejecutivo) return { error: `La operación ${num_op} no tiene ejecutivo`, credito: cr };

  const { getVars, fabricaFactorOrigen } = require('./comisiones.controller');
  const monto = parseFloat(cr.monto_financiado) || 0;
  let pagada = null, fuente = null, detalle = null;

  // 1) Foto firme del mes en que se comisionó
  const [[ap]] = await pool.query(
    "SELECT foto_json FROM comisiones_aprobaciones WHERE mes = ? AND ejecutivo = ? AND estado = 'aprobado' LIMIT 1",
    [cr.mes_origen, cr.ejecutivo]).catch(() => [[null]]);
  if (ap && ap.foto_json) {
    try {
      const foto = typeof ap.foto_json === 'string' ? JSON.parse(ap.foto_json) : ap.foto_json;
      const f = (foto._creditos || {})[String(cr.num_op)];
      const sc = Number(foto.factor_semana_corrida) || 1;
      if (f) {
        const base = f.ajuste_comision ? Number(f.ajuste_comision.modificada) : Number(f.incentivo_base_credito || 0) + Number(f.incentivo_adicional_credito || 0);
        pagada = base * sc; fuente = 'APROBADA';
        detalle = { incentivo_base: Number(f.incentivo_base_credito || 0), adicional: Number(f.incentivo_adicional_credito || 0), ajuste: f.ajuste_comision || null, factor_sc: sc };
      } else if (foto.cumple_minimo === false || !foto.cumple_minimo) {
        pagada = 0; fuente = 'APROBADA'; detalle = { motivo: 'El ejecutivo no cumplió el mínimo ese mes: la operación no comisionó' };
      }
    } catch (_) {}
  }
  // 2) Motor único con las variables y el factor de ese mes
  if (pagada == null) {
    const vars = await getVars(cr.mes_origen);
    const { factor_ajuste, factor_sc } = await fabricaFactorOrigen(vars)(cr.mes_origen, cr.ejecutivo);
    const base = monto * (esPlazoMenor(cr.plazo, vars) ? vars.pct_24 : vars.pct_mas24);
    pagada = base * (1 + factor_ajuste) * factor_sc; fuente = 'CALCULADA';
    detalle = { incentivo_base: base, factor_ajuste, factor_sc };
  }
  return { credito: cr, comision_pagada: pagada, fuente, detalle };
}

/* % y glosa según tipo y cuotas, con las variables del mes de imputación. */
function tramo(tipo, cuotas, vars) {
  const v = (k, d) => (vars[k] != null && !Number.isNaN(Number(vars[k]))) ? Number(vars[k]) : d;
  if (tipo === 'ANULACION') return { pct: v('dcto_pct_anul', 1), glosa: n => `Descuento por anulación de OP${n}` };
  const c = parseInt(cuotas);
  if (!(c >= 0)) return { error: 'Indica el N° de cuotas pagadas' };
  let pct;
  if      (c <= v('dcto_cuotas_t1', 3)) pct = v('dcto_pct_t1', 1);
  else if (c <= v('dcto_cuotas_t2', 6)) pct = v('dcto_pct_t2', 0.5);
  else pct = 0;
  return { pct, cuotas: c, glosa: n => `Descuento por prepago de OP${n}, ${c} cuota${c === 1 ? '' : 's'} pagada${c === 1 ? '' : 's'}`,
           limite_t1: v('dcto_cuotas_t1', 3), limite_t2: v('dcto_cuotas_t2', 6) };
}

async function comisionAprobada(mes, ejecutivo) {
  const [[a]] = await pool.query("SELECT 1 x FROM comisiones_aprobaciones WHERE mes = ? AND ejecutivo = ? AND estado = 'aprobado' LIMIT 1", [mes, ejecutivo]);
  return !!a;
}

/* ── GET /descuentos/buscar-op?num_op=&mes=&tipo=&cuotas= — vista previa ── */
const buscarOp = async (req, res) => {
  try {
    const num_op = String(req.query.num_op || '').replace(/\D/g, '');
    const mes = String(req.query.mes || '').slice(0, 7);
    if (!num_op || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ success: false, data: null, error: 'num_op y mes (YYYY-MM) son obligatorios' });
    const r = await comisionPagadaOp(num_op);
    if (r.error) return res.status(400).json({ success: false, data: r.credito ? { credito: r.credito } : null, error: r.error });
    const { getVars } = require('./comisiones.controller');
    const vars = await getVars(mes);
    const tipo = String(req.query.tipo || 'ANULACION').toUpperCase();
    const t = tramo(tipo, req.query.cuotas, vars);
    const [[dup]] = await pool.query("SELECT id, mes, glosa FROM comisiones_descuentos_op WHERE num_op = ? AND estado = 'ACTIVO' LIMIT 1", [num_op]);
    res.json({ success: true, error: null, data: {
      num_op, ejecutivo: r.credito.ejecutivo, cliente: r.credito.nombre_cliente, mes_origen: r.credito.mes_origen,
      estado_credito: r.credito.estado_credito, estado_cartera: r.credito.estado_cartera, cuotas_pagadas_bd: Number(r.credito.cuotas_pagadas_bd || 0),
      comision_pagada: R(r.comision_pagada), fuente: r.fuente, detalle: r.detalle,
      pct: t.error ? null : t.pct, descuento: t.error ? null : R(r.comision_pagada * t.pct),
      glosa: t.error ? null : t.glosa(num_op), limite_t1: t.limite_t1, limite_t2: t.limite_t2,
      ya_descontada: dup || null, aprobada: await comisionAprobada(mes, r.credito.ejecutivo),
    } });
  } catch (e) { console.error('[descuentos buscarOp]', e.message); res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── GET /descuentos?mes= ── */
const listar = async (req, res) => {
  try {
    const mes = String(req.query.mes || '').slice(0, 7);
    const [rows] = await pool.query('SELECT * FROM comisiones_descuentos_op WHERE mes = ? ORDER BY creado_at DESC', [mes]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── POST /descuentos {mes, num_op, tipo, cuotas_pagadas, comentario} ── */
const crear = async (req, res) => {
  try {
    const b = req.body || {};
    const mes = String(b.mes || '').slice(0, 7), num_op = String(b.num_op || '').replace(/\D/g, '');
    const tipo = String(b.tipo || '').toUpperCase();
    if (!/^\d{4}-\d{2}$/.test(mes) || !num_op || !['ANULACION', 'PREPAGO'].includes(tipo))
      return res.status(400).json({ success: false, data: null, error: 'mes, num_op y tipo (ANULACION|PREPAGO) son obligatorios' });
    const [[cerrado]] = await pool.query('SELECT 1 c FROM meses_cerrados WHERE mes = ? AND cerrado = 1 LIMIT 1', [mes]).catch(() => [[null]]);
    if (cerrado) return res.status(400).json({ success: false, data: null, error: `El mes ${mes} está cerrado` });

    const r = await comisionPagadaOp(num_op);
    if (r.error) return res.status(400).json({ success: false, data: null, error: r.error });
    if (tipo === 'ANULACION' && r.credito.estado_credito !== 'ANULADO' && !String(b.comentario || '').trim())
      return res.status(400).json({ success: false, data: null, error: `La operación ${num_op} no figura ANULADA en Créditos (${r.credito.estado_credito}). Anúlala primero o indica en el comentario por qué se descuenta igual.` });
    if (await comisionAprobada(mes, r.credito.ejecutivo))
      return res.status(400).json({ success: false, data: null, error: `La comisión de ${r.credito.ejecutivo} del mes ${mes} ya está aprobada (valores firmes): Rechazar, ingresar el descuento y volver a Aprobar.` });
    const [[dup]] = await pool.query("SELECT id, mes FROM comisiones_descuentos_op WHERE num_op = ? AND estado = 'ACTIVO' LIMIT 1", [num_op]);
    if (dup) return res.status(400).json({ success: false, data: null, error: `La operación ${num_op} ya tiene un descuento vigente (mes ${dup.mes})` });

    const { getVars } = require('./comisiones.controller');
    const t = tramo(tipo, b.cuotas_pagadas, await getVars(mes));
    if (t.error) return res.status(400).json({ success: false, data: null, error: t.error });
    if (!(t.pct > 0)) return res.status(400).json({ success: false, data: null, error: `Con ${t.cuotas} cuotas pagadas no corresponde descuento (el tramo llega hasta ${t.limite_t2} cuotas)` });
    if (!(r.comision_pagada > 0)) return res.status(400).json({ success: false, data: null, error: `No se pagó comisión por la operación ${num_op} (${r.detalle && r.detalle.motivo ? r.detalle.motivo : 'comisión $0 en ' + r.credito.mes_origen})` });

    const descuento = R(r.comision_pagada * t.pct), glosa = t.glosa(num_op);
    const nombre = req.usuario.nombre || req.usuario.email;
    const [ins] = await pool.query(
      `INSERT INTO comisiones_descuentos_op (mes, num_op, ejecutivo, tipo, cuotas_pagadas, mes_origen, comision_pagada, fuente, pct, descuento, glosa, comentario, creado_por_id, creado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [mes, num_op, r.credito.ejecutivo, tipo, tipo === 'PREPAGO' ? t.cuotas : null, r.credito.mes_origen, R(r.comision_pagada), r.fuente, t.pct, descuento, glosa,
       String(b.comentario || '').trim() || null, req.usuario.id_usuario, nombre]);
    auditar({ req, accion: 'CREAR', modulo: 'comisiones', entidad: 'descuento_comision_op', entidad_id: String(ins.insertId),
      detalle: `${glosa} — ${r.credito.ejecutivo}, imputado a ${mes}: comisión pagada ${clp(r.comision_pagada)} (${r.fuente}, ${r.credito.mes_origen}) × ${Math.round(t.pct * 100)}% = ${clp(descuento)}` });
    res.json({ success: true, data: { id: ins.insertId, descuento, glosa, ejecutivo: r.credito.ejecutivo }, error: null });
  } catch (e) { console.error('[descuentos crear]', e.message); res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── DELETE /descuentos/:id {motivo} — anular (queda la traza) ── */
const anular = async (req, res) => {
  try {
    const [[d]] = await pool.query('SELECT * FROM comisiones_descuentos_op WHERE id = ? LIMIT 1', [req.params.id]);
    if (!d) return res.status(404).json({ success: false, data: null, error: 'Descuento no existe' });
    if (d.estado !== 'ACTIVO') return res.status(400).json({ success: false, data: null, error: 'El descuento ya está anulado' });
    const motivo = String((req.body || {}).motivo || '').trim();
    if (!motivo) return res.status(400).json({ success: false, data: null, error: 'Indica el motivo de la anulación' });
    if (await comisionAprobada(d.mes, d.ejecutivo))
      return res.status(400).json({ success: false, data: null, error: `La comisión de ${d.ejecutivo} del mes ${d.mes} ya está aprobada (valores firmes): Rechazar primero.` });
    const nombre = req.usuario.nombre || req.usuario.email;
    await pool.query("UPDATE comisiones_descuentos_op SET estado='ANULADO', anulado_por_id=?, anulado_por=?, anulado_at=NOW(), anulado_motivo=? WHERE id=?",
      [req.usuario.id_usuario, nombre, motivo, d.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'comisiones', entidad: 'descuento_comision_op', entidad_id: String(d.id),
      detalle: `Anuló "${d.glosa}" (${d.ejecutivo}, ${d.mes}, ${clp(d.descuento)}): ${motivo}` });
    res.json({ success: true, data: null, error: null });
  } catch (e) { console.error('[descuentos anular]', e.message); res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* Descuentos manuales ACTIVOS del mes, en la misma forma que las reversas
   automáticas, agrupados por ejecutivo. Lo consume calcularMes. */
async function manualesDelMes(mes) {
  const [rows] = await pool.query("SELECT * FROM comisiones_descuentos_op WHERE mes = ? AND estado = 'ACTIVO' ORDER BY id", [mes]).catch(() => [[]]);
  const por = {};
  for (const d of rows) (por[d.ejecutivo] = por[d.ejecutivo] || []).push({
    id: d.id, manual: true, num_op: String(d.num_op), tipo: d.tipo === 'ANULACION' ? 'ANULADA' : 'PREPAGADA',
    glosa: d.glosa, mes_origen: d.mes_origen, cuotas_pagadas: d.cuotas_pagadas, fuente: d.fuente,
    pct_descuento: Number(d.pct), comision_original: Number(d.comision_pagada), descuento: Number(d.descuento),
    comentario: d.comentario, creado_por: d.creado_por, revisar: null,
  });
  return por;
}

module.exports = { buscarOp, listar, crear, anular, manualesDelMes, comisionPagadaOp };
