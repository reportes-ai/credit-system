'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PASAR LAS VARIABLES DE RENDER AL HOST DE CONTINGENCIA (Cloud Run)

   Lee las variables del servicio de producción por la API de Render y carga en
   `afbs-standby` las que le faltan. Nadie copia y pega nada: veinte copy-paste
   a mano es donde uno se pega mal, y ese error solo aparece **el día que se
   promueve el host**, o sea el peor día posible.

   USO
     node scripts/sincronizar-env-standby.js                → compara y muestra
     node scripts/sincronizar-env-standby.js --aplicar      → carga lo que falta

   La llave de Render sale de C:\\Users\\patri\\Downloads\\render-api-key.txt
   (o de la variable RENDER_API_KEY). Se borra apenas termine el traspaso.

   NO IMPRIME NI UN VALOR. Solo nombres y largos, para que se note un campo
   cortado sin exponer nada.

   LO QUE NO SE COPIA, Y POR QUÉ CADA UNO
     MOTORES           el standby debe seguir apagado. Encendido ejecutaría los
                       27 relojes contra la MISMA base que producción, y el daño
                       es silencioso: una comisión aprobada dos veces no se queja.
     GCS_CREDENCIALES  en Cloud Run sobra — el servicio usa su propia identidad,
                       sin llave que rotar ni que se pueda filtrar. Copiarla
                       sería un retroceso de seguridad.
     APP_URL           debe ser la del standby. Copiar la de producción haría que
                       los correos del host de respaldo enlacen al servidor caído.
     ENTORNO / PORT    los define el propio host.
     SII_*             las de Render están malas; copiar un valor equivocado no
                       arregla nada y disimula el pendiente.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const { execFileSync } = require('child_process');

const SERVICIO_CR = 'afbs-standby';
const REGION = 'us-east4';
const APP_URL_STANDBY = 'https://afbs2.autofacilchile.cl';
const GCLOUD = process.env.GCLOUD_BIN ||
  'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd';
const ARCHIVO_LLAVE = 'C:\\Users\\patri\\Downloads\\render-api-key.txt';
/* Identidad con la que corre el standby: es la que necesita permiso de lectura
   sobre cada secreto nuevo, o el servicio arranca y muere al no poder leerlo. */
const SA_RUNTIME = '821999538473-compute@developer.gserviceaccount.com';

const NO_COPIAR = new Set([
  'MOTORES', 'GCS_CREDENCIALES', 'PORT', 'ENTORNO', 'APP_URL',
  'SII_CLAVE', 'SII_RUT_USUARIO', 'SII_CERT_B64', 'SII_CERT_PASS',
]);

function llave() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY.trim();
  try { return fs.readFileSync(ARCHIVO_LLAVE, 'utf8').trim(); }
  catch { console.error(`\n✗ No encontré la llave. Ponela en ${ARCHIVO_LLAVE}\n`); process.exit(1); }
}

async function render(ruta, key) {
  const r = await fetch(`https://api.render.com/v1${ruta}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Render ${ruta} → ${r.status} ${r.statusText}`);
  return r.json();
}

/* `shell: true` es obligatorio en Windows: gcloud es un .cmd y Node se niega a
   ejecutarlo directo (EINVAL). Por eso ningún valor viaja como argumento — van
   todos por archivo. */
function gcloud(args) {
  /* Con `shell: true` la ruta la interpreta cmd.exe, y "Program Files" tiene un
     espacio: sin las comillas se corta en "C:\Program". */
  return execFileSync(`"${GCLOUD}"`, args, { encoding: 'utf8', shell: true });
}

/* Devuelve las variables actuales del standby CON su valor: al aplicar hay que
   reescribir el conjunto completo, y perder MOTORES=off en el camino sería
   encender los 27 motores contra la base de producción. */
