'use strict';
/**
 * Mantenedor Seguros AutoFácil (créditos con recursos propios) — SURA.
 * Una fila por seguro (DESGRAVAMEN, CESANTIA, VEHICULO) con la póliza, la aseguradora,
 * el intermediario, las condiciones de asegurabilidad, la opción de tarifa vigente y el
 * markup; los tramos de tasa por plazo (por opción) y las comisiones (por opción) en
 * tablas hijas. Semilla = cotizaciones SURA del 04-09-2026 y correo de Leonardo del
 * 24-09-2026 (emisión desde el 01-10-2026, desgravamen por la opción 2 / tasa técnica).
 *
 * NO confundir con "Factores de Seguros Clientes" (parametros_credito seg_*): esos son
 * los seguros del canal AUTOFIN. Estos son los de AUTOFÁCIL como acreedor.
 * Motor de cálculo único: shared/seguros-autofacil.js → prima().
 */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const motor = require('../../../../shared/seguros-autofacil');

const SEGUROS = ['DESGRAVAMEN', 'CESANTIA', 'VEHICULO'];

const SEED = [
  {
    seguro: 'DESGRAVAMEN', nombre: 'Desgravamen', aseguradora: 'Seguros de Vida Suramericana S.A.', aseguradora_rut: '76.263.414-7',
    poliza_cmf: 'POL220131574', intermediario: 'FACILSEGUROS SPA', intermediario_rut: '77.378.151-6',
    fecha_cotizacion: '2026-09-04', vigencia_desde: '2026-10-01', opcion_vigente: 2, markup_pct: null, base_prima: 'MIC',
    obligatorio: 1, exento_iva: 1, tope_capital_uf: 1000, edad_min: 18, edad_max_ingreso: 74, edad_max_permanencia: 79,
    carencia_dias: null, antiguedad_dias: null, espera_dias: null, cuotas_max: null, tope_cuota_uf: null,
    devolucion_prepago: 'Prima devengada: se devuelve la prima no devengada; la comisión no se devuelve.',
    cobertura: 'Fallecimiento. Capital asegurado = saldo insoluto al último día del mes anterior al siniestro (servicio regular de la deuda, sin mora). Máximo UF 1.000 por deudor. Renegociar el crédito termina la póliza y obliga a una nueva. Beneficiario: AUTOFACIL SPA.',
    notas: 'Opción 1 = tasa bruta con comisiones incorporadas (corredor, administración de siniestros y cartera, recaudación, uso de canal). Opción 2 = tasa técnica neta, sin comisiones: AutoFácil define el markup. Leonardo pidió emitir por la opción 2 (24-09-2026).',
    tramos: {
      1: [[1, 12, 1.07], [13, 24, 2.14], [25, 36, 3.23], [37, 48, 4.30], [49, 60, 5.36]],
      2: [[1, 12, 0.31], [13, 24, 0.63], [25, 36, 0.95], [37, 48, 1.26], [49, 60, 1.57]],
    },
    comisiones: {
      1: [['Comisión del corredor', 2.8], ['Administración corredor de siniestros', 3.9], ['Administración corredor cartera post venta', 4.0], ['Recaudación', 6.5], ['Uso de canal', 53.5]],
      2: [],
    },
  },
  {
    seguro: 'CESANTIA', nombre: 'Cesantía involuntaria', aseguradora: 'Seguros Generales Suramericana S.A.', aseguradora_rut: '99.017.000-2',
    poliza_cmf: 'POL120220198', intermediario: 'FACILSEGUROS SPA', intermediario_rut: '77.378.151-6',
    fecha_cotizacion: '2026-09-04', vigencia_desde: '2026-10-01', opcion_vigente: 1, markup_pct: null, base_prima: 'MIC',
    obligatorio: 0, exento_iva: 0, tope_capital_uf: null, edad_min: 18, edad_max_ingreso: null, edad_max_permanencia: null,
    carencia_dias: 60, antiguedad_dias: 180, espera_dias: 30, cuotas_max: 3, tope_cuota_uf: 6,
    devolucion_prepago: 'Vigencia individual hasta la extinción del crédito (prepago, refinanciamiento, repactación o vencimiento).',
    cobertura: 'Cesantía involuntaria de trabajadores dependientes con contrato indefinido (art. 161 necesidades de la empresa, 159 N°1 mutuo acuerdo con ≥2/3 de indemnización, 159 N°6 caso fortuito; funcionarios públicos de planta; docentes; FF.AA. sin pensión). Paga hasta 3 cuotas, tope UF 6 por cuota, un solo evento en toda la vigencia. Excluye plazo fijo, obra o faena, socios >20% y parientes del socio mayoritario. Período activo mínimo 180 días; denuncia dentro de 90 días.',
    notas: 'Tabla de tasa bruta con intermediación FACILSEGUROS 8% + IVA sobre prima neta (sin otras comisiones). La opción 2 (tasa técnica) se pidió a SURA el 09-09-2026 y no está en la cotización recibida.',
    tramos: {
      1: [[1, 12, 2.44], [13, 24, 2.92], [25, 36, 3.39], [37, 48, 3.87], [49, 60, 3.96], [61, 72, 4.04]],
      2: [],
    },
    comisiones: { 1: [['Intermediación FACILSEGUROS (más IVA)', 8.0]], 2: [] },
  },
  {
    seguro: 'VEHICULO', nombre: 'Vehículo (Auto Full / PT + RC)', aseguradora: 'Seguros Generales Suramericana S.A.', aseguradora_rut: '99.017.000-2',
    poliza_cmf: null, intermediario: 'FACILSEGUROS SPA', intermediario_rut: '77.378.151-6',
    fecha_cotizacion: null, vigencia_desde: null, opcion_vigente: null, markup_pct: null, base_prima: 'PORTAL',
    obligatorio: 0, exento_iva: 0, tope_capital_uf: null, edad_min: null, edad_max_ingreso: null, edad_max_permanencia: null,
    carencia_dias: null, antiguedad_dias: null, espera_dias: null, cuotas_max: null, tope_cuota_uf: null,
    devolucion_prepago: null,
    cobertura: 'Planes por deducible: sin deducible, UF 3, UF 5, UF 10 y PT + RC. Vigencia 12 o 24 meses, pago en cuotas por Oneclick (día 5, 15 o 25). Vehículo fuera del stock del convenio requiere inspección. GPS Ley Antiportonazo con retiro gratis en sucursal SURA.',
    notas: 'Sin tarifa en el sistema: se cotiza y emite en el portal SURA Dealers con usuario y clave entregados por SURA (Nicole Marinovic, canal dealers). La venta se cuenta cuando el cliente enrola el medio de pago y hace la inspección si aplica; el link vence a los 15 días. Condiciones y comisiones de auto pendientes de SURA.',
    links: [['Portal SURA Dealers (cotizar y vender)', 'https://suracl.fidenslat.com/Sura_Dealers/'], ['Inscripción de tarjeta Oneclick', 'https://seguros.sura.cl/pagar/oneclick'], ['Inspección del vehículo', 'https://auto.inspeccionvehiculo.com/auth'], ['Solicitud de GPS', 'https://seguros.sura.cl/migps']],
    tramos: {}, comisiones: {},
  },
];

