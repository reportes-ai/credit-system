'use strict';
/* ARAÑA (Spider 2.0 de AutoFin) — recepción de avisos. FASE DE PRUEBA (Pato, 02-10-2026).

   AutoFin ofrece conectarse a Trinidad a través de Araña. Además de las tres llamadas que
   hacemos nosotros (configuración, cuota, inyección), Araña puede AVISARNOS dos cosas, cada
   una a una dirección que se le configura por código de sucursal:
     1. el resultado de la inyección y de la evaluación automática  → POST /avisos/evaluacion
     2. cada cambio de estado de la solicitud en Trinidad           → POST /avisos/estado

   En esta fase el aviso SOLO SE GUARDA tal como llega (arana_avisos): todavía no toca
   créditos, cartas ni etapas. Sirve para ver con datos reales qué manda AutoFin antes de
   decidir cómo se enlaza con la operación (el IdTrinidad es nuestro id_financiera).

   Seguridad: las rutas son públicas (AutoFin no tiene nuestro JWT) y exigen el token de
   ARANA_AVISOS_TOKEN, que vive solo en el host. Sin esa variable las rutas responden 503:
   en producción quedan apagadas hasta que se decida encenderlas. */
const crypto = require('crypto');
const pool = require('../../../../shared/config/database');

require('../../../../shared/migrate').enFila('arana', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS arana_avisos (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    tipo          VARCHAR(12)  NOT NULL,            -- EVALUACION | ESTADO
    id_trinidad   BIGINT       NULL,                -- = creditos.id_financiera
    cod_externo   VARCHAR(80)  NULL,
    estado        VARCHAR(120) NULL,                -- EstadoEvaluacion o EstadoNuevo
    payload       JSON         NOT NULL,            -- el cuerpo tal como llegó
    ip            VARCHAR(64)  NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_arana_avisos_trinidad (id_trinidad),
    KEY idx_arana_avisos_fecha (created_at)
  )`);
});

/* El manual no dice cómo manda AutoFin el token (su parametría solo tiene "token sí/no" y
   una llave): se acepta en ?token=, en Authorization: Bearer o en los encabezados x-token /
   token / x-api-key, para no depender de esa respuesta durante la prueba. */
function tokenRecibido(req) {
  const h = req.headers || {};
  const auth = String(h.authorization || '');
  return String((req.query && req.query.token) || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : auth)
    || h['x-token'] || h.token || h['x-api-key'] || '').trim();
}
function exigirToken(req, res, next) {
  const esperado = String(process.env.ARANA_AVISOS_TOKEN || '');
  if (esperado.length < 24) return res.status(503).json({ success: false, data: null, error: 'Recepción de avisos no habilitada' });
  const a = crypto.createHash('sha256').update(tokenRecibido(req)).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, data: null, error: 'Token inválido' });
  next();
}

const entero = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const texto = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));

function recibir(tipo) {
  return async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length)
        return res.status(400).json({ success: false, data: null, error: 'Se esperaba un cuerpo JSON' });
      /* EVALUACION: { ResumenSpider: { DatosSolicitud: { IdTrinidad, EstadoEvaluacion, CodigoExterno… } } }
         ESTADO:     { DatosSolicitud: { IdTrinidad, EstadoNuevo, … } } */
      const ds = (body.ResumenSpider && body.ResumenSpider.DatosSolicitud) || body.DatosSolicitud || {};
      const [r] = await pool.query(
        'INSERT INTO arana_avisos (tipo, id_trinidad, cod_externo, estado, payload, ip) VALUES (?,?,?,?,?,?)',
        [tipo, entero(ds.IdTrinidad), texto(ds.CodigoExterno, 80),
         texto(tipo === 'ESTADO' ? ds.EstadoNuevo : ds.EstadoEvaluacion, 120),
         JSON.stringify(body), texto(req.ip, 64)]);
      res.json({ success: true, data: { id: r.insertId, recibido: true }, error: null });
    } catch (e) {
      console.error('[arana] aviso ' + tipo + ':', e.message);
      res.status(500).json({ success: false, data: null, error: 'No se pudo registrar el aviso' });
    }
  };
}

module.exports = { exigirToken, avisoEvaluacion: recibir('EVALUACION'), avisoEstado: recibir('ESTADO') };
