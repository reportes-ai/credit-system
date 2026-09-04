'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   LATIDO DE HOST — detecta DOS procesos con motores encendidos contra la misma base.

   Por qué existe (04-09-2026): el servicio viejo de Render revivió el 12-08 con
   auto-deploy y los 28 motores activos, en paralelo al oficial, durante 23 días.
   El monitor de uptime lo "vio" desde el primer día (300 → 630 chequeos diarios)
   pero nadie lo leyó. Esta es la alerta que faltaba.

   Cómo: cada proceso escribe su latido en `host_latidos` (infra, corre incluso con
   MOTORES=off — así el standby también se ve). Si en la misma vuelta encuentra OTRO
   host con motores encendidos que latió en los últimos 3 minutos, avisa: correo a
   ALERTA_ERRORES_MAIL (máx. 1 cada 6 h por proceso) y `doble_host` en /api/health.
   Solo los hosts con motores cuentan: un standby dormido junto al oficial es normal.
   ───────────────────────────────────────────────────────────────────────────── */
const os = require('os');
const crypto = require('crypto');
const pool = require('./config/database');
const { programar, motoresActivos } = require('./scheduler');
const { NOMBRE: ENTORNO } = require('./entorno');
const { enFila } = require('./migrate');

const HOST_ID = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
/* Servicio al que pertenece el proceso (Render: RENDER_SERVICE_ID; si no, el hostname).
   Un deploy de Render levanta la instancia nueva y mantiene la vieja unos segundos
   hasta que la nueva responde: dos latidos del MISMO servicio en ese cruce son un
   relevo, no un doble host (falso positivo del 04-09-2026 al desplegar v222.28). */
const SERVICIO = process.env.RENDER_SERVICE_ID || process.env.K_SERVICE || os.hostname();
const RELEVO_MS = 10 * 60 * 1000;
const ARRANQUE = Date.now();
const CADA_MS = 60 * 1000;
const VENTANA_VIVO_MIN = 3;
const AVISO_CADA_MS = 6 * 60 * 60 * 1000;
let VERSION = '';
try { VERSION = String(require('fs').readFileSync(require('path').join(__dirname, '../api-gateway/public/js/app-version.js'), 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1] || ''); } catch (e) { /* sin versión */ }

let ultimoAviso = 0;
let estadoActual = { doble_host: false, hosts_con_motores: [] };

enFila('host_latidos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS host_latidos (
    host_id       VARCHAR(80)  NOT NULL PRIMARY KEY,
    hostname      VARCHAR(120) NULL,
    entorno       VARCHAR(30)  NULL,
    motores       TINYINT(1)   NOT NULL DEFAULT 1,
    version       VARCHAR(20)  NULL,
    arrancado_at  DATETIME     NOT NULL,
    ultimo_latido DATETIME     NOT NULL,
    KEY ix_latido (ultimo_latido)
  )`);
  await pool.query('ALTER TABLE host_latidos ADD COLUMN IF NOT EXISTS servicio VARCHAR(120) NULL');
});

async function latir() {
  const motores = motoresActivos() ? 1 : 0;
  await pool.query(
    `INSERT INTO host_latidos (host_id, hostname, entorno, motores, version, servicio, arrancado_at, ultimo_latido)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE motores=VALUES(motores), version=VALUES(version), servicio=VALUES(servicio), ultimo_latido=NOW()`,
    [HOST_ID, os.hostname(), ENTORNO, motores, VERSION, SERVICIO]);
  await pool.query('DELETE FROM host_latidos WHERE ultimo_latido < NOW() - INTERVAL 1 DAY').catch(() => {});

  const [vivos] = await pool.query(
    `SELECT host_id, hostname, entorno, version, servicio, arrancado_at, ultimo_latido
       FROM host_latidos
      WHERE motores = 1 AND ultimo_latido >= NOW() - INTERVAL ? MINUTE
      ORDER BY arrancado_at`, [VENTANA_VIVO_MIN]);
  // Relevo de deploy: instancia vieja del MISMO servicio, dentro de los primeros minutos de este proceso
  const enRelevo = Date.now() - ARRANQUE < RELEVO_MS;
  // Respaldo: filas sin `servicio` (procesos anteriores a la columna) → se deduce del hostname de Render (srv-<id>-<pod>)
  const servicioDe = h => h.servicio || (String(h.hostname || '').match(/^(srv-[a-z0-9]+)/) || [])[1] || null;
  const otros = vivos.filter(h => h.host_id === HOST_ID || !(enRelevo && servicioDe(h) && servicioDe(h) === SERVICIO));
  const doble = motores === 1 && otros.length > 1;
  estadoActual = { doble_host: doble, hosts_con_motores: otros.map(h => ({ ...h, yo: h.host_id === HOST_ID })) };
  if (!doble) return;

  const ajenos = otros.filter(h => h.host_id !== HOST_ID);
  console.error(`🚨 [latido-host] DOBLE HOST con motores encendidos contra la misma base: ${ajenos.map(h => `${h.hostname} (${h.version || '?'}, desde ${h.arrancado_at})`).join(', ')}`);
  const ahora = Date.now();
  if (ahora - ultimoAviso < AVISO_CADA_MS) return;
  ultimoAviso = ahora;
  const destino = process.env.ALERTA_ERRORES_MAIL || '';
  if (!destino) return;
  const { enviarCorreo, mailConfigurado } = require('./mailer');
  if (!mailConfigurado()) return;
  const filas = otros.map(h => `<tr><td>${h.hostname}${h.host_id === HOST_ID ? ' <b>(este)</b>' : ''}</td><td>${h.entorno || ''}</td><td>${h.version || ''}</td><td>${new Date(h.arrancado_at).toLocaleString('es-CL', { timeZone: 'America/Santiago' })}</td></tr>`).join('');
  await enviarCorreo({
    to: destino,
    subject: `🚨 Doble host: ${otros.length} procesos con motores encendidos contra la misma base`,
    html: `<p><b>Hay ${otros.length} procesos ejecutando los motores automáticos contra la misma base de datos.</b>
      Cada reloj (comisiones, desistimientos, devengos, correos) está disparando ${otros.length} veces.</p>
      <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px"><tr><th>Host</th><th>Entorno</th><th>Versión</th><th>Arrancó</th></tr>${filas}</table>
      <p>Qué hacer: en Render (dashboard.render.com) debe existir <b>un solo</b> servicio activo. El standby de Cloud Run debe correr con <code>MOTORES=off</code>.
      Ver pendiente 1.8 de PENDIENTES.md y <code>docs/CONTINGENCIA-cloud-run.md</code>.</p>
      <p style="color:#888;font-size:12px">Máx. 1 correo cada 6 h por proceso. Estado en vivo: /api/health → doble_host.</p>`,
  }).catch(() => {});
}

programar('latido-host', () => latir().catch(e => console.error('[latido-host]', e.message)), CADA_MS, { infra: true, enStaging: true, arranqueMs: 20 * 1000 });

/** Para /api/health: ¿hay más de un proceso con motores? y quiénes laten. */
const estado = () => ({ ...estadoActual, host_id: HOST_ID });

module.exports = { estado, latir, HOST_ID };