require('../../../../shared/migrate').enFila('seguros-autofacil', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS seguros_autofacil (
      seguro VARCHAR(20) PRIMARY KEY, nombre VARCHAR(80) NOT NULL,
      aseguradora VARCHAR(120) NULL, aseguradora_rut VARCHAR(20) NULL, poliza_cmf VARCHAR(40) NULL,
      intermediario VARCHAR(120) NULL, intermediario_rut VARCHAR(20) NULL,
      fecha_cotizacion DATE NULL, vigencia_desde DATE NULL, opcion_vigente TINYINT NULL, markup_pct DECIMAL(6,2) NULL,
      base_prima VARCHAR(10) NOT NULL DEFAULT 'MIC', obligatorio TINYINT NOT NULL DEFAULT 0, exento_iva TINYINT NOT NULL DEFAULT 0,
      tope_capital_uf DECIMAL(10,2) NULL, edad_min INT NULL, edad_max_ingreso INT NULL, edad_max_permanencia INT NULL,
      carencia_dias INT NULL, antiguedad_dias INT NULL, espera_dias INT NULL, cuotas_max INT NULL, tope_cuota_uf DECIMAL(6,2) NULL,
      devolucion_prepago VARCHAR(400) NULL, cobertura TEXT NULL, notas TEXT NULL, links JSON NULL,
      activo TINYINT NOT NULL DEFAULT 1, updated_by VARCHAR(120) NULL, updated_at DATETIME NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS seguros_autofacil_tramos (
      id INT AUTO_INCREMENT PRIMARY KEY, seguro VARCHAR(20) NOT NULL, opcion TINYINT NOT NULL,
      plazo_desde INT NOT NULL, plazo_hasta INT NOT NULL, tasa_pct DECIMAL(8,4) NOT NULL,
      INDEX idx_seg (seguro, opcion, plazo_desde))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS seguros_autofacil_comisiones (
      id INT AUTO_INCREMENT PRIMARY KEY, seguro VARCHAR(20) NOT NULL, opcion TINYINT NOT NULL,
      nombre VARCHAR(120) NOT NULL, pct DECIMAL(6,2) NOT NULL, iva_incluido TINYINT NOT NULL DEFAULT 1, orden INT NOT NULL DEFAULT 0,
      INDEX idx_seg (seguro, opcion))`);
    for (const s of SEED) {
      const [[ex]] = await pool.query('SELECT seguro FROM seguros_autofacil WHERE seguro=?', [s.seguro]);
      if (ex) continue;   // el Administrador manda: la semilla solo entra una vez
      await pool.query(`INSERT INTO seguros_autofacil (seguro, nombre, aseguradora, aseguradora_rut, poliza_cmf, intermediario, intermediario_rut,
          fecha_cotizacion, vigencia_desde, opcion_vigente, markup_pct, base_prima, obligatorio, exento_iva, tope_capital_uf, edad_min, edad_max_ingreso,
          edad_max_permanencia, carencia_dias, antiguedad_dias, espera_dias, cuotas_max, tope_cuota_uf, devolucion_prepago, cobertura, notas, links, updated_by, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Semilla cotización SURA 04-09-2026',NOW())`,
        [s.seguro, s.nombre, s.aseguradora, s.aseguradora_rut, s.poliza_cmf, s.intermediario, s.intermediario_rut, s.fecha_cotizacion, s.vigencia_desde,
         s.opcion_vigente, s.markup_pct, s.base_prima, s.obligatorio, s.exento_iva, s.tope_capital_uf, s.edad_min, s.edad_max_ingreso, s.edad_max_permanencia,
         s.carencia_dias, s.antiguedad_dias, s.espera_dias, s.cuotas_max, s.tope_cuota_uf, s.devolucion_prepago, s.cobertura, s.notas, s.links ? JSON.stringify(s.links) : null]);
      for (const [op, filas] of Object.entries(s.tramos))
        for (const [d, h, t] of filas) await pool.query('INSERT INTO seguros_autofacil_tramos (seguro, opcion, plazo_desde, plazo_hasta, tasa_pct) VALUES (?,?,?,?,?)', [s.seguro, +op, d, h, t]);
      for (const [op, filas] of Object.entries(s.comisiones))
        filas.forEach(([n, p], i) => pool.query('INSERT INTO seguros_autofacil_comisiones (seguro, opcion, nombre, pct, iva_incluido, orden) VALUES (?,?,?,?,?,?)', [s.seguro, +op, n, p, s.seguro === 'CESANTIA' ? 0 : 1, i]));
    }
    // Card en Mantenedores + permiso al Administrador
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_seguros_autofacil' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
          VALUES (?, 'Seguros AutoFácil (SURA)', 'mant_seguros_autofacil', '/mantenedores/seguros-autofacil/', 'bi-shield-check')`, [mod.id_modulo]);
        idf = r.insertId;
      }
      // Administrador, Gerente de Finanzas, Gerente de Operaciones y Crédito, Gerente General
      for (const idp of [1, 90007, 90008, 90009])
        await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
    console.log('[seguros-autofacil] mantenedor registrado');
  } catch (e) { console.error('[seguros-autofacil migration]', e.message); }
});

const quien = req => `${req.usuario?.nombre || ''} ${req.usuario?.apellido || ''}`.trim() || String(req.usuario?.id_usuario || '');
const err500 = (res, tag, e) => { console.error(`[seguros-autofacil ${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };
const num = (v, min, max) => { if (v === '' || v == null) return null; const x = parseFloat(v); if (isNaN(x)) return null; return Math.min(Math.max(x, min), max); };
const int = (v, min, max) => { if (v === '' || v == null) return null; const x = parseInt(v, 10); if (isNaN(x)) return null; return Math.min(Math.max(x, min), max); };
const fecha = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

/* GET /api/seguros-autofacil → los 3 seguros con tramos y comisiones */
const listar = async (req, res) => {
  try { res.json({ success: true, data: await motor.cargar(true), error: null }); }
  catch (e) { err500(res, 'listar', e); }
};

/* GET /api/seguros-autofacil/prima?seguro=&mic=&plazo=&opcion= → motor único */
const prima = async (req, res) => {
  try {
    const seguro = String(req.query.seguro || '').toUpperCase();
    if (!SEGUROS.includes(seguro)) return res.status(400).json({ success: false, data: null, error: 'Seguro inválido' });
    const mic = num(req.query.mic, 0, 1e10), plazo = int(req.query.plazo, 1, 120);
    if (!(mic > 0) || !plazo) return res.status(400).json({ success: false, data: null, error: 'Indica monto inicial del crédito y plazo' });
    const opcion = int(req.query.opcion, 1, 2);
    res.json({ success: true, data: await motor.prima(seguro, mic, plazo, opcion ? { opcion } : {}), error: null });
  } catch (e) { err500(res, 'prima', e); }
};

/* PUT /api/seguros-autofacil/:seguro → cabecera (condiciones, opción vigente, markup) */
const actualizar = async (req, res) => {
  try {
    const seguro = String(req.params.seguro || '').toUpperCase();
    if (!SEGUROS.includes(seguro)) return res.status(400).json({ success: false, data: null, error: 'Seguro inválido' });
    const b = req.body || {};
    const s = (k, n) => (b[k] == null ? null : String(b[k]).trim().slice(0, n) || null);
    const opcion_vigente = int(b.opcion_vigente, 1, 2);
    const [r] = await pool.query(`UPDATE seguros_autofacil SET nombre=COALESCE(?, nombre), aseguradora=?, aseguradora_rut=?, poliza_cmf=?, intermediario=?, intermediario_rut=?,
        fecha_cotizacion=?, vigencia_desde=?, opcion_vigente=?, markup_pct=?, obligatorio=?, exento_iva=?, tope_capital_uf=?, edad_min=?, edad_max_ingreso=?, edad_max_permanencia=?,
        carencia_dias=?, antiguedad_dias=?, espera_dias=?, cuotas_max=?, tope_cuota_uf=?, devolucion_prepago=?, cobertura=?, notas=?, links=?, activo=?, updated_by=?, updated_at=NOW()
      WHERE seguro=?`,
      [s('nombre', 80), s('aseguradora', 120), s('aseguradora_rut', 20), s('poliza_cmf', 40), s('intermediario', 120), s('intermediario_rut', 20),
       fecha(b.fecha_cotizacion), fecha(b.vigencia_desde), opcion_vigente, num(b.markup_pct, 0, 500), b.obligatorio ? 1 : 0, b.exento_iva ? 1 : 0,
       num(b.tope_capital_uf, 0, 1e6), int(b.edad_min, 0, 120), int(b.edad_max_ingreso, 0, 120), int(b.edad_max_permanencia, 0, 120),
       int(b.carencia_dias, 0, 3650), int(b.antiguedad_dias, 0, 3650), int(b.espera_dias, 0, 3650), int(b.cuotas_max, 0, 120), num(b.tope_cuota_uf, 0, 1e5),
       s('devolucion_prepago', 400), b.cobertura == null ? null : String(b.cobertura).slice(0, 4000), b.notas == null ? null : String(b.notas).slice(0, 4000),
       Array.isArray(b.links) ? JSON.stringify(b.links.filter(l => Array.isArray(l) && l[1]).map(l => [String(l[0] || '').slice(0, 80), String(l[1]).slice(0, 300)])) : null,
       b.activo === false || b.activo === 0 ? 0 : 1, quien(req), seguro]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Seguro no encontrado' });
    motor.invalidar();
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'seguros_autofacil', entidad_id: seguro, detalle: `Seguro AutoFácil ${seguro} editado (opción vigente ${opcion_vigente || '—'}, markup ${b.markup_pct ?? '—'}%)` });
    res.json({ success: true, data: await motor.cargar(true), error: null });
  } catch (e) { err500(res, 'actualizar', e); }
};

/* PUT /api/seguros-autofacil/:seguro/tramos { opcion, tramos:[{plazo_desde,plazo_hasta,tasa_pct}] } → reemplaza la tabla de esa opción */
const setTramos = async (req, res) => {
  try {
    const seguro = String(req.params.seguro || '').toUpperCase();
    const opcion = int(req.body?.opcion, 1, 2);
    if (!SEGUROS.includes(seguro) || !opcion) return res.status(400).json({ success: false, data: null, error: 'Seguro u opción inválidos' });
    const tramos = (Array.isArray(req.body?.tramos) ? req.body.tramos : [])
      .map(t => ({ d: int(t.plazo_desde, 1, 120), h: int(t.plazo_hasta, 1, 120), t: num(t.tasa_pct, 0, 100) }))
      .filter(t => t.d && t.h && t.t != null && t.h >= t.d).sort((a, b) => a.d - b.d);
    for (let i = 1; i < tramos.length; i++) if (tramos[i].d <= tramos[i - 1].h)
      return res.status(400).json({ success: false, data: null, error: `Los tramos se pisan: ${tramos[i - 1].d}-${tramos[i - 1].h} y ${tramos[i].d}-${tramos[i].h}` });
    await pool.query('DELETE FROM seguros_autofacil_tramos WHERE seguro=? AND opcion=?', [seguro, opcion]);
    for (const t of tramos) await pool.query('INSERT INTO seguros_autofacil_tramos (seguro, opcion, plazo_desde, plazo_hasta, tasa_pct) VALUES (?,?,?,?,?)', [seguro, opcion, t.d, t.h, t.t]);
    await pool.query('UPDATE seguros_autofacil SET updated_by=?, updated_at=NOW() WHERE seguro=?', [quien(req), seguro]);
    motor.invalidar();
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'seguros_autofacil', entidad_id: seguro, detalle: `Tramos opción ${opcion} de ${seguro}: ${tramos.map(t => `${t.d}-${t.h} ${t.t}%`).join(' · ')}` });
    res.json({ success: true, data: await motor.cargar(true), error: null });
  } catch (e) { err500(res, 'tramos', e); }
};

