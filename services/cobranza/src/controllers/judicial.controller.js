'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   COBRANZA JUDICIAL — cartera demandada (migración CARTERA AFA).
   - `cobranza_judicial`: 1 fila por operación con los datos judiciales
     (abogado, status legal, juzgado, rol, comentario…) + SNAPSHOT financiero
     del corte de la base (saldo, provisión, días mora, último pago) + la fila
     original completa en `raw` (no se pierde nada del Excel).
   - `creditos` gana 2 columnas: cartera_original y status_cobranza.
   - Catálogos PARAMÉTRICOS en `cobranza_jud_catalogo` (tipo: ABOGADO /
     STATUS_LEGAL / STATUS_CREDITO) con su mantenedor.
   - La migración de datos corre UNA VEZ con scripts/migrar-cartera-afa.js.
   ───────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

const TIPOS_CATALOGO = ['ABOGADO', 'STATUS_LEGAL', 'STATUS_CREDITO'];
const SEED = {
  ABOGADO:        ['GESTICOM', 'ISASI'],
  STATUS_LEGAL:   ['NO ASIGNADO', 'SIN PAGARE', 'NOTIFICADO', 'EMBARGO', 'SENTENCIA', 'FUERZA PUBLICA', 'REMATE', 'TERMINADO'],
  STATUS_CREDITO: ['DEMANDADO', 'COBR. EXTRA JUDICIAL', 'PAGANDO', 'INCOBRABLE', 'CERRADO'],
};

