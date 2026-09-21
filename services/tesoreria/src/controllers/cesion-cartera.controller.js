'use strict';
/* ───────────────────────────────────────────────────────────────────────────
 * VENTA DE CARTERA — Compradores y Contratos de Cesión (Pato, 21-09-2026).
 *  - cartera_compradores: razón social, RUT, giro, domicilio, representantes
 *    (JSON: nombre, nacionalidad, estado civil, profesión, cédula), personería,
 *    correo/atención para notificaciones. El nombre corto es el que se escribe
 *    como "Comprador" al vender (fuente única del comprador).
 *  - cartera_contratos_texto: texto del contrato de cesión SIN y CON
 *    responsabilidad, editable en la misma card, con marcadores {{...}} que el
 *    generador rellena. El cedente sale de Datos de la Empresa (fuente única).
 *  - GET /contrato: arma el contrato para las ventas de un comprador en una
 *    fecha (con o sin responsabilidad) + Anexo I con las operaciones.
 * ─────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { datosEmpresa } = require('../../../../shared/empresa');
const RUT = require('../../../../api-gateway/public/js/rut-core');

const ok = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || '';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CLP = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const TIPOS = ['SIN_RESP', 'CON_RESP'];

/* Marcadores disponibles en los textos (se documentan en la pantalla) */
const MARCADORES = [
  ['{{CIUDAD}}', 'Ciudad de la firma (Datos de la Empresa)'], ['{{FECHA_LARGA}}', 'Fecha de la venta en palabras'],
  ['{{CEDENTE_RAZON}}', 'Razón social del cedente'], ['{{CEDENTE_RUT}}', 'RUT del cedente'], ['{{CEDENTE_GIRO}}', 'Giro del cedente'],
  ['{{CEDENTE_REPRESENTANTE}}', 'Representante legal del cedente'], ['{{CEDENTE_RUT_REPRESENTANTE}}', 'Cédula del representante del cedente'],
  ['{{CEDENTE_DOMICILIO}}', 'Domicilio del cedente (dirección, comuna)'], ['{{CEDENTE_EMAIL}}', 'Correo de notificaciones del cedente'],
  ['{{COMPRADOR_RAZON}}', 'Razón social del comprador'], ['{{COMPRADOR_RUT}}', 'RUT del comprador'], ['{{COMPRADOR_GIRO}}', 'Giro del comprador'],
  ['{{COMPRADOR_REPRESENTANTES}}', 'Representantes del comprador en texto legal ("don X, chileno, casado, ingeniero, Cédula N° …, y don Y…")'],
  ['{{COMPRADOR_NOMBRES_REPRESENTANTES}}', 'Solo los nombres de los representantes ("X y Y")'],
  ['{{COMPRADOR_DOMICILIO}}', 'Domicilio del comprador'], ['{{COMPRADOR_PERSONERIA}}', 'Personería del comprador (escritura, fecha, notaría)'],
  ['{{COMPRADOR_EMAIL}}', 'Correo de notificaciones del comprador'], ['{{COMPRADOR_ATENCION}}', 'Persona de contacto del comprador'],
  ['{{PRECIO}}', 'Precio total de la cesión (suma de las ventas)'], ['{{PRECIO_PALABRAS}}', 'Precio en palabras'],
  ['{{CUENTA_BANCARIA}}', 'Cuenta bancaria del cedente donde se paga (número, banco)'], ['{{N_CREDITOS}}', 'Cantidad de créditos cedidos'],
  ['{{FIRMAS}}', 'Bloque de firmas'], ['{{ANEXO_I}}', 'Anexo 1: tabla con las operaciones cedidas (va en hoja aparte)'],
];

