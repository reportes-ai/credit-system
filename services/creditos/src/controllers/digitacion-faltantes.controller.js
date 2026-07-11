'use strict';
/**
 * Cola de "Digitación de Datos Faltantes" — créditos que quedaron incompletos
 * por la carga masiva (Trinidad/Autofin/Unidad) y necesitan que un digitador
 * complete los campos faltantes. Pool con bloqueo: al pedir el siguiente se
 * toma el más antiguo no bloqueado y se reserva ~20 min para ese usuario, así
 * dos personas no digitan el mismo. Se procesan del más antiguo al más reciente.
 */
const pool = require('../../../../shared/config/database');
const { recalcularPorOps } = require('../utils/recalcular-mes');

const LOCK_MIN = 20;

// Todos los campos del crédito (mismo set que edición). El form los muestra
// todos; los REQUERIDOS que estén vacíos se marcan en rojo.
const CAMPOS = [
  { col:'financiera',         label:'Financiera',          tipo:'select', ops:['AUTOFACIL','AUTOFIN','UNIDAD DE CREDITO'] },
  { col:'estado',             label:'Estado',              tipo:'text'   },
  { col:'fecha_otorgado',     label:'Fecha Otorgado',      tipo:'date'   },
  { col:'mes',                label:'Mes',                 tipo:'month'  },
  { col:'ejecutivo',          label:'Ejecutivo',           tipo:'text'   },
  { col:'automotora',         label:'Dealer/Automotora',   tipo:'text'   },
  { col:'rut_dealer',         label:'RUT Dealer',          tipo:'text'   },
  { col:'vendedor',           label:'Vendedor',            tipo:'text'   },
  { col:'parque',             label:'Parque',              tipo:'text'   },
  { col:'tipo_vehiculo',      label:'Tipo Vehículo',       tipo:'text'   },
  { col:'marca',              label:'Marca',               tipo:'text'   },
  { col:'modelo',             label:'Modelo',              tipo:'text'   },
  { col:'anio',               label:'Año',                 tipo:'number' },
  { col:'patente',            label:'Patente',             tipo:'text'   },
  { col:'valor_vehiculo',     label:'Valor Vehículo',      tipo:'number', money:true },
  { col:'pie',                label:'Pie',                 tipo:'number', money:true },
  { col:'saldo_precio',       label:'Saldo Precio',        tipo:'number', money:true },
  { col:'monto_financiado',   label:'Monto Financiado',    tipo:'number', money:true },
  { col:'plazo',              label:'Plazo (cuotas)',       tipo:'number' },
  { col:'tascli_real',        label:'Tasa Mensual (%)',     tipo:'decimal', pct:true },
  { col:'cuota',              label:'Cuota',               tipo:'number', money:true },
  { col:'fecha_primera_cuota',label:'Fecha 1ª Cuota',      tipo:'date'   },
  { col:'seguros',            label:'Primas de Seguro',    tipo:'number', money:true },
  { col:'comdea_real',        label:'Comisión Dealer',     tipo:'number', money:true },
  { col:'com_parque',         label:'Comisión Parque',     tipo:'number', money:true },
  { col:'monto_comision_fin', label:'Comisión Financiera', tipo:'number', money:true },
  { col:'gastos',             label:'Gastos Op.',          tipo:'number', money:true },
  { col:'tipo_ubicacion',     label:'Parque / Calle',      tipo:'select', ops:['PARQUE','CALLE'] },
  { col:'id_financiera',      label:'ID Financiera',       tipo:'text'   },
  { col:'observaciones',      label:'Observaciones',       tipo:'text'   },
];

// Campos obligatorios que definen si un crédito está "incompleto" (entra a la cola).
// NO se piden: 'cuota' (se calcula sola con la fórmula francesa desde monto/tasa/plazo) ni
// 'seguros' (opcional — 0 es válido; además el agregado suele venir nulo aunque los seguros
// individuales estén cargados, lo que generaba un falso "primas falta").
const REQUERIDOS = {
  otorgados: ['fecha_otorgado','fecha_primera_cuota','tascli_real','plazo',
              'automotora','rut_dealer','vendedor','id_financiera',
              'tipo_vehiculo','marca','modelo','anio','patente'],
  // 'otros' (no otorgados): tasa y plazo NO son requeridos — un rechazado/desistido sin
  // tasa no participa en ningún cálculo de ingresos (decisión 2026-07-11, equivale a "S/I").
  otros:     ['automotora','rut_dealer'],
};
const CAMPO = Object.fromEntries(CAMPOS.map(c => [c.col, c]));

