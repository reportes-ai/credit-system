'use strict';
/**
 * Visibilidad de ejecutivos por usuario — regla central y paramétrica.
 *
 * Cada PERFIL tiene un "ámbito de ejecutivos" (columna perfiles.ambito_ejecutivos):
 *   - 'todos'     → ve las operaciones de TODOS los ejecutivos (default; Admin, Gerencia, etc.).
 *   - 'asignados' → ve SOLO los ejecutivos marcados para ese usuario en `usuario_ejecutivos`
 *                   (mismo mapeo que Comisiones; se setea en Usuarios → "Ejecutivos asignados").
 *
 * Así, para soportar varios supervisores: se marca el perfil del supervisor como
 * 'asignados' y a cada supervisor se le asignan los ejecutivos de su equipo. Cada uno
 * ve solo su equipo. Un "Ejecutivo Comercial" (sembrado en 'asignados') ve solo lo suyo.
 *
 * Seguro por defecto: al crear la columna sólo "Ejecutivo Comercial" queda en 'asignados';
 * el resto sigue viendo todo hasta que un Administrador cambie el ámbito del perfil.
 *
 * Devuelve { all:true, lista:null }  ó  { all:false, lista:[nombres...] }.
 */
const pool = require('./config/database');

(async () => {
  try {
    const [[col]] = await pool.query(
      "SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='perfiles' AND column_name='ambito_ejecutivos'");
    if (!col.c) {
      await pool.query("ALTER TABLE perfiles ADD COLUMN ambito_ejecutivos VARCHAR(20) NOT NULL DEFAULT 'todos'");
      // Siembra inicial: sólo el Ejecutivo Comercial queda acotado a lo suyo (resto = 'todos').
      await pool.query("UPDATE perfiles SET ambito_ejecutivos='asignados' WHERE nombre='Ejecutivo Comercial'");
      console.log('[visibilidad-ejecutivos] columna perfiles.ambito_ejecutivos creada + seed');
    }
  } catch (e) { console.error('[visibilidad-ejecutivos migration]', e.message); }
})();

const CACHE_MS = 60 * 1000;
let _cache = null, _exp = 0;
async function ambitos() {
  if (_cache && _exp > Date.now()) return _cache;
  const m = {};
  try {
    const [rows] = await pool.query('SELECT nombre, ambito_ejecutivos FROM perfiles');
    rows.forEach(p => { m[p.nombre] = p.ambito_ejecutivos || 'todos'; });
  } catch (_) { /* si falla, todos ven todo (no bloquea) */ }
  _cache = m; _exp = Date.now() + CACHE_MS;
  return m;
}

/**
 * @param {{id_usuario:number, perfil_nombre:string}} usuario  (req.usuario)
 * @returns {Promise<{all:boolean, lista:string[]|null}>}
 */
async function ejecutivosVisibles(usuario) {
  if (!usuario || !usuario.id_usuario) return { all: true, lista: null };
  const m = await ambitos();
  const amb = m[usuario.perfil_nombre] || 'todos';
  if (amb !== 'asignados') return { all: true, lista: null };
  const [asg] = await pool.query('SELECT ejecutivo FROM usuario_ejecutivos WHERE id_usuario = ?', [usuario.id_usuario]);
  const lista = asg.map(r => r.ejecutivo);
  // Un ejecutivo SIEMPRE ve sus propias operaciones: se incluye su nombre (nombre + apellido)
  // aunque no se le haya asignado explícitamente en usuario_ejecutivos. Así un Ejecutivo
  // Comercial nuevo ve lo suyo sin configuración previa. (El match final es case-insensitive.)
  const propio = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  if (propio && !lista.some(x => String(x).toUpperCase() === propio.toUpperCase())) lista.push(propio);
  return { all: false, lista };
}

// Invalida la caché de ámbitos (llamar al guardar el ámbito de un perfil para efecto inmediato).
const invalidarCache = () => { _exp = 0; };

module.exports = { ejecutivosVisibles, invalidarCache };
