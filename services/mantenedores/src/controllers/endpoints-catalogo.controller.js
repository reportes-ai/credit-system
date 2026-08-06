'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   CATÁLOGO DE ENDPOINTS — auto-generado del código, nunca a mano.

   QUÉ ES: escanea api-gateway/src/index.js (los mounts app.use) y todos los
   archivos de rutas montados, y arma el inventario vivo: método, ruta completa,
   si exige token y qué permisos requireFunc la gobiernan.

   PARA QUÉ: es una herramienta de AUDITORÍA más que un manual — su valor está
   en la columna que marca en rojo lo desprotegido:
     · ruta de ESCRITURA con token pero SIN requireFunc → cualquier usuario
       logueado puede ejecutarla (hallazgo pendiente de la auditoría 05-08-2026)
     · ruta sin verifyToken → pública (debe ser deliberado: webhook, login, QR)
   Un catálogo a mano de ~1.300 endpoints nace muerto; este se regenera del
   código en cada consulta, así que nunca miente.
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const pool = require('../../../../shared/config/database');

const RAIZ = path.join(__dirname, '../../../../');

require('../../../../shared/migrate').enFila('endpoints-catalogo', async () => {
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_endpoints' LIMIT 1");
    if (!ex) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (30001, 'Catálogo de Endpoints', 'mant_endpoints', '/mantenedores/endpoints/', 'bi-hdd-network')`);
      await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)', [r.insertId]);
    }
  } catch (e) { console.error('[endpoints-catalogo migration]', e.message); }
});

/* Mounts del gateway: app.use('/api/xxx', require('...routes')) → base + archivo. */
function leerMounts() {
  const src = fs.readFileSync(path.join(RAIZ, 'api-gateway/src/index.js'), 'utf8');
  const out = [];
  const re = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, base, req] = m;
    if (!req.includes('/routes/') && !req.endsWith('.routes')) continue;
    const archivo = path.join(RAIZ, 'api-gateway/src', req + (req.endsWith('.js') ? '' : '.js'));
    out.push({ base, archivo });
  }
  return out;
}

/* Parsea un archivo de rutas: método, ruta y middlewares de cada router.X(...).
   Toma desde `router.get(` hasta el salto de línea siguiente al primer `ctrl.`
   o el cierre — suficiente para el patrón uniforme del proyecto. */
function parsearRutas(archivo) {
  let src;
  try { src = fs.readFileSync(archivo, 'utf8'); } catch { return []; }
  const out = [];
  // Constantes locales del archivo (patrón `const FUNC = 'mant_avisos'` o
  // `const ver = requireFunc('x','y')`): se resuelven para no perder permisos.
  const constStr = {};   // const FUNC = 'mant_avisos'
  let c; const reC = /const\s+(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g;
  while ((c = reC.exec(src))) constStr[c[1]] = [c[2]];
  const constMw = {};    // const ver = requireFunc('x','y') — middleware con nombre
  const reCF = /const\s+(\w+)\s*=\s*require(?:Func|Perfil)\(([^)]*)\)/g;
  while ((c = reCF.exec(src))) {
    const codigos = (c[2].match(/['"`]([^'"`]+)['"`]/g) || []).map(x => x.slice(1, -1));
    (c[2].match(/\b[A-Za-z_]\w*\b/g) || []).forEach(id => { if (constStr[id]) codigos.push(...constStr[id]); });
    constMw[c[1]] = codigos;
  }
  const re = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]([\s\S]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(src))) {
    const [, metodo, ruta, resto] = m;
    const permisos = [];
    const reF = /require(?:Func|Perfil)\(([^)]*)\)/g;
    let f;
    while ((f = reF.exec(resto))) {
      (f[1].match(/['"`]([^'"`]+)['"`]/g) || []).forEach(x => permisos.push(x.slice(1, -1)));
      (f[1].match(/\b[A-Za-z_]\w*\b/g) || []).forEach(id => { if (constStr[id]) permisos.push(...constStr[id]); });
    }
    // Middlewares por variable local (`const ver = requireFunc('x')` usado como `ver`)
    for (const [nombre, codigos] of Object.entries(constMw)) {
      if (new RegExp('[,(]\\s*' + nombre + '\\s*[,)]').test(resto) && Array.isArray(codigos)) permisos.push(...codigos);
    }
    out.push({
      metodo: metodo.toUpperCase(), ruta,
      token: /verifyToken/.test(resto),
      permisos: [...new Set(permisos)],
    });
  }
  return out;
}

/* GET /api/endpoints-catalogo — el inventario completo, recién escaneado. */
exports.catalogo = async (_req, res) => {
  try {
    const rows = [];
    for (const { base, archivo } of leerMounts()) {
      const servicio = path.relative(RAIZ, archivo).split(path.sep).slice(0, 2).join('/');
      for (const r of parsearRutas(archivo)) {
        const escritura = r.metodo !== 'GET';
        rows.push({
          servicio, metodo: r.metodo,
          ruta: (base + (r.ruta === '/' ? '' : r.ruta)).replace(/\/+/g, '/'),
          token: r.token, permisos: r.permisos,
          // Semáforo: escritura autenticada sin permiso = expuesta a todo usuario logueado
          alerta: escritura && r.token && !r.permisos.length ? 'SIN_PERMISO'
                : !r.token ? 'PUBLICA' : null,
        });
      }
    }
    rows.sort((a, b) => a.ruta.localeCompare(b.ruta) || a.metodo.localeCompare(b.metodo));
    const resumen = {
      total: rows.length,
      escritura_sin_permiso: rows.filter(r => r.alerta === 'SIN_PERMISO').length,
      publicas: rows.filter(r => r.alerta === 'PUBLICA').length,
      con_permiso: rows.filter(r => r.permisos.length).length,
    };
    res.json({ success: true, data: { resumen, rows }, error: null });
  } catch (e) { console.error('[endpoints-catalogo]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
