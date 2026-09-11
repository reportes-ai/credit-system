'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   TEF MASIVA BANCO INTERNACIONAL — motor único (Pato, 11-09-2026).

   Genera el archivo de "Transferencias Masivas – Internet Banking" del Banco
   Internacional (estructura mayo 2023, docs/referencias/Estructura TEF Masiva_VF.pdf)
   para los tres lugares donde AutoFácil paga:
     · Saldos Precios a Pagar      (plataforma SALDOS)
     · Comisiones a Pagar (dealers) (plataforma COMISIONES)
     · Comisiones Parques a Pagar   (plataforma PARQUES)

   Columnas (hoja "Nomina", encabezados tal cual la plantilla del banco):
     rut_destinatario (15, sin puntos ni guión, con DV) · nombre_destinatario (45, sin
     caracteres especiales) · cuenta_destinatario (19, numérico) · monto (entero,
     máximo tef_monto_max por transferencia) · tipo_cuenta (1 corriente, 2 vista,
     3 ahorro) · codigo_banco (anexo 2 del banco = código SBIF del catálogo
     rh_catalogo BANCO, fuente única) · correo_destinatario (45, optativo) ·
     motivo (30, obligatorio).

   CUPO: el banco no cobra hasta tef_gratis_mes (150) cargos al mes. Cada archivo
   generado se registra en tef_envios (plataforma, mes, cargos, monto, usuario) y
   cupoMes() suma las TRES plataformas; las páginas muestran "te quedan N/150 gratis".
   Parámetros en postventa_config: tef_gratis_mes, tef_monto_max.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');
const XLSX = require('xlsx');

