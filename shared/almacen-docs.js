'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ALMACÉN DE DOCUMENTOS — motor único de "dónde vive un archivo" (Máxima 1).

   PROBLEMA QUE RESUELVE
   Hasta ahora cada archivo que sube un usuario (fundantes, fichas de dealer,
   anexos de cartas, documentos de crédito) se guardaba DENTRO de la base, en
   una columna LONGBLOB. Funciona, pero la base terminó siendo 95% archivos:
   toda la operación del negocio —17.932 créditos, 18.634 clientes, la
   contabilidad completa— pesa ~6 MB, y los documentos 112,9 MB.

   Eso importa por tres razones concretas:
     · TiDB cobra por almacenamiento Y por consulta. Un PDF de 2 MB dentro de
       una fila encarece cada lectura de esa tabla, la use o no.
     · El respaldo nocturno arrastra los archivos: pasó de 38 MB a 118 MB en
       quince días, y se guardan 30 copias.
     · La trayectoria: 300 archivos hoy, pero Fundantes tiene 4.940 operaciones
       en seguimiento. El destino es multi-GB dentro de la base.

   LA REGLA
   El archivo vive en el bucket de Google Cloud Storage; la base guarda SOLO la
   referencia (`doc_storage` + `doc_ruta`). El bucket NO es disco de servidor
   —esa es la lección de los informes DealerNet— es almacenamiento de objetos,
   accesible igual desde Render y desde el host de contingencia.

   POR QUÉ UN MOTOR Y NO SEIS MIGRACIONES
   Son seis tablas con el mismo problema. Si cada controlador resuelve su
   subida y su descarga por su cuenta, terminamos con seis criterios de nombre
   de ruta, seis manejos de error y seis lugares donde arreglar el próximo bug.
   Acá se sube, se lee y se borra en un solo lugar.

   CONVIVENCIA (deliberada, no transitoria)
   El motor lee de los DOS lados: si la fila trae `doc_ruta` va al bucket, si
   trae el blob lo sirve de la base. Eso permite migrar de a poco, deja el
   camino de vuelta abierto, y hace que el sistema siga funcionando completo
   en un ambiente SIN bucket configurado (local, staging, o el standby antes
   de que se le carguen las credenciales).

   SI EL BUCKET FALLA AL GUARDAR se guarda en la base y se avisa en el log.
   Una subida de documento nunca se cae por un problema de infraestructura;
   el barrido posterior (`scripts/migrar-docs-bucket.js`) la recoge después.
   ───────────────────────────────────────────────────────────────────────────── */

const BUCKET = String(process.env.GCS_BUCKET || '').trim();

let _bucket = null;      // instancia perezosa
let _intentado = false;  // para no reintentar la construcción en cada llamada
let _motivo = 'sin GCS_BUCKET definido';

/* Construcción perezosa: el módulo se puede requerir siempre, aunque no haya
   bucket ni librería instalada. Así ningún controlador necesita preguntarse
   si el almacén está disponible antes de importarlo. */
function bucket() {
  if (_intentado) return _bucket;
  _intentado = true;
  if (!BUCKET) return null;
  try {
    const { Storage } = require('@google-cloud/storage');
    /* Dos formas de autenticarse, en este orden:
         1. GCS_CREDENCIALES — el JSON de la cuenta de servicio, en una env var.
            Es lo que necesita Render, que no vive dentro de Google.
         2. Credenciales del ambiente (ADC) — en Cloud Run la identidad del
            servicio alcanza sola, sin llave que rotar ni que se pueda filtrar. */
    const raw = String(process.env.GCS_CREDENCIALES || '').trim();
    const opts = raw ? { credentials: JSON.parse(raw) } : {};
    if (process.env.GCS_PROYECTO) opts.projectId = process.env.GCS_PROYECTO;
    _bucket = new Storage(opts).bucket(BUCKET);
    _motivo = null;
  } catch (e) {
    _motivo = e.message;
    console.warn(`⚠ Almacén de documentos: bucket "${BUCKET}" no disponible (${e.message}). Se usará la base.`);
    _bucket = null;
  }
  return _bucket;
}

/** ¿Hay bucket para escribir? Si no, todo sigue guardándose en la base. */
const activo = () => !!bucket();

/** Para /api/health y el informe de Salud del Sistema. */
const estado = () => ({ activo: activo(), bucket: BUCKET || null, motivo: activo() ? null : _motivo });

/* Nombres de archivo: llegan de un usuario, así que no se confía en ellos.
   Sin acentos, sin espacios, sin barras — una barra en el nombre inventaría
   una carpeta dentro del bucket y rompería el borrado por prefijo. */
function limpiar(txt, tope = 80) {
  return String(txt || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, tope) || 'archivo';
}

/**
 * Ruta canónica de un documento dentro del bucket.
 *   ambito → carpeta lógica (fundantes, cartas, dealers…)
 *   clave  → identificador estable del dueño (id_credito, id_ficha…)
 *   nombre → nombre original del archivo
 * Se antepone un sello de tiempo para que resubir el mismo documento no pise
 * la versión anterior: el reemplazo se decide en la base, no en el bucket.
 */
function rutaDe({ ambito, clave, nombre, sello }) {
  const t = sello || new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  return `${limpiar(ambito, 40)}/${limpiar(clave, 60)}/${t}-${limpiar(nombre)}`;
}