/* ── Migración: columnas de bloqueo del pool ────────────────────────────── */
require('../../../../shared/migrate').enFila('digitacion-faltantes', async () => {
  for (const ddl of [
    `ALTER TABLE creditos ADD COLUMN digit_lock_por    INT          NULL`,
    `ALTER TABLE creditos ADD COLUMN digit_lock_nombre VARCHAR(150) NULL`,
    `ALTER TABLE creditos ADD COLUMN digit_lock_at     DATETIME     NULL`,
  ]) { try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[digit-faltantes migration]', e.message); } }
  // Log de digitación (para las estadísticas de productividad)
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS digitacion_log (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      id_credito           INT NOT NULL,
      num_op               INT NULL,
      tipo                 VARCHAR(12),
      id_usuario           INT NULL,
      usuario              VARCHAR(150),
      campos_llenados      INT DEFAULT 0,
      requeridos_faltantes INT DEFAULT 0,
      fecha                DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_fecha (fecha)
    )`);
  } catch (e) { if (e.errno !== 1050) console.error('[digitacion_log migration]', e.message); }
  for (const ddl of [
    `ALTER TABLE digitacion_log ADD COLUMN accion   VARCHAR(12) DEFAULT 'guardar'`,  // guardar | saltar
    `ALTER TABLE digitacion_log ADD COLUMN segundos INT NULL`,                        // desde que cayó hasta grabar
  ]) { try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[digitacion_log alter]', e.message); } }
});

/* ── Construcción del WHERE de pendientes ───────────────────────────────── */
function estadoCond(tipo) {
  return tipo === 'otorgados'
    ? `ob.estado_eval = 'OTORGADO'`
    : `(ob.estado_eval IS NULL OR ob.estado_eval <> 'OTORGADO')`;
}
function colVacioSQL(col) {
  const c = CAMPO[col] || {};
  if (col === 'seguros') return `(ob.${col} IS NULL)`;                       // 0 = sin seguro, válido
  if (col === 'anio')    return `(ob.${col} IS NULL)`;                       // 0 = "S/I", válido
  if (c.tipo === 'text' || c.tipo === 'select') return `(ob.${col} IS NULL OR ob.${col} = '')`;
  if (c.tipo === 'date' || c.tipo === 'month')  return `(ob.${col} IS NULL)`;
  return `(ob.${col} IS NULL OR ob.${col} = 0)`;                            // number/decimal
}
function faltanteCond(tipo) {
  const reqs = REQUERIDOS[tipo] || REQUERIDOS.otros;
  return '(' + reqs.map(colVacioSQL).join(' OR ') + ')';
}
function pendingWhere(tipo) {
  return `
    ob.estado_eval <> 'ANULADO'
    AND (ob.estado_credito IS NULL OR ob.estado_credito <> 'ANULADO')
    AND ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO')
    AND NOT EXISTS (SELECT 1 FROM meses_cerrados mc WHERE mc.mes = DATE_FORMAT(ob.mes,'%Y-%m') AND mc.cerrado = 1)
    AND ${estadoCond(tipo)}
    AND ${faltanteCond(tipo)}`;
}

function esVacio(col, v) {
  if (v === null || v === undefined) return true;
  const c = CAMPO[col] || {};
  if (col === 'seguros') return false;
  if (col === 'anio') return false;   // 0 = "S/I" (backfill jun-2026 hacia atrás): cuenta como completado
  if (c.tipo === 'text' || c.tipo === 'select') return String(v).trim() === '';
  if (c.tipo === 'date' || c.tipo === 'month') return false;
  return Number(v) === 0;
}
const errSrv = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success:false, data:null, error:'Error interno del servidor' }); };

/* ── GET /conteo → { otorgados, otros } ─────────────────────────────────── */
exports.conteo = async (req, res) => {
  try {
    const out = {};
    for (const tipo of ['otorgados','otros']) {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) n FROM creditos ob WHERE ${pendingWhere(tipo)}`);
      out[tipo] = n;
    }
    res.json({ success:true, data: out, error:null });
  } catch (e) { errSrv(res, e, 'digit conteo'); }
};