/* PUT /api/seguros-autofacil/:seguro/comisiones { opcion, comisiones:[{nombre,pct,iva_incluido}] } */
const setComisiones = async (req, res) => {
  try {
    const seguro = String(req.params.seguro || '').toUpperCase();
    const opcion = int(req.body?.opcion, 1, 2);
    if (!SEGUROS.includes(seguro) || !opcion) return res.status(400).json({ success: false, data: null, error: 'Seguro u opción inválidos' });
    const com = (Array.isArray(req.body?.comisiones) ? req.body.comisiones : [])
      .map(c => ({ n: String(c.nombre || '').trim().slice(0, 120), p: num(c.pct, 0, 100), iva: c.iva_incluido ? 1 : 0 })).filter(c => c.n && c.p != null);
    await pool.query('DELETE FROM seguros_autofacil_comisiones WHERE seguro=? AND opcion=?', [seguro, opcion]);
    for (let i = 0; i < com.length; i++) await pool.query('INSERT INTO seguros_autofacil_comisiones (seguro, opcion, nombre, pct, iva_incluido, orden) VALUES (?,?,?,?,?,?)', [seguro, opcion, com[i].n, com[i].p, com[i].iva, i]);
    await pool.query('UPDATE seguros_autofacil SET updated_by=?, updated_at=NOW() WHERE seguro=?', [quien(req), seguro]);
    motor.invalidar();
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'seguros_autofacil', entidad_id: seguro, detalle: `Comisiones opción ${opcion} de ${seguro}: ${com.map(c => `${c.n} ${c.p}%`).join(' · ') || 'ninguna'}` });
    res.json({ success: true, data: await motor.cargar(true), error: null });
  } catch (e) { err500(res, 'comisiones', e); }
};

module.exports = { listar, prima, actualizar, setTramos, setComisiones };
