'use strict';
/* ───────────────────────────────────────────────────────────────────────────
   Probar la clave del certificado digital del SII — en tu máquina, sin subir
   nada a ninguna parte.

   Existe porque SimpleAPI responde "The specified network password is not
   correct" tanto si la clave del .pfx está mala como si el base64 llegó
   cortado, y probar a ciegas en Render gasta cuota (plan gratuito: 30
   consultas al mes) y obliga a esperar un redeploy por intento.

   Uso:
     node scripts/probar-certificado-sii.js  ruta\\al\\certificado.pfx

   Pide la clave sin mostrarla, intenta abrir el certificado y te dice si es
   la correcta. Si lo abre, ofrece dejar el base64 listo para pegar en Render.
   La clave NUNCA se imprime, ni se guarda, ni viaja a ningún lado.
   ─────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const readline = require('readline');

const archivo = process.argv[2];
if (!archivo) {
  console.error('\nFalta la ruta del certificado.\n  node scripts/probar-certificado-sii.js  C:\\\\ruta\\\\certificado.pfx\n');
  process.exit(1);
}
if (!fs.existsSync(archivo)) { console.error(`\nNo encontré el archivo:\n  ${archivo}\n`); process.exit(1); }

const buf = fs.readFileSync(archivo);
const esPfx = buf.length > 300 && buf[0] === 0x30 && buf[1] === 0x82;

console.log(`\nArchivo   : ${path.basename(archivo)}`);
console.log(`Tamaño    : ${buf.length.toLocaleString('es-CL')} bytes`);
console.log(`¿Es .pfx? : ${esPfx ? 'sí, formato PKCS#12 válido' : 'NO — no parece un certificado .pfx'}`);
if (!esPfx) { console.error('\nRevisa que sea el archivo correcto (.pfx o .p12).\n'); process.exit(1); }

/* Lee la clave sin mostrarla en pantalla. */
function pedirClave(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let mudo = false;
    rl._writeToOutput = s => { if (!mudo) rl.output.write(s); };   // silencia lo tecleado
    rl.output.write(prompt);
    mudo = true;
    rl.question('', val => { mudo = false; rl.output.write(String.fromCharCode(10)); rl.close(); resolve(val); });
  });
}

(async () => {
  const clave = await pedirClave('Clave del certificado (no se muestra): ');
  let abre = false, motivo = '';
  try { tls.createSecureContext({ pfx: buf, passphrase: clave }); abre = true; }
  catch (e) { motivo = /mac verify|password|decrypt/i.test(e.message || '') ? 'clave incorrecta' : e.message; }

  if (!abre) {
    console.log(`\n❌ La clave NO abre este certificado (${motivo}).`);
    console.log('   Ojo: la clave del certificado NO es la Clave Tributaria del SII.');
    console.log('   Es la que te pidieron al descargarlo o exportarlo desde la entidad certificadora.\n');
    process.exit(2);
  }

  console.log('\n✅ La clave es correcta: el certificado se abre.\n');
  console.log('   En Render (servicio credit-system-1 → Environment):');
  console.log('     SII_CERT_PASS  = esta clave');
  console.log('     SII_CERT_B64   = el base64 del archivo, en UNA sola línea\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('¿Genero el archivo con el base64 listo para pegar? (s/n): ', r => {
    rl.close();
    if (!/^s/i.test(r.trim())) { console.log('\nListo.\n'); process.exit(0); }
    const salida = path.join(path.dirname(archivo), 'cert-base64.txt');
    fs.writeFileSync(salida, buf.toString('base64'), 'utf8');       // sin saltos de línea
    const escrito = fs.readFileSync(salida, 'utf8');
    console.log(`\nEscrito: ${salida}`);
    console.log(`Largo  : ${escrito.length.toLocaleString('es-CL')} caracteres, en una sola línea (${/\s/.test(escrito) ? '⚠ TIENE espacios' : 'sin espacios ni saltos'})`);
    console.log('\nCópialo COMPLETO en SII_CERT_B64. Al pegarlo en Render, verifica que');
    console.log('el campo no lo corte: debe quedar del mismo largo.\n');
    console.log('⚠ Borra ese archivo cuando termines — contiene tu certificado.\n');
    process.exit(0);
  });
})();
