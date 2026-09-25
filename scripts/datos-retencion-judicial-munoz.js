'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DATOS DE LA RETENCIÓN JUDICIAL DE JUAN MUÑOZ (causa de alimentos).

   Los toma de la resolución del 2° Juzgado de Familia de Santiago que ordena a
   AutoFácil retener 6,06265 UTM y DEPOSITARLAS directamente a la alimentaria
   dentro de los primeros cinco días de cada mes, comunicando cada pago al
   tribunal. Con estos datos cargados, la orden de pago se emite sola al emitir
   las liquidaciones del mes.

   El RIT NO se carga acá a propósito: el PDF viene escaneado y el OCR no deja
   leer con certeza uno de sus dígitos. Es la referencia con que el tribunal
   ubica la causa, así que lo digita quien tiene el documento a la vista, en
   Descuentos de Remuneración → Editar.

   Uso:  node scripts/datos-retencion-judicial-munoz.js           (simulación)
         node scripts/datos-retencion-judicial-munoz.js --apply   (aplica)
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const APLICAR = process.argv.includes('--apply');

const RUT_TRABAJADOR = '12152111';            // Juan Nazario Muñoz Núñez
const DATOS = {
  jud_tribunal: '2° Juzgado de Familia de Santiago',
  jud_tribunal_email: 'jfsantiago2@pjud.cl',
  ben_nombre: 'JOANNE DEL CARMEN GÓMEZ YÁÑEZ',
  ben_rut: '11.375.648-9',
  ben_banco: 'Banco Estado',
  ben_tipo_cuenta: 'Cuenta de ahorro a la vista',
  ben_numero_cuenta: '28660397150',
};

(async () => {
  const [filas] = await pool.query(
    `SELECT d.id, d.subtipo, d.detalle_texto, d.moneda, d.monto_origen, d.valor_cuota, d.jud_rit, d.ben_nombre,
            TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) trabajador
       FROM rh_descuentos d JOIN usuarios u ON u.id_usuario=d.id_usuario
      WHERE d.estado='VIGENTE' AND d.tipo='PERMANENTE'
        AND REPLACE(REPLACE(UPPER(COALESCE(u.rut,'')),'.',''),'-','') LIKE CONCAT(?, '%')
        AND UPPER(COALESCE(d.subtipo,'')) LIKE '%ALIMENTO%'`, [RUT_TRABAJADOR]);

  if (!filas.length) { console.error('✗ No hay un descuento vigente de pensión de alimentos para ese RUT. Revisa Descuentos de Remuneración.'); process.exit(1); }
  if (filas.length > 1) { console.error(`✗ Hay ${filas.length} descuentos que calzan: no se toca ninguno. Revísalos a mano.`); process.exit(1); }

  const d = filas[0];
  console.log(`Descuento #${d.id} — ${d.trabajador} · ${d.subtipo} · ${d.moneda === 'CLP' ? '$' + Math.round(d.valor_cuota).toLocaleString('es-CL') : d.moneda + ' ' + d.monto_origen}`);
  for (const [k, v] of Object.entries(DATOS)) console.log(`  ${k}: ${JSON.stringify(d[k] || null)} → ${JSON.stringify(v)}`);
  console.log(`  jud_rit: ${JSON.stringify(d.jud_rit || null)} → se digita a mano (el PDF escaneado no deja leerlo con certeza)`);

  if (!APLICAR) { console.log('\nSimulación. Corre con --apply para aplicar.'); process.exit(process.exitCode || 0); }

  // Respaldo ANTES de tocar la base
  const archivo = path.join(__dirname, `respaldo-retencion-judicial-${Date.now()}.json`);
  fs.writeFileSync(archivo, JSON.stringify(d, null, 2), 'utf8');
  console.log(`\nRespaldo en ${archivo}`);

  const cols = Object.keys(DATOS);
  const [u] = await pool.query(`UPDATE rh_descuentos SET ${cols.map(c => c + '=?').join(', ')} WHERE id=?`, [...cols.map(c => DATOS[c]), d.id]);
  if (!u.affectedRows) { console.error('✗ El UPDATE no afectó filas'); process.exit(1); }

  // El beneficiario tiene que existir como proveedor para que la ODP sepa a quién transferir
  const rem = require('../services/rrhh/src/controllers/remuneraciones.controller');
  const [[fresco]] = await pool.query('SELECT * FROM rh_descuentos WHERE id=?', [d.id]);
  const prov = await rem.proveedorBeneficiario(fresco, 'Carga de la resolución judicial');
  console.log(`\n✓ Datos cargados. Proveedor beneficiario: ${prov ? (prov.creado ? 'creado' : 'actualizado') + ' (id ' + prov.id + ')' : 'no se pudo crear'}`);
  console.log('Falta solo el RIT: Descuentos de Remuneración → Editar.');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
