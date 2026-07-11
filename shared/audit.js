/**
 * shared/audit.js
 * Bitácora transversal de movimientos (auditoría). Fire-and-forget: nunca
 * lanza ni frena la request principal. Crea la tabla al arrancar.
 *
 * Uso:
 *   const { auditar } = require('../../../../shared/audit');
 *   auditar({ req, modulo:'comisiones', accion:'APROBAR', entidad:'comision',
 *             entidad_id: id, detalle:'Aprobó comisión de Juan (mayo 2026)' });
 */
const pool = require('./config/database');

require('../shared/migrate').enFila('audit', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auditoria_movimientos (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        fecha       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        id_usuario  INT          NULL,
        usuario     VARCHAR(200) NULL,
        perfil      VARCHAR(100) NULL,
        modulo      VARCHAR(60)  NULL,
        accion      VARCHAR(60)  NOT NULL,
        entidad     VARCHAR(60)  NULL,
        entidad_id  VARCHAR(60)  NULL,
        detalle     TEXT         NULL,
        rut         VARCHAR(30)  NULL,
        meta        JSON         NULL,
        ip          VARCHAR(45)  NULL,
        INDEX idx_fecha (fecha),
        INDEX idx_usuario (id_usuario),
        INDEX idx_accion (accion),
        INDEX idx_modulo (modulo)
      )
    `);
    // Marca de acción realizada por un suplente "a nombre del" titular (backup de funciones).
    await pool.query('ALTER TABLE auditoria_movimientos ADD COLUMN IF NOT EXISTS id_titular INT NULL').catch(() => {});
    await pool.query('ALTER TABLE auditoria_movimientos ADD COLUMN IF NOT EXISTS titular_nombre VARCHAR(200) NULL').catch(() => {});
  } catch (e) { if (e.errno !== 1050) console.error('[audit migration]', e.message); }
});

const _nombre = u => {
  if (!u) return 'Sistema';
  const n = [u.nombre, u.apellido].filter(Boolean).join(' ');
  return n || u.email || 'Usuario';
};
const _ip = req =>
  req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
  || req?.socket?.remoteAddress || null;

/**
 * Registra un movimiento de auditoría. Fire & forget — NO usar await en el caller.
 * @param {object} o
 * @param {object}        [o.req]        express request (de él se extrae usuario + IP)
 * @param {string}         o.accion      LOGIN, LOGOUT, APROBAR, RECHAZAR, ELIMINAR, EDITAR, CREAR, …
 * @param {string}        [o.modulo]     comisiones, cartas, usuarios, creditos, …
 * @param {string}        [o.entidad]    credito, usuario, comision, cartola, …
 * @param {string|number} [o.entidad_id]
 * @param {string}        [o.detalle]    texto legible
 * @param {string}        [o.rut]        rut relevante (cliente/dealer) si aplica
 * @param {object}        [o.meta]       datos extra (JSON)
 * @param {object}        [o.usuario]    override del actor (p.ej. login: req.usuario aún no existe)
 */
function auditar({ req, accion, modulo, entidad, entidad_id, detalle, rut, meta, usuario } = {}) {
  (async () => {
    try {
      const u = usuario || req?.usuario;
      // Si el actor es suplente con backup de FUNCIONES activo, la acción se atribuye al
      // titular (con asterisco rojo en Auditoría). No aplica a LOGIN/LOGOUT.
      let idTitular = null, titularNombre = null;
      if (u?.id_usuario && accion !== 'LOGIN' && accion !== 'LOGOUT') {
        try {
          const [[bk]] = await pool.query(
            `SELECT b.id_titular, TRIM(CONCAT(t.nombre,' ',COALESCE(t.apellido,''))) AS nombre
               FROM usuario_backups b JOIN usuarios t ON t.id_usuario = b.id_titular
              WHERE b.b_funciones = 1 AND b.id_suplente = ? LIMIT 1`, [u.id_usuario]);
          if (bk) { idTitular = bk.id_titular; titularNombre = bk.nombre; }
        } catch (_) { /* backups opcional */ }
      }
      await pool.query(
        `INSERT INTO auditoria_movimientos
           (id_usuario, usuario, perfil, modulo, accion, entidad, entidad_id, detalle, rut, meta, ip, id_titular, titular_nombre)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ u?.id_usuario || null, _nombre(u), u?.perfil_nombre || null,
          modulo || null, accion, entidad || null,
          entidad_id != null ? String(entidad_id) : null,
          detalle || null, rut || null,
          meta ? JSON.stringify(meta) : null, _ip(req), idTitular, titularNombre ]
      );
    } catch (e) { console.error('[audit]', e.message); }
  })();
}

module.exports = { auditar };
