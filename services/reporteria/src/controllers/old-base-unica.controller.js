'use strict';
/* ───────────────────────────────────────────────────────────────────
   OLD BASE ÚNICA — réplica read-only de la hoja DETALLE del antiguo
   "CONTROL CREDITOS INGRESADOS OPERACIONES EN LINEA" (base única Excel),
   alimentada 100% desde nuestra BD (creditos + clientes + dealers).
   Universo: todas las operaciones desde la op 77130 (inicio de la base vieja).
   ─────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

/* ─── Seed paramétrico: card DENTRO de Reportería (v101.0; antes módulo propio,
       retirado — la funcionalidad se re-cuelga del módulo Reportería) ── */
require('../../../../shared/migrate').enFila('old-base-unica', async () => {
  try {
    const [[rep]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/reporteria/' LIMIT 1");
    if (!rep) return;
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='old_base_unica_ver'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [insF] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [rep.id_modulo, 'Old Base Única', 'old_base_unica_ver', '/old-base-unica/', 'bi-table']);
      idF = insF.insertId;
    } else {
      await pool.query("UPDATE funcionalidades SET id_modulo=?, nombre='Old Base Única', href='/old-base-unica/', icono='bi-table' WHERE id_funcionalidad=?", [rep.id_modulo, idF]);
    }
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    // Retirar el módulo propio de la frontpage (queda inactivo, no se borra)
    await pool.query("UPDATE modulos SET estado='inactivo' WHERE ruta='/old-base-unica/'");
    console.log('✓ Old Base Única colgada de Reportería');
  } catch (e) { console.error('[old-base-unica seed]', e.message); }
});

/* Columnas en el mismo orden de la hoja DETALLE (solo las que existen en BD).
   [encabezado visible, alias SQL] */
const COLS = [
  ['OP','num_op'], ['MES','mes'], ['RUT','rut'], ['NOMBRE','nombre'],
  ['COMENTARIOS','comentarios'], ['EJ.COMERCIAL','ejecutivo'], ['FINANCIERA','financiera'],
  ['AUTOMOTORA','automotora'], ['ESTADO EVAL. RIESGO','estado_eval'], ['FECHA ESTADO','fecha_estado'],
  ['ESTADO CREDITO','estado_credito'], ['FECHA OTORGADO','fecha_otorgado'], ['PRODUCTO','producto'],
  ['VALOR VEHICULO','valor_vehiculo'], ['PIE','pie'], ['SALDO PRECIO','saldo_precio'],
  ['% FINANCIADO','pct_financiado'], ['IMPUESTO','impuesto'], ['ESTADO IMPTO','estado_impuesto'],
  ['LIMITACION','limitacion'], ['GASTOS','gastos'], ['GPS','gps'],
  ['SEGURO RDH+E','seguro_rdh'], ['SEG.CESANTIA','seguro_cesantia'], ['SEG. REP MENOR','seguro_rep_menor'],
  ['FECHA RECEPCION FEI','fecha_recep_fei'], ['FECHA DE PAGO SALDO PRECIO','fecha_pago_sp'], ['ESTADO SP','estado_sp'],
  ['MONTO FINANCIADO','monto_financiado'], ['TASCLI REAL','tascli_real'], ['TASCLI PIZARRA','tascli_pizarra'],
  ['TASA PISO','tasa_piso'], ['TASFIN PIZARRA','tasfin_pizarra'],
  ['COMDEA $ REAL','comdea_real'], ['COMDEA PIZARRA $','comdea_pizarra'], ['COMEJ $','comej'],
  ['RENTABILIDAD AF DIRECTO','rentabilidad_af_directo'], ['FECHA ESTIM. PAGO COMAF','fecha_estim_pago_comaf'],
  ['STATUS COMAF','status_comaf'], ['ESTADO COM DEALER','estado_com_dealer'], ['ESTADO PAGO COM','estado_pago_com'],
  ['FECHA PAGO COM DEALER','fecha_pago_com_dealer'], ['N° FACTURA COM DEA.','nro_factura_com_dea'],
  ['MONTO COMISION FINAN.','monto_comision_fin'], ['PLAZO','plazo'], ['COMISION SEGURO','comision_seguro'],
  ['PARQUE','parque'], ['COM PARQUE','com_parque'], ['ARRIENDO PARQUE','arriendo_parque'],
  ['INGRESO NETO TOTAL AF','ingreso_neto_total'], ['RESULTADO NEGOCIO','resultado_negocio'],
  ['PEN. RDH','pen_rdh'], ['PEN. CESANTIA','pen_cesantia'], ['PEN. REPARACIONES','pen_reparaciones'],
  ['COM.RDH','com_rdh'], ['COM.CESANTIA','com_cesantia'], ['COM.REPARACIONES','com_reparaciones'],
  ['MAYOR/MENOR','mayor_menor'], ['MONTO CAPITALIZADO','monto_capitalizado'],
  ['FECHA PRIMERA CUOTA','fecha_primera_cuota'], ['ID FINANCIERA','id_financiera'],
  ['MAYOR A MM$30','mayor_mm30'], ['BONO BASE','bono_base'], ['BONO SEG. CESANTIA','bono_seg_cesantia'],
  ['BONO SEG. REP MENORES','bono_seg_rep_menores'], ['BONO TOTAL','bono_total'],
  ['BOLETA/FACTURA','boleta_factura'], ['CON FACT O BOLETA','con_fact_boleta'],
  ['CANTIDAD DOCUMENTOS','cantidad_docs'], ['DOCUMENTOS AUTORIZADOS','docs_autorizados'],
  ['FECHA RECEPCION DOCUMENTO','fecha_recep_doc'], ['COMISION CARTA','comision_carta'],
  ['PREPAGO','prepago'], ['ANULACION','anulacion'], ['NOMBRE LOCAL','nombre_local'],
];

