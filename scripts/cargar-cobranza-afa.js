'use strict';
/* Etapa 3 CARTERA AFA — base de cobranza INDEXA: completa VEHÍCULO en creditos
   (tipo_vehiculo + anio; marca/modelo ya venían de la Etapa 1) y CONTACTO en
   clientes SOLO donde esté vacío (email / teléfono / dirección) — clientes es la
   fuente única, no se pisa nada existente. Solo las 216 ops AFA; sin ops nuevas.
   Uso: node scripts/cargar-cobranza-afa.js [--aplicar]   (sin flag = simulación) */

const XLSX = require('xlsx');
const pool = require('../shared/config/database');

const ARCHIVO = 'C:/Users/patri/OneDrive/Documentos/01 AUTOFACIL/02 SOFTWARE PROPIO/01 CORE AUTOFACIL/base cobranza indexa 20260707.xlsx';
const APLICAR = process.argv.includes('--aplicar');
// Export crudo INDEXA: 34 columnas por posición (mismo mapa que migracion-indexa)
const I = { op: 1, mail: 3, direccion: 4, comuna: 6, telPar: 9, telCel: 10, marca: 27, modelo: 28, anio: 29, tipo: 30, nuevo: 31 };

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (usa --aplicar para escribir) ===');
  const wb = XLSX.readFile(ARCHIVO);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1);
  const byOp = new Map();
  for (const r of aoa) {
    if (r[I.op] == null || byOp.has(r[I.op])) continue;   // 1 fila por crédito basta
    const g = i => String(r[i] == null ? '' : r[i]).trim() || null;
    byOp.set(r[I.op], {
      mail: g(I.mail), direccion: g(I.direccion), comuna: g(I.comuna),
      telefono: g(I.telCel) || g(I.telPar),
      marca: g(I.marca), modelo: g(I.modelo), anio: +r[I.anio] || null,
      tipo: g(I.tipo), nuevo: g(I.nuevo),
    });
  }

  const [creds] = await pool.query(
    `SELECT c.id, c.num_op, c.id_cliente, c.marca, c.modelo, c.anio, c.tipo_vehiculo,
            cl.email, cl.telefono_movil, cl.telefono, cl.direccion
     FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
     WHERE c.origen='CARTERA_AFA'`);

  let sinBase = 0, vehUpd = 0, mailUpd = 0, telUpd = 0, dirUpd = 0;
  const clienteHecho = new Set();   // un mismo cliente puede tener varias ops

  for (const c of creds) {
    const d = byOp.get(c.num_op);
    if (!d) { sinBase++; console.log(`  ⚠ OP ${c.num_op} no está en la base`); continue; }

    // Vehículo → creditos (COALESCE: no pisa lo ya cargado)
    if (d.tipo || d.anio || d.marca) {
      if (APLICAR) await pool.query(
        `UPDATE creditos SET
           marca         = COALESCE(NULLIF(marca,''), ?),
           modelo        = COALESCE(NULLIF(modelo,''), ?),
           anio          = COALESCE(anio, ?),
           anio_vehiculo = COALESCE(anio_vehiculo, ?),
           tipo_vehiculo = COALESCE(NULLIF(tipo_vehiculo,''), ?)
         WHERE id=?`, [d.marca, d.modelo, d.anio, d.anio, d.tipo, c.id]);
      vehUpd++;
    }

    // Contacto → clientes, SOLO campos vacíos
    if (c.id_cliente && !clienteHecho.has(c.id_cliente)) {
      clienteHecho.add(c.id_cliente);
      const sets = [], vals = [];
      if (d.mail && !c.email)                          { sets.push('email=?'); vals.push(d.mail); mailUpd++; }
      if (d.telefono && !c.telefono_movil && !c.telefono) { sets.push('telefono_movil=?'); vals.push(d.telefono); telUpd++; }
      if (d.direccion && !c.direccion)                 { sets.push('direccion=?'); vals.push(d.direccion); dirUpd++; }
      if (sets.length && APLICAR)
        await pool.query(`UPDATE clientes SET ${sets.join(', ')} WHERE id_cliente=?`, [...vals, c.id_cliente]);
    }
  }

  console.log(`\nOps: ${creds.length} | sin base: ${sinBase}`);
  console.log(`Vehículo ${APLICAR ? 'actualizado' : 'a actualizar'}: ${vehUpd} créditos (tipo/año, marca-modelo solo si faltaban)`);
  console.log(`Clientes — email nuevos: ${mailUpd} | teléfonos nuevos: ${telUpd} | direcciones nuevas: ${dirUpd} (solo vacíos)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
