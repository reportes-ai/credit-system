'use strict';
/* ════════════════════════════════════════════════════════════════════════
   Verificación de documentos por QR (núcleo reutilizable).
   Cada documento (certificado, comprobante de cuota, orden de pago pagada, …)
   se registra acá con un CÓDIGO único y un SNAPSHOT "en duro" de sus datos.
   El QR codifica  https://<app>/verificar/<codigo>  → página pública que
   confirma autenticidad mostrando datos MÍNIMOS. El snapshot no cambia aunque
   cambie el registro original (igual que la orden de pago en duro).
   ════════════════════════════════════════════════════════════════════════ */
const pool   = require('./config/database');
const crypto = require('crypto');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documentos_verificables (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        codigo           VARCHAR(40)  NOT NULL UNIQUE,
        tipo             VARCHAR(50)  NOT NULL,
        ref_tabla        VARCHAR(50)  NULL,
        ref_id           VARCHAR(50)  NULL,
        num_op           INT          NULL,
        rut_cliente      VARCHAR(20)  NULL,
        nombre_cliente   VARCHAR(200) NULL,
        datos_json       LONGTEXT     NULL,
        emitido_por      VARCHAR(200) NULL,
        anulado          TINYINT(1)   DEFAULT 0,
        motivo_anulacion VARCHAR(300) NULL,
        created_at       DATETIME     DEFAULT NOW(),
        INDEX idx_ref    (ref_tabla, ref_id),
        INDEX idx_num_op (num_op)
      )`);
    console.log('✓ documentos_verificables: tabla lista');
  } catch (e) { console.error('[verificacion schema]', e.message); }
})();

// Token corto, irrepetible y URL-safe (12 chars, sin caracteres ambiguos).
function nuevoCodigo() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin I,O,0,1
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += abc[b[i] % abc.length];
  return s;
}

/* Registra (o actualiza el snapshot de) un documento verificable.
   Idempotente por (ref_tabla, ref_id): si ya existe, devuelve el mismo código. */
async function registrarVerificable({ tipo, ref_tabla = null, ref_id = null, num_op = null, rut = null, nombre = null, datos = null, emitido_por = null }) {
  const datosStr = datos ? JSON.stringify(datos) : null;
  if (ref_tabla && ref_id != null) {
    const [ex] = await pool.query(
      'SELECT codigo FROM documentos_verificables WHERE ref_tabla=? AND ref_id=? LIMIT 1',
      [ref_tabla, String(ref_id)]);
    if (ex.length) {
      await pool.query(
        'UPDATE documentos_verificables SET datos_json=?, num_op=?, rut_cliente=?, nombre_cliente=?, emitido_por=COALESCE(emitido_por,?) WHERE codigo=?',
        [datosStr, num_op, rut, nombre, emitido_por, ex[0].codigo]);
      return ex[0].codigo;
    }
  }
  let codigo = nuevoCodigo();
  for (let i = 0; i < 6; i++) {
    const [c] = await pool.query('SELECT 1 FROM documentos_verificables WHERE codigo=? LIMIT 1', [codigo]);
    if (!c.length) break;
    codigo = nuevoCodigo();
  }
  await pool.query(
    `INSERT INTO documentos_verificables (codigo, tipo, ref_tabla, ref_id, num_op, rut_cliente, nombre_cliente, datos_json, emitido_por)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [codigo, tipo, ref_tabla, ref_id != null ? String(ref_id) : null, num_op, rut, nombre, datosStr, emitido_por]);
  return codigo;
}

async function getVerificable(codigo) {
  const [rows] = await pool.query(
    `SELECT codigo, tipo, num_op, rut_cliente, nombre_cliente, datos_json, emitido_por, anulado, motivo_anulacion, created_at
       FROM documentos_verificables WHERE codigo=? LIMIT 1`, [String(codigo || '').trim()]);
  if (!rows.length) return null;
  const r = rows[0];
  let datos = null; try { datos = r.datos_json ? JSON.parse(r.datos_json) : null; } catch (_) {}
  return { codigo: r.codigo, tipo: r.tipo, num_op: r.num_op, rut: r.rut_cliente, nombre: r.nombre_cliente,
           datos, emitido_por: r.emitido_por, anulado: !!r.anulado, motivo: r.motivo_anulacion, created_at: r.created_at };
}

async function anularVerificable(codigo, motivo) {
  await pool.query('UPDATE documentos_verificables SET anulado=1, motivo_anulacion=? WHERE codigo=?', [motivo || null, codigo]);
}

module.exports = { registrarVerificable, getVerificable, anularVerificable };