/**
 * Guarda un archivo y devuelve QUÉ escribir en la fila.
 *
 *   const d = await almacen.colocar({ ambito:'fundantes', clave:id, buffer, mime, nombre });
 *   → { storage:'gcs', ruta:'fundantes/123/2026…-carnet.pdf', blob:null, bytes }
 *   → { storage:'db',  ruta:null, blob:<Buffer>, bytes }   (sin bucket, o si falló)
 *
 * El controlador escribe las tres columnas tal cual vienen. No decide nada.
 */
async function colocar({ ambito, clave, buffer, mime, nombre }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('colocar(): se esperaba un Buffer');
  const bytes = buffer.length;
  const b = bucket();
  if (!b) return { storage: 'db', ruta: null, blob: buffer, bytes };

  const ruta = rutaDe({ ambito, clave, nombre });
  try {
    await b.file(ruta).save(buffer, {
      resumable: false,
      contentType: mime || 'application/octet-stream',
      metadata: { cacheControl: 'private, max-age=0' }
    });
    return { storage: 'gcs', ruta, blob: null, bytes };
  } catch (e) {
    /* Deliberado: la subida NO se cae por el bucket. Queda en la base y el
       barrido posterior la mueve. Un documento perdido es peor que uno mal
       ubicado. */
    console.error(`⚠ Almacén: falló subir ${ruta} (${e.message}). Se guarda en la base.`);
    return { storage: 'db', ruta: null, blob: buffer, bytes };
  }
}

/**
 * Devuelve el contenido de un documento, esté donde esté.
 * `fila` es la fila tal como salió del SELECT: se le pasa la ruta y el blob.
 */
/* EL BLOB MANDA CUANDO ESTÁ. Durante la migración un documento existe en los dos
   lados: mientras el blob siga ahí se lee de la base, sin red y sin credenciales.
   Eso elimina una trampa de orden que si no sería fácil de pisar — marcar filas
   como migradas en un servidor que todavía no alcanza el bucket dejaría esos
   documentos inaccesibles. Recién cuando el blob se suelta (paso deliberado y
   aparte) el bucket pasa a ser la única fuente. */
async function obtener({ ruta, blob }) {
  if (blob) return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (ruta) {
    const b = bucket();
    if (!b) {
      /* Marcado para que los controladores respondan 503 con la causa y no un 500
         genérico: la alerta por correo debe decir "este host no tiene bucket"
         (pasó con el host secundario de Render sin GCS_BUCKET, 04-09-2026). */
      const e = new Error(`El documento vive en el bucket "${BUCKET || '(sin definir)'}" y este servidor no tiene acceso (${_motivo}).`);
      e.code = 'SIN_ALMACEN'; e.status = 503;
      throw e;
    }
    const [buf] = await b.file(ruta).download();
    return buf;
  }
  return null;
}

/**
 * Sirve un documento por HTTP. Un solo lugar para las cabeceras: el nombre de
 * archivo se sanea para la cabecera (comillas y no-ASCII rompen Content-Disposition).
 */
async function servir(res, { ruta, blob, nombre, mime, adjunto = false }) {
  let buf;
  try { buf = await obtener({ ruta, blob }); }
  catch (e) {
    if (e.code === 'SIN_ALMACEN') { console.error('[almacen]', e.message); return res.status(503).json({ success: false, data: null, error: 'Este servidor no tiene acceso al almacén de documentos (sin GCS_BUCKET). Entra por el host oficial.' }); }
    throw e;
  }
  if (!buf) return res.status(404).json({ success: false, data: null, error: 'Archivo no encontrado' });
  const seguro = String(nombre || 'documento').replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_');
  res.set('Content-Type', mime || 'application/octet-stream');
  res.set('Content-Disposition', `${adjunto ? 'attachment' : 'inline'}; filename="${seguro}"`);
  return res.send(buf);
}

/**
 * Borra el objeto del bucket. Nunca lanza: si el archivo ya no está, el
 * resultado deseado —que no exista— ya se cumplió. El borrado de la FILA es
 * responsabilidad del controlador y ese sí debe fallar si falla.
 */
async function borrar(ruta) {
  if (!ruta) return false;
  const b = bucket();
  if (!b) return false;
  try {
    await b.file(ruta).delete({ ignoreNotFound: true });
    return true;
  } catch (e) {
    console.error(`⚠ Almacén: no se pudo borrar ${ruta} (${e.message}).`);
    return false;
  }
}

/**
 * Columnas que toda tabla de documentos necesita. Se llama desde la migración
 * del controlador dueño de la tabla, para que el esquema no se defina en dos
 * lados. `blobCol` se deja NULL-able: la fila migrada suelta su blob.
 */
function sqlColumnas(tabla) {
  return [
    `ALTER TABLE \`${tabla}\` ADD COLUMN doc_storage VARCHAR(10) NOT NULL DEFAULT 'db'`,
    `ALTER TABLE \`${tabla}\` ADD COLUMN doc_ruta VARCHAR(500) NULL`,
    `ALTER TABLE \`${tabla}\` ADD COLUMN doc_bytes BIGINT NULL`
  ];
}

module.exports = { activo, estado, colocar, obtener, servir, borrar, rutaDe, limpiar, sqlColumnas, BUCKET };