require('../../../../shared/migrate').enFila('cesion-cartera', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS cartera_compradores (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre_corto VARCHAR(80) NOT NULL UNIQUE,
    razon_social VARCHAR(200) NOT NULL, rut VARCHAR(15) NULL, giro VARCHAR(200) NULL,
    domicilio VARCHAR(300) NULL, comuna VARCHAR(100) NULL, ciudad VARCHAR(100) NULL,
    representantes JSON NULL, personeria VARCHAR(600) NULL,
    email VARCHAR(150) NULL, atencion VARCHAR(150) NULL, telefono VARCHAR(40) NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    updated_by VARCHAR(150) NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cartera_contratos_texto (
    tipo VARCHAR(12) PRIMARY KEY, titulo VARCHAR(200) NOT NULL, texto MEDIUMTEXT NOT NULL,
    updated_by VARCHAR(150) NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query("INSERT IGNORE INTO cartera_compradores (nombre_corto, razon_social, activo) VALUES ('CFC','CORPORACION FINANCIERA CFC',1)");
  await pool.query(`UPDATE cartera_contratos_texto SET texto=REPLACE(REPLACE(REPLACE(REPLACE(texto,'"Anexo I"','"Anexo 1"'),'Anexo I ','Anexo 1 '),'Anexo I;','Anexo 1;'),'Anexo I,','Anexo 1,')`).catch(() => {});
  for (const t of TIPOS) {
    const [[ya]] = await pool.query('SELECT tipo FROM cartera_contratos_texto WHERE tipo=?', [t]);
    if (!ya) await pool.query('INSERT INTO cartera_contratos_texto (tipo, titulo, texto) VALUES (?,?,?)', [t, t === 'CON_RESP' ? 'CONTRATO DE CESIÓN DE CRÉDITOS CON RESPONSABILIDAD' : 'CONTRATO DE CESIÓN DE CRÉDITOS', TEXTO_BASE(t === 'CON_RESP')]);
  }
});

/* ── Compradores ─────────────────────────────────────────────────────────── */
exports.compradores = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM cartera_compradores ORDER BY activo DESC, nombre_corto');
    for (const r of rows) { try { r.representantes = typeof r.representantes === 'string' ? JSON.parse(r.representantes) : (r.representantes || []); } catch (_) { r.representantes = []; } }
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};
exports.guardarComprador = async (req, res) => {
  try {
    const b = req.body || {}, t = (v, n) => String(v ?? '').trim().slice(0, n) || null;
    const nombre_corto = String(b.nombre_corto || '').trim().toUpperCase().slice(0, 80);
    const razon_social = t(b.razon_social, 200);
    if (!nombre_corto || !razon_social) return fail(res, 'Nombre corto y razón social son obligatorios', 400);
    let rut = t(b.rut, 15);
    if (rut) { rut = RUT.normalizar(rut) || rut; if (!RUT.validar(rut)) return fail(res, 'RUT del comprador inválido', 400); }
    const reps = (Array.isArray(b.representantes) ? b.representantes : []).slice(0, 6).map(r => ({
      nombre: t(r.nombre, 160), nacionalidad: t(r.nacionalidad, 40), estado_civil: t(r.estado_civil, 40), profesion: t(r.profesion, 80), cedula: t(r.cedula, 20),
    })).filter(r => r.nombre);
    for (const r of reps) if (r.cedula && RUT.validar(RUT.normalizar(r.cedula) || r.cedula)) r.cedula = RUT.formatear(RUT.normalizar(r.cedula));
    const vals = [razon_social, rut, t(b.giro, 200), t(b.domicilio, 300), t(b.comuna, 100), t(b.ciudad, 100), JSON.stringify(reps), t(b.personeria, 600), t(b.email, 150), t(b.atencion, 150), t(b.telefono, 40), b.activo === false || b.activo === 0 ? 0 : 1, nombreDe(req.usuario)];
    const id = parseInt(b.id) || null;
    if (id) await pool.query('UPDATE cartera_compradores SET nombre_corto=?, razon_social=?, rut=?, giro=?, domicilio=?, comuna=?, ciudad=?, representantes=?, personeria=?, email=?, atencion=?, telefono=?, activo=?, updated_by=? WHERE id=?', [nombre_corto, ...vals, id]);
    else await pool.query('INSERT INTO cartera_compradores (nombre_corto, razon_social, rut, giro, domicilio, comuna, ciudad, representantes, personeria, email, atencion, telefono, activo, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [nombre_corto, ...vals]);
    auditar({ req, accion: id ? 'EDITAR' : 'CREAR', modulo: 'tesoreria', entidad: 'cartera_comprador', entidad_id: id || nombre_corto, detalle: `Comprador de cartera ${nombre_corto} (${razon_social})` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.code === 'ER_DUP_ENTRY' ? 'Ya existe un comprador con ese nombre corto' : e.message); }
};

/* ── Textos de contrato ──────────────────────────────────────────────────── */
exports.textos = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM cartera_contratos_texto'); ok(res, { textos: rows, marcadores: MARCADORES }); } catch (e) { fail(res, e.message); }
};
exports.guardarTexto = async (req, res) => {
  try {
    const tipo = String(req.params.tipo || '').toUpperCase();
    if (!TIPOS.includes(tipo)) return fail(res, 'Tipo inválido', 400);
    const texto = String(req.body?.texto || ''), titulo = String(req.body?.titulo || '').trim().slice(0, 200);
    if (!texto.trim() || !titulo) return fail(res, 'Título y texto son obligatorios', 400);
    await pool.query('UPDATE cartera_contratos_texto SET titulo=?, texto=?, updated_by=? WHERE tipo=?', [titulo, texto, nombreDe(req.usuario), tipo]);
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'cartera_contrato_texto', entidad_id: tipo, detalle: `Editó el texto del contrato de cesión ${tipo} (${texto.length} caracteres)` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Generar contrato: GET /contrato?comprador=&fecha=&resp=0|1 ──────────── */
exports.contrato = async (req, res) => {
  try {
    const comprador = String(req.query.comprador || '').trim().toUpperCase();
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha)) ? req.query.fecha : null;
    const resp = req.query.resp === '1' ? 1 : 0;
    if (!comprador || !fecha) return fail(res, 'Faltan comprador y fecha', 400);
    const [ventas] = await pool.query(
      `SELECT v.id_credito, v.num_op, v.precio_venta, v.capital_venta, v.con_responsabilidad ${SEL_CRED}
         FROM cartera_ventas v JOIN creditos c ON c.id=v.id_credito LEFT JOIN clientes cl ON cl.id_cliente=c.id_cliente
        WHERE v.comprador=? AND v.fecha_venta=? AND v.con_responsabilidad=? ORDER BY v.num_op`, [comprador, fecha, resp]);
    if (!ventas.length) return fail(res, 'No hay ventas para ese comprador, fecha y tipo', 404);
    ok(res, await armarContrato(comprador, fecha, resp, ventas));
  } catch (e) { fail(res, e.code ? e.msg : e.message, e.code || 500); }
};

/* POST /contratos/previa { comprador, fecha, resp, ventas:[{id_credito, precio_venta}] } — antes de vender */
exports.previa = async (req, res) => {
  try {
    const b = req.body || {};
    const comprador = String(b.comprador || '').trim().toUpperCase();
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha)) ? b.fecha : require('../../../../shared/fecha-chile').hoyISO();
    const resp = b.resp ? 1 : 0;
    const sel = (Array.isArray(b.ventas) ? b.ventas : []).map(v => ({ id: parseInt(v.id_credito) || 0, precio: Math.round(+v.precio_venta || 0) })).filter(v => v.id);
    if (!comprador || !sel.length) return fail(res, 'Falta el comprador o las operaciones', 400);
    const [creds] = await pool.query(
      `SELECT c.id id_credito, c.num_op ${SEL_CRED},
              (SELECT ROUND(SUM(CASE WHEN q.fecha_pago IS NULL THEN COALESCE(q.amortizacion,0) ELSE 0 END)) FROM cuotas_credito q WHERE q.num_op=c.num_op) capital_venta
         FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente=c.id_cliente WHERE c.id IN (?) ORDER BY c.num_op`, [sel.map(v => v.id)]);
    const ventas = creds.map(c => ({ ...c, precio_venta: sel.find(v => v.id === c.id_credito)?.precio || 0, con_responsabilidad: resp }));
    ok(res, { ...(await armarContrato(comprador, fecha, resp, ventas)), previa: true });
  } catch (e) { fail(res, e.code ? e.msg : e.message, e.code || 500); }
};

