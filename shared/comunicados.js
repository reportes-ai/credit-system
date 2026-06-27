'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Comunicados manuales: un banner push que un admin envía a un destino concreto
   (toda la empresa / un perfil de cargo / una persona / un área = centro de costo).
   - Configurable: mensaje, colores, ancho, y duración (segundos) o PERMANENTE
     (queda con una X para que el usuario lo cierre).
   - Entrega: getEstado (/api/mantenimiento) devuelve los comunicados activos que
     matchean al usuario; el front (app-version.js) los muestra (dedup por id en
     localStorage; los permanentes reaparecen hasta que el usuario los cierra).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const ready = (async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS comunicados (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      mensaje       VARCHAR(500) NOT NULL,
      destino_tipo  VARCHAR(20)  NOT NULL DEFAULT 'todos',   -- todos | perfil | usuario | area
      destino_valor VARCHAR(120) DEFAULT NULL,
      color_fondo   VARCHAR(20)  NOT NULL DEFAULT '#0a0a0a',
      color_texto   VARCHAR(20)  NOT NULL DEFAULT '#ffffff',
      ancho_pct     INT          NOT NULL DEFAULT 40,
      sonido        VARCHAR(20)  NOT NULL DEFAULT 'none',
      permanente    TINYINT(1)   NOT NULL DEFAULT 0,
      duracion_seg  INT          NOT NULL DEFAULT 10,
      activo        TINYINT(1)   NOT NULL DEFAULT 1,
      creado_por    VARCHAR(150) DEFAULT NULL,
      creado_por_nombre VARCHAR(200) DEFAULT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query("ALTER TABLE comunicados ADD COLUMN IF NOT EXISTS sonido VARCHAR(20) NOT NULL DEFAULT 'none'").catch(() => {});
  } catch (e) { console.error('[comunicados migration]', e.message); }
})();

const TIPOS = ['todos', 'perfil', 'usuario', 'area'];

async function crear(c, usuario) {
  await ready;
  const tipo = TIPOS.includes(c.destino_tipo) ? c.destino_tipo : 'todos';
  await pool.query(
    `INSERT INTO comunicados (mensaje, destino_tipo, destino_valor, color_fondo, color_texto, ancho_pct, sonido, permanente, duracion_seg, creado_por, creado_por_nombre)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [String(c.mensaje || '').slice(0, 500), tipo, tipo === 'todos' ? null : String(c.destino_valor || '').slice(0, 120),
     String(c.color_fondo || '#0a0a0a').slice(0, 20), String(c.color_texto || '#ffffff').slice(0, 20),
     Math.min(100, Math.max(15, parseInt(c.ancho_pct) || 40)), String(c.sonido || 'none').slice(0, 20), c.permanente ? 1 : 0,
     Math.min(120, Math.max(3, parseInt(c.duracion_seg) || 10)),
     (usuario && usuario.email) || null, (usuario && [usuario.nombre, usuario.apellido].filter(Boolean).join(' ')) || null]);
}

async function listarActivos() {
  await ready;
  const [r] = await pool.query('SELECT * FROM comunicados WHERE activo = 1 ORDER BY id DESC');
  return r;
}

async function desactivar(id) {
  await ready;
  await pool.query('UPDATE comunicados SET activo = 0 WHERE id = ?', [id]);
}

// Comunicados activos que le corresponden a este usuario (forma lista para el front).
async function comunicadosParaUsuario(usuario) {
  try {
    await ready;
    const [rows] = await pool.query('SELECT * FROM comunicados WHERE activo = 1');
    if (!rows.length) return [];
    const perfil = usuario && usuario.perfil_nombre;
    const idu = usuario && usuario.id_usuario;
    let area = null;
    if (rows.some(r => r.destino_tipo === 'area') && idu) {
      try { const [[u]] = await pool.query('SELECT centro_costo FROM usuarios WHERE id_usuario = ?', [idu]); area = u && u.centro_costo; } catch (_) {}
    }
    const out = [];
    for (const r of rows) {
      let m = false;
      if (r.destino_tipo === 'todos') m = true;
      else if (r.destino_tipo === 'perfil') m = String(r.destino_valor || '') === String(perfil || '');
      else if (r.destino_tipo === 'usuario') m = String(r.destino_valor || '') === String(idu || '');
      else if (r.destino_tipo === 'area') m = !!area && String(r.destino_valor || '').toLowerCase() === String(area || '').toLowerCase();
      if (m) out.push({ id: r.id, mensaje: r.mensaje, permanente: !!r.permanente, dur: r.duracion_seg, bg: r.color_fondo, fg: r.color_texto, ancho: r.ancho_pct, sonido: r.sonido || 'none' });
    }
    return out;
  } catch (e) { return []; }
}

// Para el composer: perfiles, usuarios y áreas (centro de costo) disponibles.
async function meta() {
  await ready;
  const [perfiles] = await pool.query('SELECT nombre FROM perfiles ORDER BY nombre');
  const [usuarios] = await pool.query("SELECT id_usuario, TRIM(CONCAT(nombre,' ',COALESCE(apellido,''))) AS nombre FROM usuarios WHERE estado IS NULL OR estado <> 'inactivo' ORDER BY nombre");
  const [areas] = await pool.query("SELECT DISTINCT centro_costo AS area FROM usuarios WHERE centro_costo IS NOT NULL AND centro_costo <> '' ORDER BY centro_costo");
  return { perfiles: perfiles.map(p => p.nombre), usuarios, areas: areas.map(a => a.area) };
}

module.exports = { crear, listarActivos, desactivar, comunicadosParaUsuario, meta };
