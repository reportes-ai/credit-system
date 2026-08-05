'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CARGAR VARIABLES EN EL HOST DE CONTINGENCIA (Cloud Run: afbs-standby)

   Lee un archivo `CLAVE=valor` y las aplica al servicio. Existe para no tener
   que pegar veinte secretos a mano en la consola —donde uno se pega mal y el
   error solo aparece el día que se promueve el host, o sea el peor día—.

   USO
     node scripts/cargar-env-standby.js <archivo>          → muestra qué haría
     node scripts/cargar-env-standby.js <archivo> --aplicar

   LO QUE ESTE SCRIPT NO HACE, A PROPÓSITO
   - No imprime ni un valor. Solo nombres y el largo, para que se note un campo
     vacío o pegado a medias sin exponer nada.
   - No toca MOTORES. El standby debe seguir con los motores apagados: encendido
     ejecutaría los 27 relojes contra la misma base que producción, y el daño es
     silencioso (una comisión aprobada dos veces no se queja).
   - No borra variables. Solo agrega o reemplaza las que vengan en el archivo.

   BORRAR EL ARCHIVO DESPUÉS. Mientras exista, es todas las llaves juntas.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const { execFileSync } = require('child_process');

const SERVICIO = 'afbs-standby';
const REGION = 'us-east4';
const GCLOUD = process.env.GCLOUD_BIN ||
  'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd';

/* Nunca se cargan desde archivo, aunque vengan: ver el encabezado. */
const PROHIBIDAS = new Set(['MOTORES', 'GCS_CREDENCIALES', 'PORT']);

const archivo = process.argv[2];
const aplicar = process.argv.includes('--aplicar');
if (!archivo) {
  console.error('\n  Uso: node scripts/cargar-env-standby.js <archivo> [--aplicar]\n');
  process.exit(1);
}

const vars = new Map();
const vacias = [];
for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
  const t = linea.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  const clave = t.slice(0, i).trim();
  const valor = t.slice(i + 1).trim();
  if (PROHIBIDAS.has(clave)) { console.log(`  ~ ${clave}: se ignora a propósito (ver el encabezado del script)`); continue; }
  if (!valor) { vacias.push(clave); continue; }
  vars.set(clave, valor);
}

console.log(`\n  Servicio: ${SERVICIO} (${REGION})`);
console.log(`  Archivo:  ${archivo}\n`);
for (const [k, v] of vars) console.log(`  ✓ ${k.padEnd(28)} ${String(v.length).padStart(5)} caracteres`);
if (vacias.length) console.log(`\n  Sin valor (se saltan): ${vacias.join(', ')}`);
if (!vars.size) { console.log('\n  No hay nada que cargar.\n'); process.exit(0); }

if (!aplicar) {
  console.log(`\n  Esto es solo la vista previa. Para aplicarlo:`);
  console.log(`  node scripts/cargar-env-standby.js "${archivo}" --aplicar\n`);
  process.exit(0);
}

/* Delimitador propio: los valores traen '=' , ',' y '/' (tokens, URLs, base64)
   y el separador por defecto de gcloud los partiría por la mitad. */
const DELIM = '@@@';
const pares = [...vars].map(([k, v]) => `${k}=${v}`).join(DELIM);
for (const [k, v] of vars) {
  if (v.includes(DELIM)) { console.error(`\n✗ ${k} contiene "${DELIM}" y rompería el separador. Cargala a mano.\n`); process.exit(1); }
}

console.log('\n  Aplicando…');
try {
  execFileSync(GCLOUD, [
    'run', 'services', 'update', SERVICIO,
    `--region=${REGION}`,
    `--update-env-vars=^${DELIM}^${pares}`,
    '--quiet',
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`\n  ✓ ${vars.size} variables cargadas. Ahora BORRÁ el archivo.\n`);
} catch (e) {
  console.error('\n✗ Falló la actualización. El servicio quedó en su revisión anterior.\n');
  process.exit(1);
}