/* ── Migración de estructura ────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('judicial', async () => {
  try {
    await pool.query("ALTER TABLE creditos ADD COLUMN IF NOT EXISTS cartera_original VARCHAR(40) NULL");
    await pool.query("ALTER TABLE creditos ADD COLUMN IF NOT EXISTS status_cobranza VARCHAR(40) NULL");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cobranza_judicial (
        id INT AUTO_INCREMENT PRIMARY KEY,
        num_op VARCHAR(20) NOT NULL UNIQUE,
        rut VARCHAR(15) NULL,
        cartera_original VARCHAR(40) NULL,
        status_credito VARCHAR(40) NULL,          -- DEMANDADO / CERRADO / INCOBRABLE / PAGANDO / COBR. EXTRA JUDICIAL
        abogado VARCHAR(80) NULL,
        status_legal VARCHAR(40) NULL,            -- EMBARGO / NOTIFICADO / REMATE / …
        juzgado VARCHAR(60) NULL,
        rol VARCHAR(40) NULL,
        fecha_ultimo_status DATE NULL,
        comentario TEXT NULL,
        gastos_procesales DECIMAL(15,2) NULL,
        pagare VARCHAR(60) NULL,
        garantia_sistema DECIMAL(15,2) NULL,
        -- snapshot financiero al corte de la base migrada
        saldo_deuda DECIMAL(15,2) NULL,
        provision DECIMAL(15,2) NULL,
        reversos DECIMAL(15,2) NULL,
        no_provisionado DECIMAL(15,2) NULL,
        dias_mora INT NULL,
        fecha_ingreso_mora DATE NULL,
        fecha_ultimo_pago DATE NULL,
        cuotas_pagadas INT NULL,
        monto_original DECIMAL(15,2) NULL,
        cuotas INT NULL,
        tasa DECIMAL(9,6) NULL,
        valor_cuota DECIMAL(15,2) NULL,
        raw JSON NULL,                             -- fila original completa del Excel
        origen VARCHAR(30) NOT NULL DEFAULT 'CARTERA_AFA',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_rut (rut), INDEX idx_status (status_credito), INDEX idx_abogado (abogado)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cobranza_jud_catalogo (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL,                 -- ABOGADO | STATUS_LEGAL | STATUS_CREDITO
        nombre VARCHAR(80) NOT NULL,
        orden INT NOT NULL DEFAULT 0,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        UNIQUE KEY uq_tipo_nombre (tipo, nombre)
      )`);
    for (const [tipo, vals] of Object.entries(SEED))
      for (let i = 0; i < vals.length; i++)
        await pool.query('INSERT IGNORE INTO cobranza_jud_catalogo (tipo, nombre, orden) VALUES (?,?,?)', [tipo, vals[i], i]);

    // Mantenedor (funcionalidad con href bajo Mantenedores) + permiso Admin
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='cobranza_judicial_mant' LIMIT 1");
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Cobranza Judicial (catálogos)', 'cobranza_judicial_mant', '/mantenedores/cobranza-judicial/', 'bi-bank')`, [mod.id_modulo]);
        idF = r.insertId;
      }
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    }
    console.log('[cobranza-judicial] estructura lista');
  } catch (e) { console.error('[cobranza-judicial migration]', e.message); }
});

/* ── Catálogos (mantenedor) ─────────────────────────────────────────────── */
exports.getCatalogos = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM cobranza_jud_catalogo ORDER BY tipo, orden, nombre');
    const data = {};
    for (const t of TIPOS_CATALOGO) data[t] = rows.filter(r => r.tipo === t);
    ok(res, data);
  } catch (e) { fail(res, e.message); }
};
exports.crearCatalogo = async (req, res) => {
  try {
    const { tipo, nombre } = req.body || {};
    if (!TIPOS_CATALOGO.includes(tipo)) return fail(res, 'Tipo inválido', 400);
    if (!nombre || !String(nombre).trim()) return fail(res, 'Falta el nombre', 400);
    const [[mx]] = await pool.query('SELECT IFNULL(MAX(orden),0) m FROM cobranza_jud_catalogo WHERE tipo=?', [tipo]);
    const [r] = await pool.query('INSERT INTO cobranza_jud_catalogo (tipo, nombre, orden) VALUES (?,?,?)',
      [tipo, String(nombre).trim().toUpperCase().slice(0, 80), mx.m + 1]);
    auditar({ req, accion: 'CREAR', modulo: 'cobranza', entidad: 'jud_catalogo', entidad_id: r.insertId, detalle: `${tipo}: ${nombre}` });
    ok(res, { id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return fail(res, 'Ya existe ese valor en el catálogo.', 400);
    fail(res, e.message);
  }
};
exports.updateCatalogo = async (req, res) => {
  try {
    const { nombre, activo, orden } = req.body || {};
    const [[c]] = await pool.query('SELECT * FROM cobranza_jud_catalogo WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'No existe', 404);
    await pool.query('UPDATE cobranza_jud_catalogo SET nombre=?, activo=?, orden=? WHERE id=?',
      [nombre ? String(nombre).trim().toUpperCase().slice(0, 80) : c.nombre,
       activo !== undefined ? (activo ? 1 : 0) : c.activo,
       orden !== undefined ? (parseInt(orden, 10) || 0) : c.orden, c.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'cobranza', entidad: 'jud_catalogo', entidad_id: c.id, detalle: `${c.tipo}: ${c.nombre} → ${nombre || c.nombre}` });
    ok(res, { actualizado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Cartera judicial ───────────────────────────────────────────────────── */
exports.listar = async (req, res) => {
  try {
    const where = [], pars = [];
    if (req.query.q) { where.push('(j.num_op LIKE ? OR j.rut LIKE ? OR cl.nombre_completo LIKE ? OR j.rol LIKE ?)');
      pars.push(...Array(4).fill(`%${req.query.q}%`)); }
    for (const [col, qk] of [['status_credito','status'], ['abogado','abogado'], ['status_legal','legal'], ['cartera_original','cartera']])
      if (req.query[qk]) { where.push(`j.${col}=?`); pars.push(req.query[qk]); }
    const [rows] = await pool.query(
      `SELECT j.*, cl.nombre_completo
         FROM cobranza_judicial j
         LEFT JOIN clientes cl ON REPLACE(REPLACE(UPPER(cl.rut),'.',''),' ','') = REPLACE(REPLACE(UPPER(j.rut),'.',''),' ','')
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY j.saldo_deuda DESC LIMIT 1000`, pars);
    const [[tot]] = await pool.query(
      `SELECT COUNT(*) n, IFNULL(SUM(saldo_deuda),0) saldo, IFNULL(SUM(provision),0) provision,
              IFNULL(SUM(gastos_procesales),0) gastos FROM cobranza_judicial`);
    ok(res, { rows, totales: tot });
  } catch (e) { fail(res, e.message); }
};

/* Expediente judicial de UN crédito (read-only, para la ficha del CRM de
   cobranza — cualquier usuario de cobranza, no requiere el permiso del
   mantenedor). Sin `raw`. */
exports.expediente = async (req, res) => {
  try {
    const [[cr]] = await pool.query('SELECT num_op FROM creditos WHERE id=?', [req.params.id_credito]);
    if (!cr) return fail(res, 'Crédito no existe', 404);
    const [[j]] = await pool.query(
      `SELECT id, num_op, rut, cartera_original, status_credito, abogado, status_legal,
              juzgado, rol, fecha_ultimo_status, comentario, gastos_procesales, pagare,
              garantia_sistema, saldo_deuda, provision, dias_mora, fecha_ingreso_mora,
              fecha_ultimo_pago
         FROM cobranza_judicial WHERE num_op=?`, [cr.num_op]);
    ok(res, j || null);
  } catch (e) { fail(res, e.message); }
};

exports.actualizar = async (req, res) => {
  try {
    const [[j]] = await pool.query('SELECT * FROM cobranza_judicial WHERE id=?', [req.params.id]);
    if (!j) return fail(res, 'Operación no existe', 404);
    const b = req.body || {};
    const campos = ['abogado', 'status_legal', 'status_credito', 'juzgado', 'rol', 'comentario', 'pagare'];
    const sets = [], vals = [];
    for (const c of campos) if (b[c] !== undefined) { sets.push(`${c}=?`); vals.push(String(b[c] || '').trim().slice(0, 600) || null); }
    if (b.fecha_ultimo_status !== undefined) {
      sets.push('fecha_ultimo_status=?');
      vals.push(/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_ultimo_status || '')) ? b.fecha_ultimo_status : null);
    }
    if (b.gastos_procesales !== undefined) { sets.push('gastos_procesales=?'); vals.push(Number(b.gastos_procesales) || 0); }
    if (!sets.length) return fail(res, 'Sin cambios', 400);
    vals.push(j.id);
    await pool.query(`UPDATE cobranza_judicial SET ${sets.join(', ')} WHERE id=?`, vals);
    // status del crédito espejado en creditos (misma fuente de verdad para el chip)
    if (b.status_credito !== undefined)
      await pool.query('UPDATE creditos SET status_cobranza=? WHERE num_op=?', [b.status_credito || null, j.num_op]);
    auditar({ req, accion: 'EDITAR', modulo: 'cobranza', entidad: 'cobranza_judicial', entidad_id: j.id,
      detalle: `Judicial OP ${j.num_op}: ${Object.keys(b).join(', ')}`, rut: j.rut });
    ok(res, { actualizado: true });
  } catch (e) { fail(res, e.message); }
};
