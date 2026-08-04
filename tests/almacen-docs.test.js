'use strict';
/* El ALMACÉN DE DOCUMENTOS — shared/almacen-docs.js

   Estas pruebas corren SIN bucket configurado, que es exactamente el escenario
   de local, de staging y del host de contingencia antes de que se le carguen
   las credenciales. Lo que se verifica acá es que en ese escenario el sistema
   siga guardando y sirviendo documentos igual que siempre —desde la base— y
   que los nombres que llegan de un usuario no puedan inventar rutas. */
const { test } = require('node:test');
const assert = require('node:assert');
const almacen = require('../shared/almacen-docs');

// ─── Sin bucket: todo sigue en la base ────────────────────────────────────────

test('sin GCS_BUCKET el almacén se declara inactivo y explica por qué', () => {
  assert.strictEqual(almacen.activo(), false);
  assert.strictEqual(almacen.estado().activo, false);
  assert.match(almacen.estado().motivo, /GCS_BUCKET/);
});

test('sin bucket, colocar() devuelve el blob para guardarlo en la base', async () => {
  const buffer = Buffer.from('un PDF de mentira');
  const d = await almacen.colocar({ ambito: 'fundantes', clave: 42, buffer, mime: 'application/pdf', nombre: 'carnet.pdf' });
  assert.strictEqual(d.storage, 'db');
  assert.strictEqual(d.ruta, null);
  assert.ok(Buffer.isBuffer(d.blob));
  assert.strictEqual(d.bytes, buffer.length);
});

test('obtener() devuelve el blob de la base tal cual', async () => {
  const buf = await almacen.obtener({ ruta: null, blob: Buffer.from('hola') });
  assert.strictEqual(buf.toString(), 'hola');
});

test('un documento sin ruta ni blob devuelve null, no revienta', async () => {
  assert.strictEqual(await almacen.obtener({ ruta: null, blob: null }), null);
});

/* Durante la migración el documento existe en los dos lados. Que gane el blob
   es lo que hace que el orden de los pasos no importe: se pueden marcar filas
   como migradas aunque el servidor todavía no tenga credenciales del bucket. */
test('mientras el blob siga en la fila, se lee de la base aunque haya ruta', async () => {
  const buf = await almacen.obtener({ ruta: 'fundantes/42/x.pdf', blob: Buffer.from('el de la base') });
  assert.strictEqual(buf.toString(), 'el de la base');
});

/* Este es el caso que importa en contingencia: la fila dice que el archivo está
   en el bucket, pero este servidor no lo alcanza. Tiene que decirlo con todas
   sus letras, no devolver un archivo vacío que el usuario creerá corrupto. */
test('si la fila apunta al bucket y no hay bucket, el error lo explica', async () => {
  await assert.rejects(
    () => almacen.obtener({ ruta: 'fundantes/42/x.pdf', blob: null }),
    /no tiene acceso/
  );
});

test('colocar() exige un Buffer — un string sería un archivo corrupto silencioso', async () => {
  await assert.rejects(
    () => almacen.colocar({ ambito: 'x', clave: 1, buffer: 'no soy un buffer', nombre: 'a.pdf' }),
    /Buffer/
  );
});

// ─── Nombres de archivo: vienen de un usuario, no se confían ──────────────────

test('el nombre del archivo no puede inventar carpetas dentro del bucket', () => {
  const ruta = almacen.rutaDe({ ambito: 'fundantes', clave: 42, nombre: '../../secreto.pdf' });
  const partes = ruta.split('/');
  assert.strictEqual(partes.length, 3, 'ámbito / clave / archivo — ni una barra más');
  assert.ok(!partes[2].includes('..' + '/'));
});

test('el ámbito y la clave tampoco pueden inyectar barras', () => {
  const ruta = almacen.rutaDe({ ambito: 'a/b', clave: 'c/d', nombre: 'x.pdf' });
  assert.strictEqual(ruta.split('/').length, 3);
});

test('los acentos se van, la extensión se queda', () => {
  assert.strictEqual(almacen.limpiar('Cédula de Identidad.pdf'), 'Cedula-de-Identidad.pdf');
});

test('un nombre que queda vacío al limpiarlo no produce una ruta rota', () => {
  assert.strictEqual(almacen.limpiar('###'), 'archivo');
  assert.ok(almacen.rutaDe({ ambito: '###', clave: '###', nombre: '###' }).split('/').every(Boolean));
});

test('dos subidas del mismo nombre no comparten ruta — el sello las separa', () => {
  const a = almacen.rutaDe({ ambito: 'f', clave: 1, nombre: 'x.pdf', sello: '20260101000000' });
  const b = almacen.rutaDe({ ambito: 'f', clave: 1, nombre: 'x.pdf', sello: '20260102000000' });
  assert.notStrictEqual(a, b);
});

test('borrar() sin bucket no lanza — el controlador no tiene que envolverlo', async () => {
  assert.strictEqual(await almacen.borrar('f/1/x.pdf'), false);
  assert.strictEqual(await almacen.borrar(null), false);
});

// ─── Esquema ──────────────────────────────────────────────────────────────────

test('sqlColumnas() entrega las tres columnas que toda tabla de documentos necesita', () => {
  const sql = almacen.sqlColumnas('fundantes_seg_docs').join(' ');
  assert.match(sql, /doc_storage/);
  assert.match(sql, /doc_ruta/);
  assert.match(sql, /doc_bytes/);
  assert.ok(!/DROP|DELETE/i.test(sql));
});
