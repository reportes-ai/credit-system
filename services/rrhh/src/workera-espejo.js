'use strict';
// Espejo de permisos hacia Workera: cuando acá se APRUEBA una vacación, licencia
// o permiso, se crea la "salida especial" equivalente en Workera para que sus
// reportes de asistencia no muestren inasistencia. El mapeo tipo→código es
// paramétrico (rh_config): en Workera solo son asignables por API los tipos de
// salida especial que tienen CÓDIGO en el panel — si la clave está vacía, ese
// tipo simplemente no se espeja (queda avisado en el log).
const pool = require('../../../shared/config/database');
const workera = require('./workera');

require('../../../shared/migrate').enFila('rrhh-workera-espejo', async () => {
  for (const t of ['rh_vacaciones', 'rh_ausencias']) {
    try { await pool.query(`ALTER TABLE ${t} ADD COLUMN workera_permiso_id INT NULL`); } catch (e) { if (e.errno !== 1060) throw e; }
  }
  await pool.query(`INSERT IGNORE INTO rh_config (clave, valor) VALUES
    ('workera_permiso_vacaciones', ''), ('workera_permiso_licencia', ''),
    ('workera_permiso_singoce', 'P01'), ('workera_permiso_congoce', '001'), ('workera_permiso_otros', '')`);
  console.log('[workera-espejo] listo');
});

// Nuestro tipo de ausencia → clave rh_config con el código Workera
function claveDe(tipo) {
  const t = String(tipo || '').toUpperCase();
  if (t === 'VACACIONES') return 'workera_permiso_vacaciones';
  if (t.includes('LICENCIA')) return 'workera_permiso_licencia';
  if (t.includes('SIN GOCE')) return 'workera_permiso_singoce';
  if (t.includes('CON GOCE')) return 'workera_permiso_congoce';
  if (t.includes('INJUSTIFICADA')) return null; // una falta NO se espeja como permiso
  return 'workera_permiso_otros';
}

// Espeja un permiso aprobado. Devuelve el id en Workera o null (sin código / error).
// Nunca lanza: el espejo jamás debe frenar la aprobación local.
async function espejar({ idUsuario, tipo, desde, hasta, comentario, tabla, id }) {
  try {
    if (!workera.configurado()) return null;
    const clave = claveDe(tipo);
    if (!clave) return null;
    const [[cfg]] = await pool.query('SELECT valor FROM rh_config WHERE clave=?', [clave]);
    const code = (cfg?.valor || '').trim();
    if (!code) { console.log(`[workera-espejo] sin código para ${tipo} (${clave} vacía) — no se espeja`); return null; }
    const [[u]] = await pool.query('SELECT rut FROM usuarios WHERE id_usuario=?', [idUsuario]);
    const employeeCode = String(u?.rut || '').replace(/[.\s-]/g, '').slice(0, -1); // rut sin DV = código de ficha Workera
    if (!employeeCode) return null;
    const iso = f => String(f instanceof Date ? f.toISOString() : f).slice(0, 10);
    const r = await workera.crearPermiso({
      employeeCode, permissionCode: code,
      start: iso(desde) + 'T00:00:00', end: iso(hasta) + 'T23:59:59',
      comment: (comentario || `${tipo} aprobada en AutoFácil BS`).slice(0, 200),
    });
    if (r?.id && tabla && id) await pool.query(`UPDATE ${tabla} SET workera_permiso_id=? WHERE id=?`, [r.id, id]);
    console.log(`[workera-espejo] ${tipo} ${iso(desde)}→${iso(hasta)} espejada (Workera #${r?.id})`);
    return r?.id || null;
  } catch (e) { console.error('[workera-espejo]', e.message); return null; }
}

module.exports = { espejar };
