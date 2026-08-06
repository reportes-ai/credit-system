'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   IMPORTAR LIBRO DIARIO AVSOFT → ctb_comprobantes + ctb_movimientos

   Uso:  node scripts/importar-diario-avsoft.js <ruta.csv> [--aplicar]
         (sin --aplicar solo simula y muestra qué haría)

   CSV export de AVSOFT (latin-1, separado por ;):
   Fecha;Nro;Tipo(E/I/T);Descrip.Tipo;Glosa Comprobante;Cuenta;Nombre Cuenta;RUT;
   Nombre;TipoDoc;NroDoc;F.Emision;F.Venc;Glosa;Otros;Monto Debe;Monto Haber

   Idempotente: la llave es origen_ref = "<T>-<nro> <mes>-<año>" (igual que la
   importación original). Un comprobante que ya existe NO se toca — por eso se
   puede re-cargar el mismo export o uno que traslape sin duplicar nada.
   Valida debe=haber por comprobante antes de insertar.
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs');
const pool = require('../shared/config/database');

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function parseCSV(ruta) {
  const txt = fs.readFileSync(ruta, 'latin1');
  const lineas = txt.split(/\r?\n/).filter(l => l.trim());
  const filas = lineas.slice(1).map(l => l.split(';'));
  const monto = v => { const n = parseFloat(String(v || '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
  const fechaISO = v => { const m = String(v || '').match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

  const comps = new Map();          // origen_ref → comprobante
  for (const f of filas) {
    const fecha = fechaISO(f[0]);
    if (!fecha || !f[1] || !f[2]) continue;
    const [anio, mes] = [Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7))];
    const ref = `${f[2]}-${Number(f[1])} ${MES[mes - 1]}-${anio}`;
    if (!comps.has(ref)) comps.set(ref, {
      ref, tipo: (f[3] || '').trim() || 'TRASPASO', anio, numero: Number(f[1]),
      fecha, glosa: (f[4] || '').trim().slice(0, 300), lineas: [],
    });
    const c = comps.get(ref);
    c.lineas.push({
      cuenta: (f[5] || '').trim(),
      glosa: ((f[13] || f[4]) || '').trim().slice(0, 300),
      rut: (f[7] || '').trim().replace(/[^\dkK-]/g, '') || null,
      debe: monto(f[15]), haber: monto(f[16]),
    });
  }
  return [...comps.values()];
}

(async () => {
  const ruta = process.argv[2];
  const aplicar = process.argv.includes('--aplicar');
  if (!ruta || !fs.existsSync(ruta)) { console.error('Uso: node scripts/importar-diario-avsoft.js <ruta.csv> [--aplicar]'); process.exit(1); }

  const comps = parseCSV(ruta);
  console.log(`CSV: ${comps.length} comprobantes, ${comps.reduce((s, c) => s + c.lineas.length, 0)} líneas`);

  // Descuadrados: se reportan y NO se importan
  const malos = comps.filter(c => Math.abs(c.lineas.reduce((s, l) => s + l.debe - l.haber, 0)) > 1);
  if (malos.length) { console.log(`⚠ ${malos.length} comprobantes DESCUADRADOS (no se importan):`); malos.forEach(c => console.log('  ', c.ref, c.glosa)); }
  const buenos = comps.filter(c => !malos.includes(c));

  // Idempotencia: qué refs ya existen
  const refs = buenos.map(c => c.ref);
  const existentes = new Set();
  for (let i = 0; i < refs.length; i += 500) {
    const [ex] = await pool.query("SELECT origen_ref FROM ctb_comprobantes WHERE origen='AVSOFT' AND origen_ref IN (?)", [refs.slice(i, i + 500)]);
    ex.forEach(r => existentes.add(r.origen_ref));
  }
  // Aperturas de año: el sistema arrastra los saldos desde el cierre de ejercicio
  // propio — importar la apertura de AVSOFT DUPLICARÍA todos los saldos de balance.
  const aperturas = buenos.filter(c => /APERTURA/i.test(c.glosa) && !existentes.has(c.ref));
  if (aperturas.length && !process.argv.includes('--con-apertura')) {
    aperturas.forEach(c => console.log(`⚠ Se OMITE ${c.ref} "${c.glosa}" (apertura de año: los saldos ya se arrastran del cierre propio; forzar con --con-apertura)`));
  }
  const omitirApertura = !process.argv.includes('--con-apertura');
  const nuevos = buenos.filter(c => !existentes.has(c.ref) && !(omitirApertura && /APERTURA/i.test(c.glosa)));
  console.log(`Ya existen: ${existentes.size} · Nuevos a importar: ${nuevos.length}`);
  const porMes = {};
  nuevos.forEach(c => { const k = c.fecha.slice(0, 7); porMes[k] = (porMes[k] || 0) + 1; });
  console.log('Por mes:', porMes);

  if (!aplicar) { console.log('\n(simulación — agrega --aplicar para importar)'); process.exit(0); }

  // Respetar meses cerrados de contabilidad
  const [cerrados] = await pool.query('SELECT mes FROM ctb_meses_cerrados').catch(() => [[]]);
  const setCerrados = new Set((cerrados || []).map(r => String(r.mes).slice(0, 7)));

  // El numero del comprobante es correlativo del sistema por (tipo, anio) — la
  // numeración mensual de AVSOFT va solo en origen_ref (así lo hizo la import original)
  const sig = {};
  async function siguienteNumero(tipo, anio) {
    const k = tipo + '|' + anio;
    if (!(k in sig)) {
      const [[m]] = await pool.query('SELECT COALESCE(MAX(numero),0) mx FROM ctb_comprobantes WHERE tipo=? AND anio=?', [tipo, anio]);
      sig[k] = m.mx;
    }
    return ++sig[k];
  }

  let insertados = 0, lineasIns = 0, saltadosCerrado = 0;
  // Orden cronológico para que el correlativo respete las fechas
  nuevos.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);
  for (const c of nuevos) {
    if (setCerrados.has(c.fecha.slice(0, 7))) { saltadosCerrado++; continue; }
    const total = c.lineas.reduce((s, l) => s + l.debe, 0);
    const numero = await siguienteNumero(c.tipo, c.anio);
    const [r] = await pool.query(
      `INSERT INTO ctb_comprobantes (tipo, anio, numero, fecha, glosa, estado, origen, origen_ref, total, creado_por)
       VALUES (?,?,?,?,?, 'VIGENTE', 'AVSOFT', ?, ?, 'importar-diario-avsoft')`,
      [c.tipo, c.anio, numero, c.fecha, c.glosa, c.ref, total]);
    for (const l of c.lineas) {
      await pool.query(
        'INSERT INTO ctb_movimientos (id_comprobante, cuenta, glosa, debe, haber, rut) VALUES (?,?,?,?,?,?)',
        [r.insertId, l.cuenta, l.glosa, l.debe, l.haber, l.rut]);
      lineasIns++;
    }
    insertados++;
  }
  console.log(`\n✔ Importados ${insertados} comprobantes (${lineasIns} líneas).` +
    (saltadosCerrado ? ` ${saltadosCerrado} saltados por mes contable cerrado.` : ''));
  process.exit(0);
})();