const SEL_CRED = `, COALESCE(cl.nombre_completo,'') cliente, COALESCE(cl.rut,'') rut_cliente, c.marca, c.modelo, c.anio, c.patente, c.plazo, c.cuota, c.tascli_real,
  c.monto_financiado, DATE_FORMAT(c.fecha_otorgado,'%d-%m-%Y') fecha_otorgado,
  (SELECT COUNT(*) FROM cuotas_credito q WHERE q.num_op=c.num_op AND q.fecha_pago IS NULL) cuotas_pendientes,
  (SELECT DATE_FORMAT(MIN(q.fecha_vencimiento),'%d-%m-%Y') FROM cuotas_credito q WHERE q.num_op=c.num_op AND q.fecha_pago IS NULL) prox_venc,
  (SELECT DATE_FORMAT(MAX(q.fecha_vencimiento),'%d-%m-%Y') FROM cuotas_credito q WHERE q.num_op=c.num_op) ult_venc`;

/* Arma el contrato (motor único de vista previa y contrato definitivo) */
async function armarContrato(comprador, fecha, resp, ventas) {
    const [[cp]] = await pool.query('SELECT * FROM cartera_compradores WHERE nombre_corto=?', [comprador]);
    if (!cp) throw { code: 400, msg: `El comprador ${comprador} no está en el mantenedor de Compradores: complétalo primero` };
    let reps = []; try { reps = typeof cp.representantes === 'string' ? JSON.parse(cp.representantes) : (cp.representantes || []); } catch (_) {}
    const [[tx]] = await pool.query('SELECT * FROM cartera_contratos_texto WHERE tipo=?', [resp ? 'CON_RESP' : 'SIN_RESP']);
    const emp = await datosEmpresa();
    let cta = null;
    try { const [[c]] = await pool.query("SELECT banco, numero_cuenta FROM cuentas_bancarias WHERE activo=1 ORDER BY id_cuenta LIMIT 1"); cta = c; } catch (_) {}
    const precio = ventas.reduce((s, v) => s + Math.round(+v.precio_venta || 0), 0);
    const repTxt = reps.map(r => `don/doña ${r.nombre}${r.nacionalidad ? ', ' + r.nacionalidad : ''}${r.estado_civil ? ', ' + r.estado_civil : ''}${r.profesion ? ', ' + r.profesion : ''}${r.cedula ? ', Cédula Nacional de Identidad N° ' + r.cedula : ''}`).join(', y ');
    // Anexo I: cada crédito individualizado (deudor, pagaré/operación, vehículo, condiciones y saldo)
    const anexo = `<div class="anexo-pag"><h3>ANEXO 1 — Individualización de los créditos y garantías cedidas</h3><div class="anexo-sub">Contrato de cesión ${esc(emp.razon_social || '')} → ${esc(cp.razon_social)} · ${fechaLarga(fecha)} · ${ventas.length} crédito(s)</div><table class="anexo"><thead><tr><th>N°</th><th>Operación / Pagaré</th><th>Deudor</th><th>RUT</th><th>Vehículo</th><th>Patente</th><th>Otorgado</th><th>Monto original</th><th>Tasa mens.</th><th>Plazo</th><th>Valor cuota</th><th>Cuotas pend.</th><th>Próx. venc.</th><th>Últ. venc.</th><th>Capital insoluto</th><th>Precio cesión</th></tr></thead><tbody>${
      ventas.map((v, i) => `<tr><td>${i + 1}</td><td>${v.num_op}</td><td>${esc(v.cliente)}</td><td class="nw">${esc(v.rut_cliente)}</td><td>${esc([v.marca, v.modelo, v.anio].filter(Boolean).join(' '))}</td><td>${esc(v.patente || '')}</td><td class="nw">${esc(v.fecha_otorgado || '')}</td><td class="num">${CLP(v.monto_financiado)}</td><td class="num">${v.tascli_real != null ? (+v.tascli_real).toLocaleString('es-CL', { maximumFractionDigits: 3 }) + '%' : ''}</td><td>${v.plazo || ''}</td><td class="num">${CLP(v.cuota)}</td><td>${v.cuotas_pendientes ?? ''}</td><td class="nw">${esc(v.prox_venc || '')}</td><td class="nw">${esc(v.ult_venc || '')}</td><td class="num">${CLP(v.capital_venta)}</td><td class="num">${CLP(v.precio_venta)}</td></tr>`).join('')
    }<tr class="tot"><td colspan="14">TOTAL (${ventas.length} crédito${ventas.length === 1 ? '' : 's'})</td><td class="num">${CLP(ventas.reduce((s, v) => s + (+v.capital_venta || 0), 0))}</td><td class="num">${CLP(precio)}</td></tr></tbody></table>
    <p style="font-size:.78rem;margin-top:8px">Los créditos individualizados constan en pagarés suscritos a la orden de ${esc(emp.razon_social || '')}, con la tabla de desarrollo de cada uno (composición de cada cuota en interés corriente, amortización y saldo insoluto) que se acompaña como parte integrante de este Anexo.</p></div>`;
    const firmas = `<div class="firmas"><div><div class="linea"></div>${esc(emp.representante || '')}<br>pp ${esc(emp.razon_social || '')}</div>${reps.map(r => `<div><div class="linea"></div>${esc(r.nombre)}<br>pp ${esc(cp.razon_social)}</div>`).join('') || `<div><div class="linea"></div>pp ${esc(cp.razon_social)}</div>`}</div>`;
    const map = {
      CIUDAD: emp.ciudad || 'Santiago', FECHA_LARGA: fechaLarga(fecha),
      CEDENTE_RAZON: emp.razon_social || '', CEDENTE_RUT: emp.rut_formateado || '', CEDENTE_GIRO: emp.giro || '',
      CEDENTE_REPRESENTANTE: emp.representante || '', CEDENTE_RUT_REPRESENTANTE: emp.rut_representante_formateado || '',
      CEDENTE_DOMICILIO: [emp.domicilio, emp.comuna ? 'comuna de ' + emp.comuna : ''].filter(Boolean).join(', '), CEDENTE_EMAIL: emp.email || '',
      COMPRADOR_RAZON: cp.razon_social, COMPRADOR_RUT: cp.rut ? RUT.formatear(cp.rut) : '', COMPRADOR_GIRO: cp.giro || '',
      COMPRADOR_REPRESENTANTES: repTxt, COMPRADOR_NOMBRES_REPRESENTANTES: reps.map(r => r.nombre).join(' y '),
      COMPRADOR_DOMICILIO: [cp.domicilio, cp.comuna ? 'comuna de ' + cp.comuna : '', cp.ciudad].filter(Boolean).join(', '), COMPRADOR_PERSONERIA: cp.personeria || '',
      COMPRADOR_EMAIL: cp.email || '', COMPRADOR_ATENCION: cp.atencion || '',
      PRECIO: CLP(precio), PRECIO_PALABRAS: numeroAPalabras(precio) + ' pesos', N_CREDITOS: String(ventas.length),
      CUENTA_BANCARIA: cta ? `número ${cta.numero_cuenta}, abierta a nombre de ${emp.razon_social}, en el ${cta.banco}` : '____________',
    };
    let html = esc(tx.texto).split(/\n{2,}|\r\n\r\n/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => k === 'FIRMAS' ? firmas : k === 'ANEXO_I' ? anexo : (k in map ? esc(map[k]) : m));
    if (!/\{\{FIRMAS\}\}/.test(tx.texto)) html += firmas;
    if (!/\{\{ANEXO_I\}\}/.test(tx.texto)) html += anexo;
    return { titulo: tx.titulo, html, comprador: cp, ventas: ventas.length, precio, fecha, resp };
}

