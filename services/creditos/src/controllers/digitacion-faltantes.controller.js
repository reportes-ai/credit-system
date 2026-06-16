'use strict';
/**
 * Cola de "Digitación de Datos Faltantes" — créditos que quedaron incompletos
 * por la carga masiva (Trinidad/Autofin/Unidad) y necesitan que un digitador
 * complete los campos faltantes. Pool con bloqueo: al pedir el siguiente se
 * toma el más antiguo no bloqueado y se reserva ~20 min para ese usuario, así
 * dos personas no digitan el mismo. Se procesan del más antiguo al más reciente.
 */
const pool = require('../../../../shared/config/database');

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
const REQUERIDOS = {
  otorgados: ['fecha_otorgado','fecha_primera_cuota','tascli_real','plazo','cuota','seguros',
              'automotora','rut_dealer','vendedor','id_financiera',
              'tipo_vehiculo','marca','modelo','anio','patente'],
  otros:     ['tascli_real','plazo','cuota','automotora','rut_dealer'],
};
const CAMPO = Object.fromEntries(CAMPOS.map(c => [c.col, c]));

/* ── Migración: columnas de bloqueo del pool ────────────────────────────── */
(async () => {
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
})();

/* ── Construcción del WHERE de pendientes ───────────────────────────────── */
function estadoCond(tipo) {
  return tipo === 'otorgados'
    ? `ob.estado_eval = 'OTORGADO'`
    : `(ob.estado_eval IS NULL OR ob.estado_eval <> 'OTORGADO')`;
}
function colVacioSQL(col) {
  const c = CAMPO[col] || {};
  if (col === 'seguros') return `(ob.${col} IS NULL)`;                       // 0 = sin seguro, válido
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

    // Claim atómico del más antiguo no bloqueado (o con bloqueo vencido).
    let id = null;
    for (let i = 0; i < 8 && !id; i++) {
      const [[cand]] = await pool.query(`
        SELECT ob.id FROM creditos ob
        WHERE ${pendingWhere(tipo)}
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
    const [[antes]] = await pool.query(`SELECT num_op, ${CAMPOS.map(c => c.col).join(', ')} FROM creditos WHERE id=?`, [id]);
    if (!antes) return res.status(404).json({ success:false, data:null, error:'Crédito no encontrado' });

    const sets = [], vals = [], cambios = [];
    for (const [col, raw] of Object.entries(campos)) {
      if (!valid.has(col)) continue;
      const v = (raw === '' || raw === undefined) ? null : raw;
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

    // Métrica: cuántos requeridos estaban faltantes y cuántos se completaron en este guardado.
    const reqs = REQUERIDOS[tipo];
    const faltAntes = reqs.filter(c => esVacio(c, antes[c]));
    const llenados = faltAntes.filter(c => !esVacio(c, campos[c] === '' ? null : campos[c])).length;
    pool.query(`INSERT INTO digitacion_log (id_credito, num_op, tipo, id_usuario, usuario, campos_llenados, requeridos_faltantes)
                VALUES (?,?,?,?,?,?,?)`,
      [id, antes.num_op, tipo, req.usuario.id_usuario, usuario, llenados, faltAntes.length]).catch(() => {});

    await pool.query(`UPDATE creditos SET digit_lock_por=NULL, digit_lock_nombre=NULL, digit_lock_at=NULL WHERE id=?`, [id]);
    res.json({ success:true, data:{ id, cambios: cambios.length, llenados, faltantes: faltAntes.length }, error:null });
  } catch (e) { errSrv(res, e, 'digit guardar'); }
};

/* ── POST /:id/liberar → soltar el bloqueo (saltar/salir) ────────────────── */
exports.liberar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
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
    const [rows] = await pool.query(
      `SELECT numero, rut, nombre_indexa, nombre_razon, ccs_parque
       FROM dealers
       WHERE (nombre_indexa LIKE ? OR nombre_razon LIKE ? OR rut LIKE ? OR numero LIKE ?)
         AND (activo IS NULL OR activo = 1)
       ORDER BY nombre_indexa LIMIT 20`, [like, like, like, like]);
    const data = rows.map(r => {
      const t = String(r.ccs_parque || '').toUpperCase();
      return { numero: r.numero, rut: r.rut, nombre: r.nombre_indexa || r.nombre_razon || '',
               tipo: t.includes('PARQUE') ? 'PARQUE' : (t ? 'CALLE' : '') };
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
    const pct = t => (t.faltantes > 0 ? Math.round((t.llenados / t.faltantes) * 1000) / 10 : 0);

    const [porDia] = await pool.query(`
      SELECT DATE(fecha) dia, COUNT(DISTINCT id_credito) creditos,
             SUM(campos_llenados) llenados, SUM(requeridos_faltantes) faltantes
      FROM digitacion_log WHERE fecha >= (NOW() - INTERVAL ? DAY)
      GROUP BY DATE(fecha) ORDER BY dia DESC`, [dias]);
    const [porUsuario] = await pool.query(`
      SELECT usuario, COUNT(DISTINCT id_credito) creditos,
             SUM(campos_llenados) llenados, SUM(requeridos_faltantes) faltantes
      FROM digitacion_log WHERE fecha >= (NOW() - INTERVAL ? DAY)
      GROUP BY usuario ORDER BY creditos DESC`, [dias]);
    const [[r0]] = await pool.query(`
      SELECT COUNT(DISTINCT id_credito) creditos, SUM(campos_llenados) llenados,
             SUM(requeridos_faltantes) faltantes, COUNT(DISTINCT DATE(fecha)) dias_activos
      FROM digitacion_log WHERE fecha >= (NOW() - INTERVAL ? DAY)`, [dias]);

    res.json({ success:true, data: {
      dias,
      resumen: {
        creditos: r0.creditos || 0,
        pct_completado: pct(r0),
        promedio_dia: r0.dias_activos ? Math.round((r0.creditos / r0.dias_activos) * 10) / 10 : 0,
      },
      porDia: porDia.map(d => ({ dia: d.dia, creditos: d.creditos, pct: pct(d), llenados: Number(d.llenados)||0, faltantes: Number(d.faltantes)||0 })),
      porUsuario: porUsuario.map(u => ({ usuario: u.usuario, creditos: u.creditos, pct: pct(u) })),
    }, error:null });
  } catch (e) { errSrv(res, e, 'digit estadisticas'); }
};
