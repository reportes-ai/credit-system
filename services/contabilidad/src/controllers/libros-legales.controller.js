'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   LIBROS LEGALES Y EXPORTABLES (/contabilidad/libros-legales/) — Pato, 14-09-2026
   Un solo lugar para los documentos que piden auditores y fiscalizadores (SII, DT,
   Previred, CMF, auditoría externa). Cada libro se genera desde su FUENTE ÚNICA,
   sale en Excel y queda registrado en `libros_legales_log` con quién lo generó,
   cuándo, filas, totales y el SHA-256 del archivo: en una auditoría se prueba que el
   archivo entregado es el que salió del sistema.

   Catálogo PARAMÉTRICO (LIBROS): los que aún no tienen motor aparecen como
   "próximamente" en la pantalla — el orden de construcción lo decide el negocio.

   Libro 1: REMUNERACIONES POR PERSONA (mensual). Fuente: liquidaciones EMITIDAS del
   motor propio (rh_liquidaciones); si el mes se pagó por AVSOFT, el auxiliar
   importado ctb_remun_aux (con la apertura del imponible desde v241.4). Mismo criterio
   de cascada que el LRE y la base del finiquito.
   ───────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const XLSX = require('xlsx');
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const R = v => Math.round(Number(v) || 0);
const nRut = r => String(r || '').replace(/\./g, '').replace(/\s/g, '').toUpperCase();

/* Catálogo: codigo, nombre, fiscalizador, periodicidad, disponible (tiene motor) */
const LIBROS = [
  { codigo: 'REMUNERACIONES', nombre: 'Libro de Remuneraciones por persona', fiscalizador: 'DT · SII · Previred', periodo: 'mes', disponible: 1,
    descripcion: 'Una fila por trabajador: días, haberes imponibles abiertos (sueldo, comisiones, semana corrida, gratificación, otros), no imponibles, cotizaciones, impuesto único, otros descuentos, líquido y aportes del empleador. Con totales y hash.' },
  { codigo: 'LRE', nombre: 'LRE — Libro de Remuneraciones Electrónico', fiscalizador: 'Dirección del Trabajo', periodo: 'mes', disponible: 1, href: '/contabilidad/lre/',
    descripcion: 'Formato oficial del Manual LRE (CSV). Ya existe: se abre en su propia pantalla.' },
  { codigo: 'DIARIO', nombre: 'Libro Diario', fiscalizador: 'SII · Auditoría', periodo: 'rango', disponible: 1, href: '/contabilidad/libros/',
    descripcion: 'Ya existe en Libros Contables (Excel).' },
  { codigo: 'MAYOR', nombre: 'Libro Mayor', fiscalizador: 'SII · Auditoría', periodo: 'rango', disponible: 1, href: '/contabilidad/libros/',
    descripcion: 'Ya existe en Libros Contables (Excel).' },
  { codigo: 'BALANCE_8', nombre: 'Balance de 8 columnas', fiscalizador: 'SII · Auditoría', periodo: 'año', disponible: 0 },
  { codigo: 'EERR', nombre: 'Balance general y Estado de Resultados', fiscalizador: 'SII · Auditoría', periodo: 'año', disponible: 1, href: '/contabilidad/estados/',
    descripcion: 'Ya existe en Estados Financieros.' },
  { codigo: 'HONORARIOS', nombre: 'Libro de Honorarios', fiscalizador: 'SII', periodo: 'mes', disponible: 1, href: '/contabilidad/libros-auxiliares/',
    descripcion: 'Ya existe en Libros Auxiliares.' },
  { codigo: 'F29', nombre: 'Borrador F29', fiscalizador: 'SII', periodo: 'mes', disponible: 1, href: '/contabilidad/f29/', descripcion: 'Ya existe.' },
  { codigo: 'DJ', nombre: 'Declaraciones Juradas 1879 / 1887', fiscalizador: 'SII', periodo: 'año', disponible: 1, href: '/declaraciones-juradas/', descripcion: 'Ya existe.' },
  { codigo: 'PREVIRED', nombre: 'Archivo Previred', fiscalizador: 'Previred · AFP', periodo: 'mes', disponible: 1, href: '/recursos-humanos/remuneraciones/liquidaciones/', descripcion: 'Ya existe en Remuneraciones.' },
  { codigo: 'VACACIONES', nombre: 'Registro de feriados por trabajador', fiscalizador: 'Dirección del Trabajo', periodo: 'año', disponible: 0 },
  { codigo: 'ASISTENCIA', nombre: 'Registro de asistencia (Workera)', fiscalizador: 'Dirección del Trabajo', periodo: 'mes', disponible: 0 },
  { codigo: 'CARTERA_TMC', nombre: 'Cartera vigente con tasas vs TMC', fiscalizador: 'CMF · SERNAC', periodo: 'mes', disponible: 0 },
  { codigo: 'COBRANZA', nombre: 'Mora y gastos de cobranza por operación', fiscalizador: 'SERNAC', periodo: 'mes', disponible: 0 },
  { codigo: 'CARPETA', nombre: 'Carpeta de auditoría (ZIP del ejercicio)', fiscalizador: 'Auditoría externa', periodo: 'año', disponible: 0 },
];

