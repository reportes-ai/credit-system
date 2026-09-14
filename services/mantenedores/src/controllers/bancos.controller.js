'use strict';
/* Mantenedor BANCOS DE LA PLAZA (Pato, 14-09-2026).
   Fuente única: rh_catalogo tipo='BANCO' (código SBIF). Nació dentro de Indicadores de Remuneraciones
   y se sacó a su propia card porque lo usan mucho más que RRHH: ficha del colaborador y Nómina Banco
   (Liquidaciones), el archivo TEF masivo del Banco Internacional (Saldos Precio, Comisiones Dealer,
   Comisiones Parques) y el reconocimiento de bancos de las fichas de dealers y parques.
   Nunca se borra un banco: se desactiva (los históricos siguen resolviendo su código). */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

// Card + permiso: solo BD (regla anti-hardcode). Hereda los perfiles que tenían Indicadores de Remuneraciones.
require('../../../../shared/migrate').enFila('mant-bancos', async () => {
  const [[ya]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_bancos' LIMIT 1");
  if (ya) return;
  const [[ref]] = await pool.query("SELECT id_modulo, id_funcionalidad FROM funcionalidades WHERE codigo='mant_remuneraciones' LIMIT 1");
  const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
    [ref ? ref.id_modulo : 30001, 'Bancos de la Plaza', 'mant_bancos', '/mantenedores/bancos/', 'bi-bank']);
  if (ref) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) SELECT id_perfil, ?, habilitado FROM permisos_perfil WHERE id_funcionalidad=?', [r.insertId, ref.id_funcionalidad]);
  console.log('[mant-bancos] card Bancos de la Plaza creada');
});

const listar = async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, codigo, nombre, activo FROM rh_catalogo WHERE tipo='BANCO' ORDER BY nombre");
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* PUT /api/bancos { bancos:[{nombre, codigo, activo}] } — upsert por nombre; código SBIF de 3 dígitos. */
const guardar = async (req, res) => {
  try {
    const lista = Array.isArray(req.body?.bancos) ? req.body.bancos : null;
    if (!lista) return res.status(400).json({ success: false, data: null, error: 'Lista de bancos requerida' });
    const malos = [];
    let n = 0;
    for (const r of lista) {
      const nombre = String(r.nombre || '').toUpperCase().replace(/\s+/g, ' ').trim();
      const cod = String(r.codigo || '').trim();
      const activo = r.activo === 0 || r.activo === false || r.activo === '0' ? 0 : 1;
      const id = parseInt(r.id) || null;
      if (!nombre) continue;
      if (!/^\d{3}$/.test(cod)) { malos.push(`${nombre}: código "${cod}" (deben ser 3 dígitos SBIF)`); continue; }
      /* Por ID cuando la fila ya existe: renombrar ("FALABELLA" → "BANCO FALABELLA") edita la misma fila.
         Con el upsert por nombre el renombre creaba un banco nuevo y quedaban duplicados (14-09-2026). */
      if (id) {
        const [[dupN]] = await pool.query("SELECT id FROM rh_catalogo WHERE tipo='BANCO' AND nombre=? AND id<>? LIMIT 1", [nombre, id]);
        if (dupN) { malos.push(`${nombre}: ya existe otro banco con ese nombre`); continue; }
        const [u] = await pool.query("UPDATE rh_catalogo SET nombre=?, codigo=?, activo=? WHERE id=? AND tipo='BANCO'", [nombre, cod, activo, id]);
        if (u.affectedRows) { n++; continue; }
      }
      await pool.query("INSERT INTO rh_catalogo (tipo, codigo, nombre, activo) VALUES ('BANCO',?,?,?) ON DUPLICATE KEY UPDATE codigo=VALUES(codigo), activo=VALUES(activo)", [cod, nombre, activo]);
      n++;
    }
    if (malos.length) return res.status(400).json({ success: false, data: null, error: 'No se guardó: ' + malos.join(' · ') });
    require('../../../../shared/bancos-cl').invalidar();   // /js/bancos-cl.js se regenera con la lista nueva
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'bancos', detalle: `Guardó Bancos de la Plaza (${n} bancos)` });
    res.json({ success: true, data: { guardados: n }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { listar, guardar };