/* ── GET /siguiente?tipo= → reclama y devuelve el más antiguo pendiente ──── */
exports.siguiente = async (req, res) => {
  try {
    const tipo = req.query.tipo === 'otros' ? 'otros' : 'otorgados';
    const uid = req.usuario.id_usuario;
    const nombre = ((req.usuario.nombre||'') + ' ' + (req.usuario.apellido||'')).trim() || req.usuario.email || ('U' + uid);

    // No acumular: liberar cualquier bloqueo previo de este usuario.
    await pool.query(`UPDATE creditos SET digit_lock_por=NULL, digit_lock_nombre=NULL, digit_lock_at=NULL WHERE digit_lock_por=?`, [uid]);

    // Saltados en esta sesión: no volver a ofrecerlos (si no, "Saltar" gira en círculo).
    const excluir = String(req.query.excluir || '').split(',').map(Number).filter(n => n > 0).slice(0, 300);
    const exSQL = excluir.length ? ` AND ob.id NOT IN (${excluir.join(',')})` : '';

    // Claim atómico del más antiguo no bloqueado (o con bloqueo vencido).
    let id = null;
    for (let i = 0; i < 8 && !id; i++) {
      const [[cand]] = await pool.query(`
        SELECT ob.id FROM creditos ob
        WHERE ${pendingWhere(tipo)}${exSQL}
          AND (ob.digit_lock_por IS NULL OR ob.digit_lock_at < (NOW() - INTERVAL ${LOCK_MIN} MINUTE))
        ORDER BY COALESCE(ob.fecha_otorgado, ob.mes, ob.created_at) ASC, ob.id ASC
        LIMIT 1`);
      if (!cand) break;
      const [r] = await pool.query(`
        UPDATE creditos SET digit_lock_por=?, digit_lock_nombre=?, digit_lock_at=NOW()
        WHERE id=? AND (digit_lock_por IS NULL OR digit_lock_at < (NOW() - INTERVAL ${LOCK_MIN} MINUTE))`,
        [uid, nombre, cand.id]);
      if (r.affectedRows === 1) id = cand.id;
    }

    const [[{ n: pendientes }]] = await pool.query(`SELECT COUNT(*) n FROM creditos ob WHERE ${pendingWhere(tipo)}`);
    if (!id) return res.json({ success:true, data:{ credito:null, pendientes, tipo }, error:null });

    const cols = CAMPOS.map(c => `ob.${c.col}`).join(', ');
    const [[cr]] = await pool.query(`
      SELECT ob.id, ob.num_op,
             COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR)) AS numero_credito,
             COALESCE(cl.rut,'') AS rut_cliente, COALESCE(cl.nombre_completo,'') AS nombre_cliente,
             ${cols}
      FROM creditos ob LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
      WHERE ob.id = ?`, [id]);

    // Normalizar fechas a YYYY-MM-DD / YYYY-MM para los inputs
    for (const c of CAMPOS) {
      if (cr[c.col] instanceof Date) {
        const d = cr[c.col];
        const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        cr[c.col] = c.tipo === 'month' ? iso.slice(0,7) : iso;
      }
    }
    const reqs = REQUERIDOS[tipo];
    const faltantes = reqs.filter(c => esVacio(c, cr[c]));
    res.json({ success:true, data:{ credito:cr, campos:CAMPOS, requeridos:reqs, faltantes, pendientes, tipo }, error:null });
  } catch (e) { errSrv(res, e, 'digit siguiente'); }
};