function envDelStandby() {
  const json = gcloud(['run', 'services', 'describe', SERVICIO_CR,
    `--region=${REGION}`, '--format=json']);
  const spec = JSON.parse(json);
  const env = ((((spec.spec || {}).template || {}).spec || {}).containers || [{}])[0].env || [];
  /* `nombres` incluye TAMBIÉN las que vienen de Secret Manager (`valueFrom`,
     sin valor legible). Contarlas es imprescindible: si solo mirara las que
     traen valor, DB_PASSWORD y JWT_SECRET parecerían faltar y las cargaría de
     nuevo —esta vez en texto plano— al lado de las que ya existen. */
  const valores = new Map(), nombres = new Set();
  for (const e of env) {
    nombres.add(e.name);
    if (typeof e.value === 'string') valores.set(e.name, e.value);
  }
  return { valores, nombres };
}

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  const key = llave();

  const servicios = await render('/services?limit=50', key);
  const webs = servicios
    .map(s => s.service || s)
    .filter(s => s.type === 'web_service');
  if (!webs.length) { console.error('\n✗ No hay servicios web en esta cuenta de Render.\n'); process.exit(1); }

  /* Producción se identifica por su DOMINIO, no por el nombre ni por descarte.
     Hay tres servicios en la cuenta —uno de ellos suspendido, otro de staging—
     y copiar la configuración del equivocado es exactamente el error silencioso
     que este script existe para evitar. */
  let prod = null;
  for (const s of webs) {
    if (s.suspended === 'suspended') continue;
    const dom = await render(`/services/${s.id}/custom-domains`, key).catch(() => []);
    const nombres = dom.map(d => (d.customDomain || d).name || '');
    if (nombres.some(n => /^afbs\.autofacilchile\.cl$/i.test(n))) { prod = s; break; }
  }
  if (!prod) { console.error('\n✗ No encontré el servicio con el dominio afbs.autofacilchile.cl. No adivino: revisá a mano.\n'); process.exit(1); }
  console.log(`\n  Render:   ${prod.name} (${prod.id})`);
  console.log(`  Destino:  ${SERVICIO_CR} (${REGION})\n`);
  if (webs.length > 1) console.log(`  (otros servicios en la cuenta: ${webs.filter(s => s.id !== prod.id).map(s => s.name).join(', ')})\n`);

  const crudas = await render(`/services/${prod.id}/env-vars?limit=100`, key);
  const enRender = new Map();
  for (const e of crudas) {
    const v = e.envVar || e;
    if (typeof v.value === 'string') enRender.set(v.key, v.value);
  }

  const { valores: actuales, nombres: yaTiene } = envDelStandby();
  const nuevas = new Map();
  const saltadas = [], existentes = [];

  for (const [k, v] of enRender) {
    if (NO_COPIAR.has(k)) { saltadas.push(k); continue; }
    if (yaTiene.has(k)) { existentes.push(k); continue; }
    nuevas.set(k, v);
  }
  /* APP_URL se fuerza a la del standby en vez de copiarse. */
  if (!yaTiene.has('APP_URL')) nuevas.set('APP_URL', APP_URL_STANDBY);

  console.log(`  En Render: ${enRender.size} · ya en el standby: ${existentes.length} · no se copian: ${saltadas.length}\n`);
  for (const [k, v] of nuevas) console.log(`  + ${k.padEnd(28)} ${String(v.length).padStart(5)} caracteres`);
  if (saltadas.length) console.log(`\n  Excluidas a propósito: ${saltadas.join(', ')}`);
  if (!nuevas.size) { console.log('\n  No falta ninguna.\n'); process.exit(0); }

  if (!aplicar) { console.log(`\n  Vista previa. Para cargarlas:  node scripts/sincronizar-env-standby.js --aplicar\n`); process.exit(0); }

  /* Las llaves de verdad van a Secret Manager, NO como variable plana: es lo
     que el standby ya hacía con DB_PASSWORD, JWT_SECRET y MAIL_PASS, y romper
     esa convención dejaría la mitad de los secretos en un lugar y la mitad en
     otro. Además `--update-env-vars` es aditivo y no toca las referencias a
     secretos que ya existen — un `--env-vars-file` las habría borrado y el
     standby se quedaba sin base de datos. */
  const esSecreto = k => /(TOKEN|KEY|SECRET|PASS|B64|CREDENC)/i.test(k);
  const nombreSecreto = k => 'afbs-' + k.toLowerCase().replace(/_/g, '-');

  const existentes_sm = new Set(gcloud(['secrets', 'list', '--format=value(name)'])
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean));

  const planas = new Map(), secretos = new Map();
  for (const [k, v] of nuevas) (esSecreto(k) ? secretos : planas).set(k, v);

  console.log(`\n  ${secretos.size} van a Secret Manager · ${planas.size} como variable normal`);

  const tmp = `${process.env.TEMP || '.'}\\sec-${process.pid}.txt`;
  const refs = [];
  for (const [k, v] of secretos) {
    const nom = nombreSecreto(k);
    fs.writeFileSync(tmp, v, { mode: 0o600 });   // el valor viaja por archivo, nunca como argumento
    try {
      if (!existentes_sm.has(nom)) {
        gcloud(['secrets', 'create', nom, '--replication-policy=automatic', `--data-file="${tmp}"`, '--quiet']);
        console.log(`  + secreto ${nom}`);
      } else {
        gcloud(['secrets', 'versions', 'add', nom, `--data-file="${tmp}"`, '--quiet']);
        console.log(`  ~ ${nom}: versión nueva`);
      }
      gcloud(['secrets', 'add-iam-policy-binding', nom,
        `--member=serviceAccount:${SA_RUNTIME}`, '--role=roles/secretmanager.secretAccessor',
        '--quiet', '--format=none']);
    } finally { fs.rmSync(tmp, { force: true }); }
    refs.push(`${k}=${nom}:latest`);
  }

  const DELIM = '@@@';
  const args = ['run', 'services', 'update', SERVICIO_CR, `--region=${REGION}`, '--quiet'];
  if (planas.size) args.push(`"--update-env-vars=^${DELIM}^${[...planas].map(([k, v]) => `${k}=${v}`).join(DELIM)}"`);
  if (refs.length) args.push(`"--update-secrets=${refs.join(',')}"`);

  console.log('\n  Aplicando…');
  gcloud(args);
  console.log(`\n  ✓ ${nuevas.size} variables cargadas (${secretos.size} como secreto).`);
  console.log(`  Ahora: borrá ${ARCHIVO_LLAVE} y revocá la llave en Render.\n`);
})().catch(e => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