require('./migrate').enFila('tef-internacional', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS tef_envios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plataforma VARCHAR(20) NOT NULL,
    mes CHAR(7) NOT NULL,
    cargos INT NOT NULL,
    monto_total DECIMAL(14,0) NOT NULL DEFAULT 0,
    excluidas INT NOT NULL DEFAULT 0,
    id_usuario INT NULL,
    usuario VARCHAR(160) NULL,
    detalle_json MEDIUMTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_mes (mes)
  )`);
  await pool.query("INSERT IGNORE INTO postventa_config (clave, valor) VALUES ('tef_gratis_mes', '150'), ('tef_monto_max', '7000000'), ('tef_dividir', '1')").catch(() => {});
});

const R = v => Math.round(Number(v) || 0);
const mesChile = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }).slice(0, 7);

async function parametros() {
  const out = { gratis: 150, montoMax: 7000000, dividir: true };
  try {
    const [rows] = await pool.query("SELECT clave, valor FROM postventa_config WHERE clave IN ('tef_gratis_mes','tef_monto_max','tef_dividir')");
    for (const r of rows) {
      let v = r.valor; try { v = JSON.parse(v); } catch (_) {}
      if (r.clave === 'tef_gratis_mes' && Number(v) > 0) out.gratis = Number(v);
      if (r.clave === 'tef_monto_max' && Number(v) > 0) out.montoMax = Number(v);
      if (r.clave === 'tef_dividir') out.dividir = Number(v) === 1;
    }
  } catch (_) {}
  return out;
}

/* ── Normalizaciones según la estructura del banco ── */
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const alfanum = (s, largo) => sinAcentos(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, largo);
const glosa = (s, largo) => sinAcentos(s).replace(/[^A-Za-z0-9 .\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, largo);
/* Glosa de una parte: "<motivo> Transf. k/n" (Pato, 11-09-2026). Si no cabe en los 30 del banco se
   abrevia el motivo ("saldo precio" → "SP", "comision" → "com") y, si aún no cabe, se corta. */
function glosaParte(motivo, k, n) {
  const suf = ` Transf. ${k}/${n}`;
  let m = glosa(motivo, 30);
  if ((m + suf).length > 30) m = m.replace(/saldo precio/i, 'SP').replace(/comision/i, 'com').replace(/parque/i, 'pq');
  if ((m + suf).length > 30) m = m.replace(/^Pago /i, '');   // antes de cortar el número, sacrificar el "Pago"
  return glosa(m.slice(0, 30 - suf.length) + suf, 30);
}
const rutBanco = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase().slice(0, 15);   // con DV, sin puntos ni guión
const cuentaBanco = c => String(c || '').replace(/\D/g, '').slice(0, 19);

function tipoCuenta(t) {
  const s = sinAcentos(t).toLowerCase();
  if (/vista|rut/.test(s)) return 2;
  if (/ahorro/.test(s)) return 3;
  return 1;   // corriente (o sin dato: es lo habitual en empresas)
}

/* Código de banco: catálogo rh_catalogo BANCO (código SBIF, fuente única) + alias de los
   nombres que llegan de las fichas de dealers y parques ("BANCO DE CREDITO E INVERSIONES",
   "Banco de chile", "ITAU", "ESTADO"…). Devuelve null si no se reconoce. */
let _cat = null, _catExp = 0;
async function catalogoBancos() {
  if (_cat && _catExp > Date.now()) return _cat;
  const [rows] = await pool.query("SELECT codigo, nombre FROM rh_catalogo WHERE tipo='BANCO'");
  _cat = rows.map(r => ({ codigo: parseInt(r.codigo, 10), clave: sinAcentos(r.nombre).toUpperCase().replace(/^BANCO\s+/, '').trim() }));
  _catExp = Date.now() + 5 * 60 * 1000;
  return _cat;
}
const ALIAS = [
  [/CREDITO E INVERSIONES|\bBCI\b/, 'BCI'], [/EDWARDS|CITI|\bCHILE\b/, 'BANCO DE CHILE'], [/ITAU|CORPBANCA/, 'ITAU'],
  [/\bESTADO\b/, 'BANCO ESTADO'], [/SANTANDER/, 'SANTANDER'], [/SCOTIA/, 'SCOTIABANK'], [/FALABELLA/, 'FALABELLA'],
  [/SECURITY/, 'SECURITY'], [/BICE/, 'BICE'], [/CONSORCIO/, 'CONSORCIO'], [/RIPLEY/, 'RIPLEY'], [/COOPEUCH/, 'COOPEUCH'],
  [/INTERNACIONAL/, 'INTERNACIONAL'], [/MERCADO ?PAGO/, 'MERCADO PAGO'], [/TENPO/, 'TENPO'], [/HSBC/, 'HSBC'],
];
async function codigoBanco(nombre) {
  const s = sinAcentos(nombre).toUpperCase();
  if (!s.trim()) return null;
  const cat = await catalogoBancos();
  let clave = null;
  for (const [re, k] of ALIAS) if (re.test(s)) { clave = k; break; }
  const buscar = sinAcentos(clave || s).toUpperCase().replace(/^BANCO\s+/, '').trim();
  const hit = cat.find(c => c.clave === buscar) || cat.find(c => buscar.includes(c.clave) || c.clave.includes(buscar));
  return hit ? hit.codigo : null;
}

/* ── Construcción del archivo ──
   filas: [{ rut, nombre, banco, tipo_cuenta, num_cuenta, correo, monto, motivo, ref }]
   Devuelve { buffer, nombre_archivo, cargos, monto_total, excluidas:[{ref, motivo}], cupo } */
async function construirTEF({ plataforma, filas, usuario }) {
  const P = await parametros();
  const ok = [], excluidas = [], divididas = [];
  for (const f of filas || []) {
    const ref = f.ref || f.motivo || '';
    const rut = rutBanco(f.rut), cuenta = cuentaBanco(f.num_cuenta), monto = R(f.monto);
    const banco = await codigoBanco(f.banco);
    const nombre = alfanum(f.nombre, 45), motivo = glosa(f.motivo, 30);
    const porque = [];
    if (rut.length < 7) porque.push('sin RUT');
    if (!nombre) porque.push('sin nombre');
    if (!cuenta) porque.push('sin número de cuenta');
    if (!banco) porque.push('banco no reconocido' + (f.banco ? ` (${f.banco})` : ''));
    if (monto <= 0) porque.push('monto en cero');
    if (monto > P.montoMax && !P.dividir) porque.push(`monto sobre el máximo del banco ($${P.montoMax.toLocaleString('es-CL')} por transferencia)`);
    if (!motivo) porque.push('sin motivo');
    if (porque.length) { excluidas.push({ ref, nombre: f.nombre || '', monto, motivo: porque.join(', ') }); continue; }
    const correo = alfanum(f.correo, 45).toLowerCase().replace(/ /g, '') || '';
    /* Monto sobre el máximo del banco: se DIVIDE en transferencias a la misma cuenta, cada una por
       el MÁXIMO y la última por la diferencia (Pato, 11-09-2026); glosa "<motivo> Transf. k/n".
       Cada parte es un cargo para el cupo del mes. */
    const partes = monto > P.montoMax ? Math.ceil(monto / P.montoMax) : 1;
    let resto = monto;
    for (let k = 1; k <= partes; k++) {
      const m = k === partes ? resto : P.montoMax;
      resto -= m;
      ok.push([rut, nombre, cuenta, m, tipoCuenta(f.tipo_cuenta), banco, correo, partes > 1 ? glosaParte(motivo, k, partes) : motivo]);
    }
    if (partes > 1) divididas.push({ ref, nombre: f.nombre || '', monto, partes });
  }
  const header = ['rut_destinatario', 'nombre_destinatario', 'cuenta_destinatario', 'monto', 'tipo_cuenta', 'codigo_banco', 'correo_destinatario', 'motivo'];
  const ws = XLSX.utils.aoa_to_sheet([header, ...ok]);
  // RUT y cuenta como texto (una cuenta larga no debe volverse notación científica); monto/tipo/banco numéricos
  for (let i = 0; i < ok.length; i++) {
    const r = i + 2;
    for (const col of ['A', 'C']) { const c = ws[col + r]; if (c) { c.t = 's'; c.v = String(c.v); } }
  }
  ws['!cols'] = [{ wch: 14 }, { wch: 40 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 32 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Nomina');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const monto_total = ok.reduce((a, r) => a + r[3], 0);
  const mes = mesChile();
  if (ok.length) {
    await pool.query('INSERT INTO tef_envios (plataforma, mes, cargos, monto_total, excluidas, id_usuario, usuario, detalle_json) VALUES (?,?,?,?,?,?,?,?)',
      [plataforma, mes, ok.length, monto_total, excluidas.length, usuario?.id_usuario || null, usuario?.nombre || null,
       JSON.stringify(ok.map(r => ({ rut: r[0], nombre: r[1], monto: r[3], motivo: r[7] })))]);
  }
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  return { buffer, nombre_archivo: `TEF-BInternacional-${plataforma.toLowerCase()}-${hoy}.xlsx`, cargos: ok.length, monto_total, excluidas, divididas, cupo: await cupoMes() };
}

/* Cupo del mes: cargos ya enviados en las tres plataformas vs el tope gratis. */
async function cupoMes(mes) {
  const P = await parametros();
  const m = mes || mesChile();
  const [rows] = await pool.query('SELECT plataforma, SUM(cargos) n FROM tef_envios WHERE mes=? GROUP BY plataforma', [m]);
  const por = {}; let usados = 0;
  for (const r of rows) { por[r.plataforma] = Number(r.n); usados += Number(r.n); }
  return { mes: m, usados, gratis: P.gratis, restantes: Math.max(0, P.gratis - usados), por_plataforma: por, monto_max: P.montoMax };
}

module.exports = { construirTEF, cupoMes, codigoBanco, tipoCuenta, parametros };