/* ── POST /:id → guardar campos y liberar el bloqueo ────────────────────── */
exports.guardar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const campos = req.body && req.body.campos;
    const tipo = (req.body && req.body.tipo === 'otros') ? 'otros' : 'otorgados';
    if (!id || !campos || typeof campos !== 'object')
      return res.status(400).json({ success:false, data:null, error:'Datos inválidos' });

    const valid = new Set(CAMPOS.map(c => c.col));
    const [[antes]] = await pool.query(
      `SELECT num_op, TIMESTAMPDIFF(SECOND, digit_lock_at, NOW()) AS lock_seg, ${CAMPOS.map(c => c.col).join(', ')} FROM creditos WHERE id=?`, [id]);
    if (!antes) return res.status(404).json({ success:false, data:null, error:'Crédito no encontrado' });

    const sets = [], vals = [], cambios = [];
    for (const [col, raw] of Object.entries(campos)) {
      if (!valid.has(col)) continue;
      const v = (raw === '' || raw === undefined) ? null : raw;
      // No pisar un dato existente con vacío: si el form llegó con el campo en blanco
      // pero la BD ya tiene valor (ej. lo llenó una carga posterior), se conserva.
      if (v === null && antes[col] != null && String(antes[col]) !== '') continue;
      sets.push(`\`${col}\` = ?`); vals.push(v);
      if (String(antes[col] ?? '') !== String(v ?? '')) cambios.push({ col, antes: antes[col], despues: v });
    }
    const usuario = ((req.usuario.nombre||'') + ' ' + (req.usuario.apellido||'')).trim() || req.usuario.email || '';
    if (sets.length) {
      vals.push(id);
      await pool.query(`UPDATE creditos SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`, vals);
      for (const c of cambios) {
        pool.query(`INSERT INTO creditos_edicion_log (id_credito, num_op, usuario, campo, valor_antes, valor_despues)
                    VALUES (?, ?, ?, ?, ?, ?)`,
          [id, antes.num_op, usuario, c.col, c.antes == null ? null : String(c.antes), c.despues == null ? null : String(c.despues)]).catch(() => {});
      }
    }

    // Métrica: requeridos faltantes, completados y tiempo (desde que cayó hasta grabar).
    const reqs = REQUERIDOS[tipo];
    const faltAntes = reqs.filter(c => esVacio(c, antes[c]));
    const llenados = faltAntes.filter(c => !esVacio(c, campos[c] === '' ? null : campos[c])).length;
    const seg = (antes.lock_seg != null && antes.lock_seg >= 0 && antes.lock_seg < 7200) ? antes.lock_seg : null;  // cap 2h
    pool.query(`INSERT INTO digitacion_log (id_credito, num_op, tipo, id_usuario, usuario, campos_llenados, requeridos_faltantes, accion, segundos)
                VALUES (?,?,?,?,?,?,?, 'guardar', ?)`,
      [id, antes.num_op, tipo, req.usuario.id_usuario, usuario, llenados, faltAntes.length, seg]).catch(() => {});

    await pool.query(`UPDATE creditos SET digit_lock_por=NULL, digit_lock_nombre=NULL, digit_lock_at=NULL WHERE id=?`, [id]);
    // Cuota francesa: se calcula sola (motor único rentabilidad-core) si quedó vacía
    // y ya hay monto + tasa + plazo. Nunca pisa una cuota existente.
    if (sets.length) {
      try {
        const [[d]] = await pool.query('SELECT monto_financiado, tascli_real, plazo, cuota FROM creditos WHERE id=?', [id]);
        if (d && !(Number(d.cuota) > 0) && Number(d.monto_financiado) > 0 && Number(d.tascli_real) > 0 && Number(d.plazo) > 0) {
          const core = require('../../../../api-gateway/public/js/rentabilidad-core');
          const c = Math.round(core.cuotaFrancesa(Number(d.monto_financiado), Number(d.tascli_real) / 100, Number(d.plazo)));
          if (c > 0) await pool.query('UPDATE creditos SET cuota=? WHERE id=?', [c, id]);
        }
      } catch (e) { console.error('[digit cuota francesa]', e.message); }
    }
    // Recalcular el mes tras completar datos faltantes (comisiones/ingresos) — automático.
    if (sets.length) recalcularPorOps(id).catch(e => console.error('[recalc digitacion]', e.message));
    res.json({ success:true, data:{ id, cambios: cambios.length, llenados, faltantes: faltAntes.length }, error:null });
  } catch (e) { errSrv(res, e, 'digit guardar'); }
};

/* ── POST /:id/liberar → soltar el bloqueo (saltar/salir) ────────────────── */
exports.liberar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (req.query.motivo === 'saltar') {   // "Saltar este" → registrar el salto
      const tipo = req.query.tipo === 'otros' ? 'otros' : 'otorgados';
      const usuario = ((req.usuario.nombre||'') + ' ' + (req.usuario.apellido||'')).trim() || req.usuario.email || '';
      pool.query(`INSERT INTO digitacion_log (id_credito, num_op, tipo, id_usuario, usuario, campos_llenados, requeridos_faltantes, accion)
                  SELECT id, num_op, ?, ?, ?, 0, 0, 'saltar' FROM creditos WHERE id=?`,
        [tipo, req.usuario.id_usuario, usuario, id]).catch(() => {});
    }
    await pool.query(`UPDATE creditos SET digit_lock_por=NULL, digit_lock_nombre=NULL, digit_lock_at=NULL WHERE id=? AND digit_lock_por=?`,
      [id, req.usuario.id_usuario]);
    res.json({ success:true, data:{ id }, error:null });
  } catch (e) { errSrv(res, e, 'digit liberar'); }
};