/* Columnas que el frontend formatea como monto/porcentaje */
const COLS_MONTO = ['valor_vehiculo','pie','saldo_precio','impuesto','gastos','gps','seguro_rdh','seguro_cesantia',
  'seguro_rep_menor','monto_financiado','comdea_real','comdea_pizarra','comej','rentabilidad_af_directo',
  'monto_comision_fin','comision_seguro','com_parque','arriendo_parque','ingreso_neto_total','resultado_negocio',
  'com_rdh','com_cesantia','com_reparaciones','monto_capitalizado','bono_base','bono_seg_cesantia',
  'bono_seg_rep_menores','bono_total','comision_carta'];
const COLS_PCT = ['pct_financiado','tascli_real','tascli_pizarra','tasa_piso','tasfin_pizarra',
  'pen_rdh','pen_cesantia','pen_reparaciones'];

/* ─── GET /api/old-base-unica ─ dataset completo (filas como arrays) ── */
const getDatos = async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.num_op, DATE_FORMAT(c.mes,'%Y-%m-%d') mes, cl.rut,
        COALESCE(NULLIF(TRIM(cl.nombre_completo),''),
                 TRIM(CONCAT(IFNULL(cl.nombres,''),' ',IFNULL(cl.apellido_paterno,''),' ',IFNULL(cl.apellido_materno,'')))) nombre,
        c.comentarios, c.ejecutivo, c.financiera,
        COALESCE(NULLIF(d.nombre_razon,''), NULLIF(d.nombre_indexa,''), c.automotora) automotora,
        c.estado_eval, DATE_FORMAT(c.fecha_estado,'%Y-%m-%d') fecha_estado, c.estado_credito,
        DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') fecha_otorgado, c.producto,
        c.valor_vehiculo, c.pie, c.saldo_precio, c.pct_financiado, c.impuesto, c.estado_impuesto,
        c.limitacion, c.gastos, c.gps, c.seguro_rdh, c.seguro_cesantia, c.seguro_rep_menor,
        DATE_FORMAT(c.fecha_recep_fei,'%Y-%m-%d') fecha_recep_fei, DATE_FORMAT(c.fecha_pago_sp,'%Y-%m-%d') fecha_pago_sp, c.estado_sp,
        c.monto_financiado, c.tascli_real, c.tascli_pizarra, c.tasa_piso, c.tasfin_pizarra,
        c.comdea_real, c.comdea_pizarra, c.comej, c.rentabilidad_af_directo,
        DATE_FORMAT(c.fecha_estim_pago_comaf,'%Y-%m-%d') fecha_estim_pago_comaf, c.status_comaf,
        c.estado_com_dealer, c.estado_pago_com, DATE_FORMAT(c.fecha_pago_com_dealer,'%Y-%m-%d') fecha_pago_com_dealer,
        c.nro_factura_com_dea, c.monto_comision_fin, c.plazo, c.comision_seguro,
        c.parque, c.com_parque, c.arriendo_parque, c.ingreso_neto_total, c.resultado_negocio,
        c.pen_rdh, c.pen_cesantia, c.pen_reparaciones, c.com_rdh, c.com_cesantia, c.com_reparaciones,
        c.mayor_menor, c.monto_capitalizado, DATE_FORMAT(c.fecha_primera_cuota,'%Y-%m-%d') fecha_primera_cuota,
        c.id_financiera, c.mayor_mm30, c.bono_base, c.bono_seg_cesantia, c.bono_seg_rep_menores, c.bono_total,
        c.boleta_factura, c.con_fact_boleta, c.cantidad_docs, c.docs_autorizados,
        DATE_FORMAT(c.fecha_recep_doc,'%Y-%m-%d') fecha_recep_doc, c.comision_carta,
        c.prepago, c.anulacion, c.nombre_local
      FROM creditos c
      LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      LEFT JOIN dealers d ON d.id_dealer = c.id_dealer
      WHERE c.num_op >= 77130
      ORDER BY c.num_op
      LIMIT 50000`);   // LIMIT defensivo: evita timeout si la tabla crece
    const keys = COLS.map(c => c[1]);
    const data = rows.map(r => keys.map(k => r[k] ?? null));
    res.json({ success: true, data: {
      headers: COLS.map(c => c[0]), keys,
      montos: COLS_MONTO, pcts: COLS_PCT, rows: data,
    }, error: null });
  } catch (e) {
    console.error('[old-base-unica getDatos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al cargar la base' });
  }
};

module.exports = { getDatos };
