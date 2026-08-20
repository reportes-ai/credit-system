/**
 * shared/auditoria.js
 * Helper de auditoría — fire-and-forget, jamás lanza ni frena la request principal.
 * Crea la tabla si no existe al arrancar.
 */
const pool = require('./config/database');

require('../shared/migrate').enFila('auditoria', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auditoria_credito (
        id_auditoria  INT AUTO_INCREMENT PRIMARY KEY,
        id_credito    INT          NOT NULL,
        fecha         DATETIME     DEFAULT CURRENT_TIMESTAMP,
        usuario       VARCHAR(200) NULL,
        id_usuario    INT          NULL,
        perfil        VARCHAR(100) NULL,
        accion        VARCHAR(60)  NOT NULL,
        detalle       TEXT         NULL,
        meta          JSON         NULL,
        ip            VARCHAR(45)  NULL,
        ref_origen    VARCHAR(100) NULL,
        INDEX idx_credito_fecha (id_credito, fecha DESC),
        UNIQUE KEY uq_ref_origen (ref_origen)
      )
    `);
    // Agregar ref_origen si la tabla ya existía sin ella
    await pool.query(`ALTER TABLE auditoria_credito ADD COLUMN ref_origen VARCHAR(100) NULL`)
      .catch(e => { if (e.errno !== 1060) throw e; });
    await pool.query(`ALTER TABLE auditoria_credito ADD UNIQUE KEY uq_ref_origen (ref_origen)`)
      .catch(e => { if (e.errno !== 1061 && e.errno !== 1062) throw e; });
  } catch(e) { if (e.errno !== 1050) console.error('[auditoria migration]', e.message); }
});

function _nombreUsuario(u) {
  if (!u) return 'Sistema';
  const n = [u.nombre, u.apellido].filter(Boolean).join(' ');
  return n || u.email || 'Usuario';
}

/**
 * @param {object} opts
 * @param {number}  opts.id_credito
 * @param {object}  opts.req          — express request (para extraer usuario + IP)
 * @param {string}  opts.accion       — clave: CREDITO_CREADO, ESTADO_CAMBIADO, …
 * @param {string}  [opts.detalle]    — texto legible
 * @param {object}  [opts.meta]       — datos adicionales (JSON)
 */
function registrar({ id_credito, req, accion, detalle, meta }) {
  // Fire & forget: no await en el caller
  (async () => {
    try {
      const u  = req?.usuario;
      const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
               || req?.socket?.remoteAddress
               || null;
      await pool.query(
        `INSERT INTO auditoria_credito
           (id_credito, usuario, id_usuario, perfil, accion, detalle, meta, ip)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          id_credito,
          _nombreUsuario(u),
          u?.id_usuario  || null,
          u?.perfil_nombre || null,
          accion,
          detalle || null,
          meta ? JSON.stringify(meta) : null,
          ip,
        ]
      );
    } catch(e) {
      console.error('[auditoria.registrar]', e.message);
    }
  })();
}

/**
 * Igual que `registrar()` pero IDEMPOTENTE: lleva `ref_origen` (clave única), así
 * que el mismo hecho nunca queda dos veces aunque se reintente o lo escriba
 * también el backfill. Se usa para hitos del ciclo de vida (nacimiento,
 * otorgamiento, anulación), donde el backfill histórico y el registro en vivo
 * pueden toparse sobre la misma operación.
 * @param {string} opts.ref_origen clave única del hecho (ej. `otg_1234`)
 * @param {Date|string} [opts.fecha] fecha del hecho (por defecto, ahora)
 */
function registrarUnico({ id_credito, req, accion, detalle, meta, ref_origen, fecha }) {
  (async () => {
    try {
      const u  = req?.usuario;
      const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
               || req?.socket?.remoteAddress
               || null;
      await pool.query(
        `INSERT IGNORE INTO auditoria_credito
           (id_credito, fecha, usuario, id_usuario, perfil, accion, detalle, meta, ip, ref_origen)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id_credito, fecha || new Date(), _nombreUsuario(u),
          u?.id_usuario || null, u?.perfil_nombre || null,
          accion, detalle || null, meta ? JSON.stringify(meta) : null, ip, ref_origen,
        ]
      );
    } catch(e) {
      console.error('[auditoria.registrarUnico]', e.message);
    }
  })();
}

module.exports = { registrar, registrarUnico };