require('../../../../shared/migrate').enFila('contabilidad-libros-legales', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS libros_legales_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      libro VARCHAR(30) NOT NULL, periodo VARCHAR(10) NOT NULL, fuente VARCHAR(20) NULL,
      archivo VARCHAR(120) NULL, filas INT NOT NULL DEFAULT 0,
      total_1 DECIMAL(16,0) NULL, total_2 DECIMAL(16,0) NULL,
      sha256 CHAR(64) NOT NULL, generado_por VARCHAR(160) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_libro (libro, periodo))`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_libros_legales' LIMIT 1");
    let idf = ex?.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Libros Legales y Exportables','ctb_libros_legales','/contabilidad/libros-legales/','bi-journal-bookmark-fill')");
      idf = r.insertId;
    }
    // Mismos perfiles que el LRE (Administrador + contabilidad/tesorería)
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] libros legales listo');
  } catch (e) { console.error('[contabilidad-libros-legales migration]', e.message); }
});

/* ── Libro de Remuneraciones por persona: filas normalizadas (MOTOR o AVSOFT) ── */
const COLS_REM = [
  ['rut', 'RUT'], ['nombre', 'Nombre'], ['cargo', 'Cargo'], ['tipo_contrato', 'Contrato'], ['fecha_ingreso', 'F. ingreso'], ['dias', 'Días'],
  ['sueldo_base', 'Sueldo base'], ['comisiones', 'Comisiones'], ['semana_corrida', 'Semana corrida'], ['gratificacion', 'Gratificación'], ['otros_imponibles', 'Otros imponibles'], ['total_imponible', 'TOTAL IMPONIBLE'],
  ['colacion', 'Colación'], ['movilizacion', 'Movilización'], ['otros_no_imponibles', 'Otros no imponibles'], ['total_haberes', 'TOTAL HABERES'],
  ['afp', 'AFP'], ['desc_afp', 'Cotización AFP'], ['salud', 'Salud'], ['desc_salud', 'Salud 7%'], ['desc_salud_adicional', 'Adicional Isapre'], ['desc_afc', 'AFC trabajador'], ['impuesto', 'Impuesto único'], ['otros_descuentos', 'Otros descuentos'], ['total_descuentos', 'TOTAL DESCUENTOS'],
  ['liquido', 'LÍQUIDO'],
  ['aporte_sis', 'SIS empleador'], ['aporte_afc_emp', 'AFC empleador'], ['aporte_mutual', 'Mutual + SANNA'], ['costo_empresa', 'COSTO EMPRESA'],
];
const NUM = new Set(COLS_REM.map(c => c[0]).filter(k => !['rut', 'nombre', 'cargo', 'tipo_contrato', 'fecha_ingreso', 'afp', 'salud'].includes(k)));

async function filasRemuneraciones(mes) {
  // Fechas DATE de la base: SIEMPRE isoDeBD (gotcha del offset del pool: 21-04 salía 20-04)
  const isoF = f => f == null ? '' : (require('../../../../shared/fecha-chile').isoDeBD(f) || '');
  const [liqs] = await pool.query(
    `SELECT l.*, u.rut urut, u.fecha_ingreso, f.afp fafp, f.salud fsalud, f.tipo_contrato
       FROM rh_liquidaciones l JOIN usuarios u ON u.id_usuario=l.id_usuario
       LEFT JOIN rh_fichas f ON f.id_usuario=l.id_usuario
      WHERE l.mes=? AND l.estado='EMITIDA' ORDER BY l.nombre`, [mes]);
  if (liqs.length) {
    return { fuente: 'MOTOR', filas: liqs.map(l => {
      let d = {}; try { d = typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) {}
      // La semana corrida del motor viene dentro de comisiones (factor art. 45): se informa en la misma columna
      return { rut: nRut(l.rut || l.urut), nombre: l.nombre, cargo: l.cargo || '', tipo_contrato: d.tipo_contrato || l.tipo_contrato || '', fecha_ingreso: isoF(l.fecha_ingreso), dias: d.dias ?? 30,
        sueldo_base: R(d.sueldo_base), comisiones: R(d.comisiones), semana_corrida: 0, gratificacion: R(d.gratificacion),
        otros_imponibles: R(d.otros_imponibles) + R(d.feriado_variable), total_imponible: R(d.total_imponible),
        colacion: R(d.colacion), movilizacion: R(d.movilizacion), otros_no_imponibles: R(d.otros_no_imponibles), total_haberes: R(d.total_haberes),
        afp: d.afp || l.fafp || '', desc_afp: R(d.desc_afp), salud: d.salud || l.fsalud || '', desc_salud: R(d.desc_salud), desc_salud_adicional: R(d.desc_salud_adicional),
        desc_afc: R(d.desc_afc), impuesto: R(d.impuesto), otros_descuentos: R(d.otros_descuentos), total_descuentos: R(d.total_descuentos), liquido: R(d.liquido),
        aporte_sis: R(d.aporte_sis), aporte_afc_emp: R(d.aporte_afc_emp), aporte_mutual: R(d.aporte_mutual) + R(d.aporte_sanna), costo_empresa: R(d.costo_empresa) };
    }) };
  }
  const [rem] = await pool.query('SELECT * FROM ctb_remun_aux WHERE mes=? ORDER BY nombre', [mes]);
  if (!rem.length) return { fuente: null, filas: [] };
  const [usrs] = await pool.query("SELECT u.rut, u.fecha_ingreso, f.tipo_contrato FROM usuarios u LEFT JOIN rh_fichas f ON f.id_usuario=u.id_usuario WHERE u.rut IS NOT NULL");
  const uMap = {}; usrs.forEach(u => uMap[nRut(u.rut)] = u);
  return { fuente: 'AVSOFT', filas: rem.map(r => {
    const u = uMap[nRut(r.rut)] || {};
    const imponible = R(r.total_ganado) || R(r.imponible);
    const conApertura = R(r.gratificacion) + R(r.comisiones) + R(r.semana_corrida) > 0;
    const otrosImp = conApertura ? R(r.otros_imponibles) : Math.max(0, imponible - R(r.sueldo_base));
    const noImp = Math.max(0, R(r.haberes) - imponible);
    const cotiz = R(r.afp_monto) + R(r.salud_monto) + R(r.seg_ces_trab);
    const otrosDesc = Math.max(0, R(r.descuentos) - cotiz - R(r.impuesto_unico));
    const aportesOtros = R(r.aportes_emp_otros);
    return { rut: nRut(r.rut), nombre: r.nombre, cargo: r.cargo || '', tipo_contrato: u.tipo_contrato || '', fecha_ingreso: isoF(u.fecha_ingreso), dias: r.dias || 30,
      sueldo_base: R(r.sueldo_base), comisiones: R(r.comisiones), semana_corrida: R(r.semana_corrida), gratificacion: R(r.gratificacion), otros_imponibles: otrosImp, total_imponible: imponible,
      colacion: 0, movilizacion: 0, otros_no_imponibles: noImp, total_haberes: R(r.haberes),
      afp: r.afp_nombre || '', desc_afp: R(r.afp_monto), salud: r.salud_nombre || '', desc_salud: R(r.salud_legal) || R(r.salud_monto), desc_salud_adicional: R(r.salud_adicional),
      desc_afc: R(r.seg_ces_trab), impuesto: R(r.impuesto_unico), otros_descuentos: otrosDesc, total_descuentos: R(r.descuentos), liquido: R(r.liquido),
      aporte_sis: R(r.sis_emp), aporte_afc_emp: R(r.seg_ces_emp), aporte_mutual: aportesOtros, costo_empresa: R(r.haberes) + R(r.sis_emp) + R(r.seg_ces_emp) + aportesOtros };
  }) };
}
const totalesDe = filas => { const t = {}; for (const k of NUM) t[k] = filas.reduce((a, f) => a + R(f[k]), 0); return t; };

/* GET /libros-legales → catálogo + historial reciente */
exports.catalogo = async (req, res) => {
  try {
    const [log] = await pool.query('SELECT * FROM libros_legales_log ORDER BY id DESC LIMIT 50');
    ok(res, { libros: LIBROS, log });
  } catch (e) { fail(res, e.message); }
};

/* GET /libros-legales/remuneraciones?mes= → vista previa */
exports.remuneraciones = async (req, res) => {
  try {
    const mes = String(req.query.mes || '');
    if (!/^\d{4}-\d{2}$/.test(mes)) return fail(res, 'mes obligatorio (YYYY-MM)', 400);
    const { fuente, filas } = await filasRemuneraciones(mes);
    if (!filas.length) return fail(res, `No hay remuneraciones para ${mes} (ni emitidas en el motor ni importadas de AVSOFT)`, 404);
    ok(res, { mes, fuente, columnas: COLS_REM, filas, totales: totalesDe(filas) });
  } catch (e) { console.error('[libros legales rem]', e.message); fail(res, e.message); }
};

/* GET /libros-legales/remuneraciones.xlsx?mes= → Excel + registro (hash) */
exports.remuneracionesXlsx = async (req, res) => {
  try {
    const mes = String(req.query.mes || '');
    if (!/^\d{4}-\d{2}$/.test(mes)) return fail(res, 'mes obligatorio (YYYY-MM)', 400);
    const { fuente, filas } = await filasRemuneraciones(mes);
    if (!filas.length) return fail(res, `No hay remuneraciones para ${mes}`, 404);
    const [[emp]] = await pool.query('SELECT organizacion FROM credenciales_empresa WHERE id=1').catch(() => [[{}]]);
    const [[cfg]] = await pool.query("SELECT valor FROM rh_config WHERE clave='finiq_empresa'").catch(() => [[{}]]);
    const [[cfgR]] = await pool.query("SELECT valor FROM rh_config WHERE clave='finiq_rut_empresa'").catch(() => [[{}]]);
    const tot = totalesDe(filas);
    const quien = (req.usuario?.nombre ? (req.usuario.nombre + ' ' + (req.usuario.apellido || '')).trim() : req.usuario?.email) || 'Sistema';
    const generado = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' });
    const cab = [
      ['LIBRO DE REMUNERACIONES'], [cfg?.valor || emp?.organizacion || 'AUTOFÁCIL SpA', 'RUT', cfgR?.valor || ''],
      ['Período', mes, 'Fuente', fuente === 'MOTOR' ? 'Liquidaciones emitidas (Business Suite)' : 'Libro de Remuneraciones AVSOFT (auxiliar importado)'],
      ['Generado', generado, 'por', quien], [],
      COLS_REM.map(c => c[1]),
    ];
    const cuerpo = filas.map(f => COLS_REM.map(c => f[c[0]]));
    const totFila = COLS_REM.map(c => c[0] === 'nombre' ? 'TOTALES' : (NUM.has(c[0]) && c[0] !== 'dias' ? tot[c[0]] : ''));
    const ws = XLSX.utils.aoa_to_sheet([...cab, ...cuerpo, totFila]);
    ws['!cols'] = COLS_REM.map(c => ({ wch: c[0] === 'nombre' ? 34 : c[0] === 'cargo' ? 26 : 14 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, `Remuneraciones ${mes}`);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const archivo = `Libro-Remuneraciones-${mes}.xlsx`;
    await pool.query('INSERT INTO libros_legales_log (libro, periodo, fuente, archivo, filas, total_1, total_2, sha256, generado_por) VALUES (?,?,?,?,?,?,?,?,?)',
      ['REMUNERACIONES', mes, fuente, archivo, filas.length, tot.total_haberes, tot.liquido, sha, quien]);
    auditar({ req, accion: 'CREAR', modulo: 'contabilidad', entidad: 'libro_legal', detalle: `Libro de Remuneraciones ${mes} (${fuente}) ${filas.length} personas · SHA-256 ${sha.slice(0, 12)}…` });
    res.setHeader('X-SHA256', sha);
    res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) { console.error('[libros legales rem xlsx]', e.message); fail(res, e.message); }
};