/* ── GET /dealer-buscar?q= → RUT y Parque/Calle del dealer por nombre ────── */
exports.dealerBuscar = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success:true, data:[], error:null });
    const like = '%' + q + '%';
    const qd = q.replace(/\D/g, '');                 // dígitos del RUT/número buscado
    // Sin filtro por `activo`: se muestran TODOS los dealers (activo es marcador de operación
    // reciente, no habilitación). RUT se compara por dígitos (ignora puntos y guion).
    const cond = ['nombre_indexa LIKE ?', 'nombre_razon LIKE ?', 'numero LIKE ?'];
    const params = [like, like, like];
    if (qd.length >= 3) { cond.push("REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','') LIKE ?"); params.push('%' + qd + '%'); }
    else { cond.push('rut LIKE ?'); params.push(like); }
    const [rows] = await pool.query(
      `SELECT numero, rut, nombre_indexa, nombre_razon, ccs_parque, activo
       FROM dealers
       WHERE (${cond.join(' OR ')})
       ORDER BY activo DESC, nombre_indexa LIMIT 20`, params);
    const data = rows.map(r => {
      const t = String(r.ccs_parque || '').toUpperCase();
      return { numero: r.numero, rut: r.rut, nombre: r.nombre_indexa || r.nombre_razon || '',
               activo: r.activo, tipo: t.includes('PARQUE') ? 'PARQUE' : (t ? 'CALLE' : '') };
    });
    res.json({ success:true, data, error:null });
  } catch (e) { errSrv(res, e, 'digit dealerBuscar'); }
};

/* ── GET /estadisticas?dias=30 → productividad de digitación ─────────────── */
const PERFILES_STATS = ['Administrador', 'Supervisor de Crédito', 'Supervisor de Credito'];
exports.estadisticas = async (req, res) => {
  try {
    const perfil = req.usuario.perfil_nombre || req.usuario.perfil || '';
    if (!PERFILES_STATS.includes(perfil))
      return res.status(403).json({ success:false, data:null, error:'Solo Administrador / Supervisor de Crédito' });
    const dias = Math.min(365, Math.max(1, parseInt(req.query.dias) || 30));
    const pct  = t => (Number(t.faltantes) > 0 ? Math.round((t.llenados / t.faltantes) * 1000) / 10 : 0);
    const segp = t => (t.seg_prom != null ? Math.round(Number(t.seg_prom)) : null);
    // Agregados condicionales: 'guardar' cuenta como digitado; 'saltar' como salto.
    const AGG = `
      COUNT(DISTINCT CASE WHEN accion='guardar' THEN id_credito END)        AS creditos,
      SUM(CASE WHEN accion='guardar' THEN campos_llenados      ELSE 0 END)  AS llenados,
      SUM(CASE WHEN accion='guardar' THEN requeridos_faltantes ELSE 0 END)  AS faltantes,
      SUM(CASE WHEN accion='saltar'  THEN 1 ELSE 0 END)                     AS saltos,
      AVG(CASE WHEN accion='guardar' THEN segundos END)                     AS seg_prom`;

    const [porDia] = await pool.query(
      `SELECT DATE(fecha) dia, ${AGG} FROM digitacion_log WHERE fecha >= (NOW() - INTERVAL ? DAY)
       GROUP BY DATE(fecha) ORDER BY dia DESC`, [dias]);
    const [porUsuario] = await pool.query(
      `SELECT usuario, ${AGG} FROM digitacion_log WHERE fecha >= (NOW() - INTERVAL ? DAY)
       GROUP BY usuario ORDER BY creditos DESC`, [dias]);
    const [[r0]] = await pool.query(
      `SELECT ${AGG}, COUNT(DISTINCT CASE WHEN accion='guardar' THEN DATE(fecha) END) dias_activos
       FROM digitacion_log WHERE fecha >= (NOW() - INTERVAL ? DAY)`, [dias]);

    res.json({ success:true, data: {
      dias,
      resumen: {
        creditos: Number(r0.creditos) || 0,
        pct_completado: pct(r0),
        promedio_dia: r0.dias_activos ? Math.round((r0.creditos / r0.dias_activos) * 10) / 10 : 0,
        saltos: Number(r0.saltos) || 0,
        seg_prom: segp(r0),
      },
      porDia: porDia.map(d => ({ dia: d.dia, creditos: d.creditos, pct: pct(d), llenados: Number(d.llenados)||0, faltantes: Number(d.faltantes)||0, saltos: Number(d.saltos)||0, seg_prom: segp(d) })),
      porUsuario: porUsuario.map(u => ({ usuario: u.usuario, creditos: u.creditos, pct: pct(u), saltos: Number(u.saltos)||0, seg_prom: segp(u) })),
    }, error:null });
  } catch (e) { errSrv(res, e, 'digit estadisticas'); }
};
