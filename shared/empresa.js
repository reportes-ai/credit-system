'use strict';
/* ─────────────────────────────────────────────────────────────────
   DATOS DE LA EMPRESA — fuente única (Máxima 2).
   Razón social, RUT, giro, domicilio, representante legal, contacto, mutual y
   CCAF viven en UNA fila (empresa_config id=1) que administra el mantenedor
   Mantenedores → Datos de la Empresa. Nadie más escribe "AUTOFACIL SpA" ni el
   RUT en el código: liquidaciones, LRE, F29, DJ, finiquitos, contratos,
   certificados, cartolas y credenciales leen de acá (Pato, 17-09-2026: "si
   pensamos aplicarlo a otras empresas el día de mañana").

   Nace sembrada con lo que ya existía disperso: credenciales_empresa
   (organización, dirección, web, teléfono, email), rh_config finiq_* (razón
   social, RUT, representante, ciudad) y rh_previred_config (CCAF, mutual).
   ───────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const CAMPOS = ['razon_social', 'nombre_fantasia', 'rut', 'giro', 'actividad_economica', 'domicilio', 'comuna', 'ciudad',
  'representante', 'rut_representante', 'telefono', 'email', 'web', 'logo_url', 'ccaf', 'mutual', 'sucursal_mutual'];

require('./migrate').migrar('empresa-config', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS empresa_config (
    id TINYINT PRIMARY KEY,
    razon_social VARCHAR(160) NOT NULL DEFAULT '',
    nombre_fantasia VARCHAR(120) NULL,
    rut VARCHAR(15) NOT NULL DEFAULT '',
    giro VARCHAR(200) NULL,
    actividad_economica VARCHAR(20) NULL,
    domicilio VARCHAR(200) NULL,
    comuna VARCHAR(80) NULL,
    ciudad VARCHAR(80) NULL,
    representante VARCHAR(160) NULL,
    rut_representante VARCHAR(15) NULL,
    telefono VARCHAR(30) NULL,
    email VARCHAR(120) NULL,
    web VARCHAR(200) NULL,
    logo_url VARCHAR(200) NULL,
    ccaf VARCHAR(2) NOT NULL DEFAULT '00',
    mutual VARCHAR(2) NOT NULL DEFAULT '02',
    sucursal_mutual VARCHAR(3) NULL,
    updated_by VARCHAR(120) NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  const [[ya]] = await pool.query('SELECT id FROM empresa_config WHERE id=1');
  if (ya) return;
  // Semilla desde lo que ya existía disperso
  const [[cred]] = await pool.query('SELECT organizacion, direccion, web, telefono, email FROM credenciales_empresa WHERE id=1').catch(() => [[null]]);
  const [cfg] = await pool.query("SELECT clave, valor FROM rh_config WHERE clave IN ('finiq_empresa','finiq_rut_empresa','finiq_representante','finiq_rut_representante','finiq_ciudad')").catch(() => [[]]);
  const c = {}; cfg.forEach(r => c[r.clave] = r.valor);
  const [[prev]] = await pool.query('SELECT ccaf, mutual, sucursal_mutual FROM rh_previred_config WHERE id=1').catch(() => [[null]]);
  await pool.query(`INSERT INTO empresa_config (id, razon_social, nombre_fantasia, rut, domicilio, ciudad, representante, rut_representante, telefono, email, web, ccaf, mutual, sucursal_mutual, updated_by)
    VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,'Semilla (migración empresa-config)')`,
    [c.finiq_empresa || 'AUTOFÁCIL SpA', cred?.organizacion || 'AutoFácil Crédito Automotriz', (c.finiq_rut_empresa || '76.545.638-K').replace(/\./g, '').toUpperCase(),
     cred?.direccion || null, c.finiq_ciudad || 'Santiago', c.finiq_representante || null, c.finiq_rut_representante || null,
     cred?.telefono || null, cred?.email || null, cred?.web || 'https://www.autofacilchile.cl', prev?.ccaf || '00', prev?.mutual || '02', prev?.sucursal_mutual || null]);
  console.log('[empresa] empresa_config sembrada desde credenciales/finiquito/previred');
});

let cache = null, cacheAt = 0;
const fmtRut = r => { const s = String(r || '').replace(/\./g, '').toUpperCase(); const [n, dv] = s.split('-'); if (!n || !dv) return s; return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv; };

/* Lectura única (caché 60 s). Devuelve además rut_formateado y nombre (fantasía o razón social). */
async function datosEmpresa() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  const [[e]] = await pool.query('SELECT * FROM empresa_config WHERE id=1').catch(() => [[null]]);
  const d = e || { razon_social: 'AUTOFÁCIL SpA', rut: '76545638-K', ccaf: '00', mutual: '02' };
  cache = { ...d, rut: String(d.rut || '').replace(/\./g, '').toUpperCase(), rut_formateado: fmtRut(d.rut), nombre: d.nombre_fantasia || d.razon_social,
            rut_representante_formateado: d.rut_representante ? fmtRut(d.rut_representante) : '' };
  cacheAt = Date.now();
  return cache;
}

async function guardarEmpresa(b, quien) {
  const vals = {};
  for (const k of CAMPOS) if (b[k] !== undefined) vals[k] = b[k] == null ? null : String(b[k]).trim().slice(0, 200);
  if (vals.rut !== undefined) {
    const RUT = require('../api-gateway/public/js/rut-core');
    vals.rut = vals.rut.replace(/\./g, '').toUpperCase();
    if (!RUT.validar(vals.rut)) throw new Error('RUT de la empresa inválido');
  }
  if (vals.rut_representante) {
    const RUT = require('../api-gateway/public/js/rut-core');
    vals.rut_representante = vals.rut_representante.replace(/\./g, '').toUpperCase();
    if (!RUT.validar(vals.rut_representante)) throw new Error('RUT del representante inválido');
  }
  if (vals.razon_social !== undefined && !vals.razon_social) throw new Error('La razón social es obligatoria');
  const keys = Object.keys(vals);
  if (!keys.length) return datosEmpresa();
  await pool.query(`UPDATE empresa_config SET ${keys.map(k => k + '=?').join(', ')}, updated_by=? WHERE id=1`, [...keys.map(k => vals[k]), quien || null]);
  cache = null;
  return datosEmpresa();
}

module.exports = { datosEmpresa, guardarEmpresa, invalidar: () => { cache = null; }, CAMPOS, fmtRut };