/* Grupos de ventas (comprador + fecha + responsabilidad) para el botón "Contrato" */
exports.grupos = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT comprador, DATE_FORMAT(fecha_venta,'%Y-%m-%d') fecha, con_responsabilidad resp, COUNT(*) n, SUM(precio_venta) precio
      FROM cartera_ventas GROUP BY comprador, fecha_venta, con_responsabilidad ORDER BY fecha_venta DESC, comprador`);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

/* ── utilidades ──────────────────────────────────────────────────────────── */
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaLarga(iso) { const [y, m, d] = iso.split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${y}`; }
function numeroAPalabras(n) {
  n = Math.round(Number(n) || 0); if (!n) return 'cero';
  const U = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
  const D = ['', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const C = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
  const cientos = x => { if (x === 100) return 'cien'; const c = Math.floor(x / 100), r = x % 100; const rs = r < 30 ? U[r] : D[Math.floor(r / 10)] + (r % 10 ? ' y ' + U[r % 10] : ''); return [C[c], rs].filter(Boolean).join(' '); };
  const partes = []; const mm = Math.floor(n / 1e6), mi = Math.floor((n % 1e6) / 1e3), r = n % 1e3;
  if (mm) partes.push(mm === 1 ? 'un millón' : cientos(mm) + ' millones');
  if (mi) partes.push(mi === 1 ? 'mil' : cientos(mi) + ' mil');
  if (r) partes.push(cientos(r));
  return partes.join(' ');
}

/* Texto base = formatos V3.0 de Pato (21-09-2026) con marcadores. Editable en el mantenedor. */
function TEXTO_BASE(conResp) {
  const cab = `En {{CIUDAD}} de Chile, a {{FECHA_LARGA}}, entre {{CEDENTE_RAZON}}, sociedad del giro {{CEDENTE_GIRO}}, Rol Único Tributario N° {{CEDENTE_RUT}}, representada por don {{CEDENTE_REPRESENTANTE}}, Cédula de Identidad N° {{CEDENTE_RUT_REPRESENTANTE}}, domiciliado en {{CEDENTE_DOMICILIO}}, en adelante "AUTOFÁCIL" o la "CEDENTE", por una parte; y {{COMPRADOR_RAZON}}, sociedad del giro {{COMPRADOR_GIRO}}, Rol Único Tributario N° {{COMPRADOR_RUT}}, representada por {{COMPRADOR_REPRESENTANTES}}, todos con domicilio en {{COMPRADOR_DOMICILIO}}, en calidad de parte cesionaria, en adelante indistintamente "LA FINANCIERA" o la "CESIONARIA", se ha convenido el siguiente contrato:

PRIMERO: Antecedentes previos. (A) AUTOFÁCIL es una sociedad por acciones cuyo giro es, entre otros, i) otorgar financiamiento para la adquisición de automóviles nuevos y usados a compradores finales, encontrándose legalmente facultada para otorgar y administrar créditos para la adquisición de vehículos motorizados; y ii) la adquisición, enajenación y comercialización, a cualquier título, de títulos de crédito e instrumentos financieros. (B) LA FINANCIERA, por su parte, sociedad cuyo giro es, entre otros, otorgar financiamiento para la adquisición de automóviles nuevos y usados a compradores finales, encontrándose legalmente facultada para otorgar y administrar créditos para la adquisición de vehículos motorizados. (C) Que es intención de AUTOFÁCIL y LA FINANCIERA perfeccionar una cesión de créditos, junto a las prendas que caucionan los mismos, a favor de LA FINANCIERA, previa aceptación de los mismos por parte de esta última; lo que hace necesario acordar el marco contractual en que se perfeccionará esta cesión, el que se establece en las cláusulas siguientes:

SEGUNDO: De los créditos y sus prendas. Los créditos a los que se refiere este contrato son aquellos otorgados por AUTOFÁCIL a los compradores de vehículos motorizados para la adquisición de los mismos y sus respectivas garantías que caucionan su cumplimiento, consistentes en prendas sin desplazamiento de la ley N° 20.190. Estos créditos constan y se documentan en pagarés suscritos a la orden de AUTOFÁCIL, con sus firmas autorizadas ante Notario Público e impuestos de timbres y estampillas pagados y, que, en ciertos casos, también han sido suscritos por avalistas, fiadores y codeudores solidarios, cuyas firmas, igualmente, se encuentran autorizadas ante notario público.

TERCERO: Cesión. No obstante que los créditos objeto de esta cesión son "a la orden" y por tanto se ceden y transfieren mediante endoso suscrito por AUTOFÁCIL a favor de LA FINANCIERA, en este acto y mediante el presente instrumento, AUTOFÁCIL viene en vender, ceder y transferir a LA FINANCIERA, quien viene en comprar, adquirir y aceptar para sí, todos y cada uno de los {{N_CREDITOS}} créditos que se singularizan en el "Anexo 1". Sin perjuicio de la cesión de que da cuenta el presente instrumento, la transferencia de los créditos objeto del presente contrato se perfecciona en este acto y con esta misma fecha, mediante el endoso en dominio que AUTOFÁCIL hace a favor de LA FINANCIERA en todos y cada uno de los pagarés que documentan los créditos objeto del mismo, singularizados en el "Anexo 1" del presente instrumento. Sin perjuicio de lo estipulado en la cláusula cuarta siguiente, el precio de la compraventa de los créditos objeto del presente contrato es la suma de {{PRECIO}} ({{PRECIO_PALABRAS}}), suma que será pagada a AUTOFÁCIL mediante transferencia electrónica a la cuenta corriente bancaria {{CUENTA_BANCARIA}}, dentro de las veinticuatro horas siguientes de: a) haberse suscrito el presente contrato; b) haberse endosado todos y cada uno de los pagarés singularizados en el Anexo 1; c) haberse entregado las copias de las facturas de todas y cada una de las compraventas de los vehículos cuyos precios fueron financiados con los créditos objeto de esta cesión; d) la constancia de registro de los vehículos aludidos a nombre de sus respectivos compradores, en el Registro Nacional de Vehículos Motorizados del Registro Civil e Identificación; y e) la constancia de la inscripción de las prendas sin desplazamiento y prohibiciones que gravan a los vehículos referidos, en el Registro Nacional de Prendas Sin Desplazamiento del Registro Civil e Identificación. Los comparecientes dejan expresa constancia que las prendas sin desplazamiento de la Ley N° 20.190 que se constituyeron con motivo u ocasión de los créditos objeto de esta cesión se ceden y transfieren materialmente a LA FINANCIERA mediante el presente instrumento, el que también da cuenta de haberse cedido y transferido los créditos a que dichas prendas acceden. Se deja expresa constancia que, para que las prendas que caucionan los créditos objeto de esta cesión se transfieran a LA FINANCIERA manteniendo la preferencia de que gozaban, en el Registro de Prendas Sin Desplazamiento deben constar tanto el crédito garantizado como la posibilidad de cesión de las prendas.

CUARTO: Varios. a) AUTOFÁCIL declara que los pagarés que documentan los créditos objeto de esta cesión tienen su origen en operaciones reales y lícitas, habiendo sido suscritos en conformidad a la ley, autorizados ante notario público y encontrándose sus impuestos de timbres y estampillas pagados. Cualquier objeción de LA FINANCIERA a alguno de los créditos cedidos, fundada en alguno de los aspectos expuestos en el párrafo anterior, deberá ser necesariamente efectuada y comunicada a AUTOFÁCIL dentro del plazo de treinta días corridos contados desde la fecha del presente contrato. Planteada la objeción, AUTOFÁCIL revisará la misma y, en caso de que la objeción implique un defecto en la documentación sustentatoria del crédito que impida a LA FINANCIERA ejercer la acción ejecutiva de cobro junto con su garantía, AUTOFÁCIL reembolsará a LA FINANCIERA, previa restitución de dicho crédito, pagaré y garantías, la suma que resulte de restar a la cantidad pagada por dicho crédito las sumas percibidas por LA FINANCIERA, de existir. ${conResp ? '' : 'Las partes dejan expresa constancia que AUTOFÁCIL en ningún caso responderá por la insolvencia de los deudores, por el no pago o imposibilidad de pago de los créditos cedidos. '}Igual procedimiento de objeción se hará en caso que las prendas que garanticen los créditos objeto de esta cesión se encuentren mal constituidas o no puedan ser cedidas y transferidas a LA FINANCIERA dentro del plazo señalado en la cláusula tercera. b) La comunicación escrita de la cesión de los créditos a sus deudores será de costo y cargo de AUTOFÁCIL. Sin perjuicio de lo anterior, AUTOFÁCIL y LA FINANCIERA, conjuntamente, enviarán a cada uno de los deudores de los créditos cedidos un aviso por correo electrónico, informando de la transferencia de sus créditos a LA FINANCIERA y el lugar u oficina donde los créditos deberán ser pagados.

QUINTO: Notificación al deudor. La notificación de la cesión de crédito la realizará el comprador de acuerdo a lo establecido en el artículo 1902 y siguientes del Código Civil.

SEXTO: Gastos. Todos los impuestos y gastos derivados del otorgamiento y suscripción del presente contrato, así como de aquellos necesarios para ceder los créditos, garantías y anotar las cesiones en los registros públicos respectivos serán de cargo de AUTOFÁCIL. Las partes acuerdan que será de costo y cargo de AUTOFÁCIL realizar los trámites, anotaciones, inscripciones y, en general, cualquier actuación necesaria para perfeccionar las transferencias de las garantías y prohibiciones, en especial de las prendas sin desplazamiento de la Ley N° 20.190 y las prohibiciones de no enajenar constituidas junto a las mismas, así como el cambio de acreedor en el Registro Nacional de Vehículos Motorizados y en el Registro de Prendas Sin Desplazamiento, ambos del Registro Civil e Identificación, y por consiguiente cualquier costo, gasto o gestión asociado a sus alzamientos, de resultar procedente.
`;
  const resp = `
SÉPTIMO: Garantías del Vendedor. El Vendedor, debidamente representado en la forma indicada en la comparecencia, a esta fecha declara y asegura lo siguiente al Comprador, en el entendido que las declaraciones y seguridades establecidas en la presente cláusula se efectúan el día de la firma del presente contrato con referencia a las circunstancias existentes o conocidas en esta fecha: (a) Que los contratos de crédito existen y han sido válidamente celebrados, con poderes suficientes para ello, que sus estipulaciones son ejecutables y exigibles, y que no vulneran ninguna normativa legal, reglamentaria o de cualquier otra índole. (b) Que los pagarés que se ceden existen y cumplen con todos y cada uno de los requisitos necesarios para ser válidos, exigibles y tener mérito ejecutivo, y que la firma del suscriptor ha sido autorizada ante Notario Público y se ha pagado el total del impuesto de timbres y estampillas. (c) Que las prendas de los vehículos que garantizan los créditos y pagarés cedidos se encuentran debidamente constituidas e inscritas en el Registro de Prendas sin Desplazamiento del Servicio de Registro Civil e Identificación. (d) AUTOFÁCIL se obliga a indemnizar y mantener indemne al Comprador por eventuales acciones, excepciones y reclamos ejercidos ante los tribunales de justicia o autoridades administrativas por posibles cláusulas abusivas contenidas en los contratos de crédito y/o sus respectivos pagarés. (e) AUTOFÁCIL se obliga a reembolsar al Comprador el saldo insoluto de aquellos créditos y pagarés que no puedan ser cedidos y transferidos por haberse perdido o destruido los documentos en que constan. (f) AUTOFÁCIL se obliga, como promesa de hecho ajeno conforme al artículo 1450 del Código Civil, a que se perfeccione el cambio de acreedor de las prendas sin desplazamiento dentro del plazo máximo de sesenta días corridos desde la fecha del presente instrumento; en el evento que ello no ocurra, se obliga a reembolsar al Comprador el saldo insoluto de aquellos créditos. (g) Que las obligaciones contraídas por el Vendedor en virtud de este contrato son válidas, legalmente obligatorias y exigibles en su contra. (h) Que el Impuesto de Timbres y Estampillas de los contratos de crédito y sus pagarés ha sido pagado en tiempo y forma; en caso contrario, los valores correspondientes serán descontados del precio de compra.

En el evento que uno o más de los créditos y/o sus pagarés no cumplan con una cualquiera de las condiciones descritas en la presente cláusula, AUTOFÁCIL se obliga, a elección y al solo requerimiento del Comprador: (a) a restituir el saldo insoluto de capital, o (b) a ceder y transferir nuevos créditos con sus respectivos pagarés, por un monto total equivalente al saldo insoluto de capital más intereses devengados de los créditos devueltos. La restitución de los créditos que no cumplan con los requisitos se efectuará junto con los documentos de la prenda y de cobranza.

OCTAVO: Responsabilidad. Como parte del acuerdo de venta de los créditos individualizados en el Anexo 1, AUTOFÁCIL entrega una garantía de reposición del capital insoluto en caso que el deudor cese por 91 días el pago de las cuotas de su crédito. En tal caso, LA FINANCIERA devolverá el crédito y las garantías asociadas a AUTOFÁCIL mediante este mismo mecanismo de cesión de créditos. Por cada crédito cedido se acompaña una tabla de desarrollo con la composición de cada cuota en intereses corrientes, amortización a capital y saldo insoluto. Para hacer efectiva esta garantía el cesionario deberá: cumplir la Ley N° 19.496 y sus modificaciones (Ley N° 21.320) en materia de cobranza extrajudicial, incluida la gestión útil de cobranza dentro de los primeros 15 días desde cada vencimiento impago; realizar al menos un intento de contacto semanal alternando canales (teléfono, SMS, correo electrónico y terreno); conservar por al menos 2 años las gestiones de cada crédito (fecha, hora, canal, resultado y comentario; en las promesas de pago, fecha, monto y cumplimiento) y entregarlas a AUTOFÁCIL al devolver el crédito; informar a AUTOFÁCIL entre los 61 y 68 días de mora cuando no haya logrado contacto, para que ésta provea nuevos datos de contacto; informar entre los 91 y 98 días de mora su intención de devolver el crédito, acompañando las gestiones realizadas, y desde la confirmación de recepción por AUTOFÁCIL detener toda gestión de cobranza; si antes de firmarse la cesión de vuelta el crédito bajara a 60 o menos días de mora, el proceso de devolución se detendrá; entre los días 91 y 120 de mora entregar la documentación, las gestiones y endosar la prenda y seguros a nombre de AUTOFÁCIL, con gastos de cargo de LA FINANCIERA, de modo que toda la documentación esté a nombre de AUTOFÁCIL antes del día 150 de mora; en caso de fallecimiento del deudor, acompañar el certificado de defunción y hacer efectivo el seguro de desgravamen; e informar todo pago recibido de un crédito con 61 o más días de mora dentro de 24 horas. Cumplidos los pasos anteriores en los plazos convenidos, AUTOFÁCIL tendrá 30 días para el pago del saldo de capital insoluto de las operaciones devueltas. En ningún caso AUTOFÁCIL recibirá créditos que hayan cumplido 180 días de mora ni créditos cuyo deudor se haya acogido a la ley concursal sin que el cesionario haya concurrido como acreedor. Todos los impuestos y gastos necesarios para ceder de vuelta los créditos y sus garantías serán de cargo de LA FINANCIERA. Una vez transferidos los créditos a AUTOFÁCIL, LA FINANCIERA se compromete a recibir los pagos de estas operaciones por hasta 60 días desde la cesión e informarlos a AUTOFÁCIL; pasados los 60 días derivará a los clientes a AUTOFÁCIL.
`;
  const fin = `
${conResp ? 'NOVENO' : 'SÉPTIMO'}: Confidencialidad. Toda información que LA FINANCIERA, sus dependientes o asesores tomen conocimiento en virtud o con ocasión del presente contrato, incluida la información relativa a los clientes de AUTOFÁCIL, de los clientes del concesionario u otros, tiene el carácter de confidencial y reservada. LA FINANCIERA se obliga a guardar debida confidencialidad y reserva sobre toda la información a la que pueda tener acceso con motivo u ocasión del presente contrato o le sea entregada por AUTOFÁCIL bajo ese carácter, estándole prohibida su divulgación a terceros o su utilización para fines distintos de los relacionados con el presente contrato. LA FINANCIERA será responsable de que todos sus dependientes o asesores den estricto cumplimiento a las obligaciones de esta cláusula. Se considera confidencial, sin que la enumeración sea taxativa: a) toda información relativa al sistema, al modelo operativo y de negocios, así como toda información comercial, financiera y personal de los clientes de AUTOFÁCIL cuyos créditos no sean cedidos, y de los concesionarios; b) toda información relativa a operaciones que no sean objeto del presente contrato, en especial la relacionada con el comprador del vehículo, sus antecedentes personales, crediticios u otros; c) todos los antecedentes legales, contables, financieros y tributarios generados; d) toda información que resulte de la operación del modelo de negocios de AUTOFÁCIL; e) los acuerdos, derechos, obligaciones y demás condiciones establecidas en el presente instrumento. Las obligaciones de confidencialidad no se entenderán infringidas si LA FINANCIERA acredita que la información está disponible al público por otros medios, que fue obtenida por medio de una solicitud de crédito presentada por un concesionario distinto de la red AUTOFÁCIL, o que ya no es considerada confidencial por AUTOFÁCIL. La obligación de confidencialidad subsistirá hasta dos años desde la fecha del presente contrato y constituye un elemento esencial para AUTOFÁCIL.

${conResp ? 'DÉCIMO' : 'OCTAVO'}: Solución de controversias. Las partes desplegarán sus mejores esfuerzos para resolver previamente, y antes de la interposición de cualquier acción judicial, arbitral o administrativa, mediante negociaciones directas entre ellas, cualquier diferencia, problema, conflicto, controversia, litigio o disputa que pueda presentarse respecto de o en relación con este contrato, lo que en caso de ser necesario conllevará una reunión entre los gerentes o directivos superiores de cada una de las partes. En caso de no prosperar lo anterior, cualquiera de las partes podrá ejercer las acciones legales pertinentes.

${conResp ? 'DÉCIMO PRIMERO' : 'NOVENO'}: Cláusula Arbitral. Sin perjuicio de lo señalado en la cláusula precedente, toda dificultad o controversia que surja entre los contratantes sobre la aplicación, interpretación, validez, cumplimiento o incumplimiento de este contrato será sometida a arbitraje, conforme al Reglamento Procesal de Arbitraje vigente del Centro de Arbitraje y Mediación de la Cámara de Comercio de Santiago A.G. Las partes confieren poder especial irrevocable a la Cámara de Comercio de Santiago A.G. para que, a solicitud escrita de cualquiera de ellas, designe un árbitro de entre los integrantes del cuerpo arbitral del Centro de Arbitraje y Mediación de Santiago. En contra de las resoluciones del árbitro no procederá recurso alguno, por lo que las partes renuncian expresamente a ellos. El árbitro estará facultado para resolver sobre su competencia y jurisdicción.

${conResp ? 'DÉCIMO SEGUNDO' : 'DÉCIMO'}: Domicilio. Para todos los efectos del presente contrato, las partes fijan su domicilio en la ciudad y comuna de {{CIUDAD}}. Toda comunicación podrá realizarse mediante carta certificada o correo electrónico dirigido a la otra parte a la dirección señalada en la comparecencia o a los correos siguientes: LA FINANCIERA: {{COMPRADOR_EMAIL}}, atención {{COMPRADOR_ATENCION}}; AUTOFÁCIL: {{CEDENTE_EMAIL}}.

${conResp ? 'DÉCIMO TERCERO' : 'DÉCIMO PRIMERO'}: La omisión de parte de AUTOFÁCIL y/o LA FINANCIERA de exigir el estricto cumplimiento de cualquiera de los términos de este contrato en una o más ocasiones no podrá ser considerada, en ningún caso, como renuncia de derechos o consentimiento, ni priva a AUTOFÁCIL y/o a LA FINANCIERA de su facultad de exigir el estricto cumplimiento de las obligaciones que de él derivan.

${conResp ? 'DÉCIMO CUARTO' : 'DÉCIMO SEGUNDO'}: Si por cualquier motivo una o más de las disposiciones de este instrumento fueran declaradas nulas o ineficaces, total o parcialmente, dicha declaración no afectará la validez de las demás disposiciones. Las partes harán sus mejores esfuerzos para alcanzar el mismo resultado o efecto que habría producido la cláusula o disposición nula o ineficaz.

${conResp ? 'DÉCIMO QUINTO' : 'DÉCIMO TERCERO'}: Las partes no podrán bajo ninguna circunstancia ceder, traspasar ni transferir a terceros una parte o el total del presente contrato o de sus anexos.

${conResp ? 'DÉCIMO SEXTO' : 'DÉCIMO CUARTO'}: Personerías. La personería de don {{CEDENTE_REPRESENTANTE}} para representar a {{CEDENTE_RAZON}} consta en escritura pública que no se inserta por ser conocida de las partes. La personería de {{COMPRADOR_NOMBRES_REPRESENTANTES}} para representar a {{COMPRADOR_RAZON}} consta en {{COMPRADOR_PERSONERIA}}, la que no se inserta por ser conocida de las partes y a su expresa petición. Minuta presentada por los comparecientes y bajo su responsabilidad.

El presente documento se firma en dos ejemplares, quedando uno a disposición de cada una de las partes.

{{FIRMAS}}

{{ANEXO_I}}`;
  return cab + (conResp ? resp : '') + fin;
}
