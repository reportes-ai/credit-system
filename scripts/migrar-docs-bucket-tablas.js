'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   LAS TABLAS DE DOCUMENTOS, EN UN SOLO LUGAR

   Cada tabla con el nombre REAL de sus columnas — varían tabla a tabla y no
   todas usan `id` como llave primaria (credito_documentos usa id_doc).

   Vive aparte porque la usan DOS scripts: el que sube al bucket y el que suelta
   los blobs. Una segunda copia de esta lista es exactamente cómo se termina
   soltando el blob de una tabla que nunca se subió.

   Agregar una tabla nueva es agregar una línea acá; no se escribe código por tabla.
   ───────────────────────────────────────────────────────────────────────────── */

const TABLAS = {
  fundantes:   { tabla: 'fundantes_seg_docs',    blob: 'archivo_data', nombre: 'archivo_nombre', mime: 'mime_type',  clave: 'id_credito',  ambito: 'fundantes' },
  cartas:      { tabla: 'cartas_documentos',     blob: 'data',         nombre: 'nombre',         mime: 'mime',       clave: 'id_carta',    ambito: 'cartas' },
  dealerficha: { tabla: 'dealer_fichas',         blob: 'ficha_data',   nombre: 'ficha_nombre',   mime: 'ficha_mime', clave: 'id',          ambito: 'dealers-ficha' },
  dealerarch:  { tabla: 'dealer_ficha_archivos', blob: 'data',         nombre: 'nombre',         mime: 'mime',       clave: 'id_ficha',    ambito: 'dealers-archivos' },
  credito:     { tabla: 'credito_documentos',    blob: 'archivo_data', nombre: 'archivo_nombre', mime: 'mime_type',  clave: 'id_credito',  ambito: 'creditos', pk: 'id_doc' },
  evaluacion:  { tabla: 'evaluacion_documentos', blob: 'archivo_data', nombre: 'archivo_nombre', mime: 'mime_type',  clave: 'rut_cliente', ambito: 'evaluacion' },
  dealernet:   { tabla: 'informes_dealernet',    blob: 'pdf_data',     nombre: 'pdf_filename',   mime: null,         clave: 'rut',         ambito: 'dealernet' },
  /* Estas todavía no tenían ni un archivo cuando se hizo la migración, pero
     están cableadas para que el primero que suban ya vaya al bucket. */
  fundbrok:    { tabla: 'fundantes_brokerage',        blob: 'archivo_data', nombre: 'archivo_nombre', mime: 'mime_type', clave: 'id_credito', ambito: 'fundantes-brokerage' },
  facbrok:     { tabla: 'facturas_brokerage',         blob: 'archivo_data', nombre: 'archivo_nombre', mime: 'mime_type', clave: 'id_credito', ambito: 'brokerage-facturas' },
  rrhh:        { tabla: 'rh_documentos',              blob: 'archivo_data', nombre: 'nombre_archivo', mime: 'mime_type', clave: 'id_usuario', ambito: 'rrhh-documentos' },
  liquidez:    { tabla: 'dealer_liquidez_documentos', blob: 'data',         nombre: 'nombre',         mime: 'mime',      clave: 'id_plan',    ambito: 'liquidez' },
  atencion:    { tabla: 'ar_adjuntos',                blob: 'data',         nombre: 'nombre',         mime: 'mime',      clave: 'id_conversacion', ambito: 'atencion-remota' },
};

module.exports = { TABLAS };
