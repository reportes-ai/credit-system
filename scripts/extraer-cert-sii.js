'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   RECONSTRUIR EL CERTIFICADO DIGITAL DEL SII DESDE `SII_CERT_B64`

   En Render el certificado vive convertido a texto (base64) dentro de una
   variable de entorno. Eso sirve para que el servidor lo use, pero **no es un
   respaldo**: si mañana no está Render, ese texto no está en ninguna parte.

   Este script lo devuelve a su forma de archivo (`.pfx`) para guardarlo en un
   pendrive, en la caja fuerte. Es el único activo del sistema que no se puede
   reemitir gratis: se compra a un proveedor autorizado, tiene vigencia y su
   reposición toma días.

   USO
     1) En Render → Environment, copiá el valor de SII_CERT_B64 a un archivo:
        C:\\Users\\patri\\Downloads\\sii-cert-b64.txt
     2) node scripts/extraer-cert-sii.js
     3) Copiá el .pfx al pendrive y BORRÁ los dos archivos de Descargas.

   LA CLAVE DEL CERTIFICADO (`SII_CERT_PASS`) NO VA EN EL PENDRIVE: va al gestor
   de contraseñas. Archivo y clave separados — juntos, perder el pendrive es
   perder el certificado.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const ENTRADA = process.argv[2] || 'C:\\Users\\patri\\Downloads\\sii-cert-b64.txt';
const SALIDA = process.argv[3] || 'C:\\Users\\patri\\Downloads\\certificado-sii.pfx';

let b64;
try { b64 = fs.readFileSync(ENTRADA, 'utf8'); }
catch { console.error(`\n✗ No encontré ${ENTRADA}\n  Pegá ahí el valor de SII_CERT_B64 (Render → Environment).\n`); process.exit(1); }

/* Tolerante con el copiar/pegar: Render muestra el valor con saltos de línea y
   a veces se arrastran comillas o espacios. */
b64 = b64.replace(/\s+/g, '').replace(/^["']|["']$/g, '');
if (!b64) { console.error('\n✗ El archivo está vacío.\n'); process.exit(1); }

const buf = Buffer.from(b64, 'base64');

/* Un .pfx es DER: siempre empieza con 0x30 0x82 (SEQUENCE, longitud larga). Si
   no calza, lo que se pegó no es el certificado —o se copió a medias— y
   guardarlo daría una falsa sensación de respaldo, que es lo peor que puede
   pasar acá: te enterarías el día que lo necesitás. */
if (buf.length < 500 || buf[0] !== 0x30 || buf[1] !== 0x82) {
  console.error(`\n✗ Esto no parece un certificado PKCS#12 (${buf.length} bytes).`);
  console.error('  Revisá que hayas copiado el valor COMPLETO de SII_CERT_B64.\n');
  process.exit(1);
}

fs.writeFileSync(SALIDA, buf);
console.log(`\n  ✓ ${path.basename(SALIDA)} — ${(buf.length / 1024).toFixed(1)} KB`);
console.log(`     ${SALIDA}\n`);
console.log('  AHORA:');
console.log('   1. Copiá el .pfx a un pendrive y guardalo en la caja fuerte.');
console.log('   2. SII_CERT_PASS va al gestor de contraseñas, NO al pendrive.');
console.log(`   3. Borrá ${ENTRADA} y el .pfx de Descargas.\n`);
