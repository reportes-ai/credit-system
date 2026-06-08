'use strict';
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');

/* ── Migración: agregar columna estado_autofin ─────────────────── */
(async () => {
  try {
    await pool.query(`ALTER TABLE creditos ADD COLUMN estado_autofin VARCHAR(50) NULL COMMENT 'Estado en sistema Trinidad'`);
    console.log('[carga-trinidad] columna estado_autofin creada');
  } catch (e) {
    if (e.errno !== 1060) console.error('[carga-trinidad migration]', e.message);
  }
})();

/* ── Carga mapa de estados desde BD (con fallback hardcoded) ────── */
async function cargarMapaEstados() {
  try {
    const [rows] = await pool.query('SELECT estado_trinidad, estado_autofacil FROM trinidad_estados');
    const mapa = {};
    for (const r of rows) mapa[r.estado_trinidad.trim().toLowerCase()] = r.estado_autofacil;
    return mapa;
  } catch { return { cursado: 'Otorgado' }; }
}

/* ── Carga mapa de ejecutivos desde BD ──────────────────────────── */
async function cargarMapaEjecutivos() {
  try {
    const [rows] = await pool.query('SELECT nombre_trinidad, nombre_autofacil FROM trinidad_ejecutivos');
    const mapa = {};
    for (const r of rows) mapa[r.nombre_trinidad.trim().toLowerCase()] = r.nombre_autofacil;
    return mapa;
  } catch { return {}; }
}

function mapEstado(estadoTrinidad, mapaEstados) {
  if (!estadoTrinidad) return 'Digitado';
  return mapaEstados[estadoTrinidad.trim().toLowerCase()] || 'Digitado';
}

function mapEjecutivo(nombreTrinidad, mapaEjecutivos) {
  if (!nombreTrinidad) return null;
  return mapaEjecutivos[nombreTrinidad.trim().toLowerCase()] || nombreTrinidad.trim();
}

/* ── Normaliza RUT (quita puntos, espacios) ─────────────────────── */
function normRut(v) {
  if (!v) return null;
  return String(v).replace(/\./g, '').trim().toUpperCase() || null;
}

/* ── Normaliza fecha de Excel (Date object o string) ───────────── */
function normDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normInt(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : Math.round(n);
}

function normStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/* ── Lee el Excel y retorna array de filas mapeadas ─────────────── */
function parseExcel(buffer, mapaEstados = {}, mapaEjecutivos = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Fila 3 (índice 3) = headers, datos desde fila 4
  const headers = (raw[3] || []).map(h => String(h || '').trim());
  const dataRows = raw.slice(4);

  return dataRows
    .filter(row => row && row[0] != null)          // saltar filas vacías
    .map(row => {
      const get = (name) => {
        const idx = headers.findIndex(h => h.toUpperCase() === name.toUpperCase());
        return idx >= 0 ? row[idx] : null;
      };

      const idRaw   = get('ID');
      const num_op  = idRaw != null ? parseInt(idRaw) : null;
      if (!num_op || isNaN(num_op)) return null;

      const estadoTri = normStr(get('Estado')) || normStr(get('ESTADO'));
      const ejTri     = normStr(get('Ejecutivo'));

      const fechaCurse   = normDate(get('Fecha Curse'));
      const fechaIngreso = normDate(get('Fecha Ingreso'));
      const fechaBase    = fechaCurse || fechaIngreso;
      const mes          = fechaBase ? fechaBase.slice(0, 7) + '-01' : null;

      return {
        num_op,
        estado_autofin:  estadoTri,
        estado_credito:  mapEstado(estadoTri, mapaEstados),
        rut_cliente:     normRut(get('Rut Cliente')),
        nombre_cliente:  normStr(get('Nombre')),
        producto:        normStr(get('Producto')),
        ejecutivo:       mapEjecutivo(ejTri, mapaEjecutivos),
        ejecutivo_tri:   ejTri,
        automotora:      normStr(get('Dealer')),
        valor_vehiculo:  normInt(get('Precio')),
        pie:             normInt(get('Pie')),
        saldo_precio:    normInt(get('Saldo Precio')),
        monto_financiado:normInt(get('Monto Pagare')),
        fecha_otorgado:  fechaCurse,
        mes,
      };
    })
    .filter(Boolean);
}

/* ── POST /api/carga-trinidad/preview ──────────────────────────── */
exports.preview = async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: 'Archivo requerido' });
    const [mapaEstados, mapaEjecutivos] = await Promise.all([cargarMapaEstados(), cargarMapaEjecutivos()]);
    const filas = parseExcel(req.file.buffer, mapaEstados, mapaEjecutivos);
    if (!filas.length) return res.json({ success: false, error: 'No se encontraron registros con ID válido' });

    const numOps = filas.map(f => f.num_op);
    const [existing] = await pool.query(
      `SELECT num_op FROM creditos WHERE num_op IN (${numOps.map(() => '?').join(',')})`,
      numOps
    );
    const existSet = new Set(existing.map(r => r.num_op));

    const preview = filas.slice(0, 20).map(f => ({
      ...f,
      existe: existSet.has(f.num_op),
    }));

    // Conteos
    const nuevos       = filas.filter(f => !existSet.has(f.num_op)).length;
    const actualizados = filas.filter(f =>  existSet.has(f.num_op)).length;

    // Conteo por estado Trinidad
    const porEstado = {};
    for (const f of filas) {
      const e = f.estado_autofin || '(sin estado)';
      porEstado[e] = (porEstado[e] || 0) + 1;
    }

    return res.json({ success: true, data: { total: filas.length, nuevos, actualizados, porEstado, preview } });
  } catch (e) {
    console.error('[carga-trinidad preview]', e);
    return res.json({ success: false, error: e.message });
  }
};

/* ── POST /api/carga-trinidad/importar ─────────────────────────── */
exports.importar = async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: 'Archivo requerido' });
    const [mapaEstados, mapaEjecutivos] = await Promise.all([cargarMapaEstados(), cargarMapaEjecutivos()]);
    const filas = parseExcel(req.file.buffer, mapaEstados, mapaEjecutivos);
    if (!filas.length) return res.json({ success: false, error: 'No se encontraron registros con ID válido' });

    const numOps = filas.map(f => f.num_op);
    const [existing] = await pool.query(
      `SELECT num_op FROM creditos WHERE num_op IN (${numOps.map(() => '?').join(',')})`,
      numOps
    );
    const existSet = new Set(existing.map(r => r.num_op));

    let insertados  = 0;
    let actualizados = 0;
    let errores      = 0;
    const log = [];

    for (const f of filas) {
      try {
        if (existSet.has(f.num_op)) {
          // UPDATE solo los estados
          await pool.query(
            `UPDATE creditos SET estado_autofin = ?, estado_credito = ?, updated_at = NOW()
             WHERE num_op = ?`,
            [f.estado_autofin, f.estado_credito, f.num_op]
          );
          actualizados++;
          log.push(`✓ Actualizado ${f.num_op} → ${f.estado_autofin} / ${f.estado_credito}`);
        } else {
          // INSERT registro nuevo
          await pool.query(
            `INSERT INTO creditos
               (num_op, estado_autofin, estado_credito, rut_cliente, nombre_cliente,
                producto, ejecutivo, automotora, valor_vehiculo, pie, saldo_precio,
                monto_financiado, fecha_otorgado, mes, financiera, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NO APLICA', NOW(), NOW())`,
            [
              f.num_op, f.estado_autofin, f.estado_credito, f.rut_cliente,
              f.nombre_cliente, f.producto, f.ejecutivo, f.automotora,
              f.valor_vehiculo, f.pie, f.saldo_precio, f.monto_financiado,
              f.fecha_otorgado, f.mes,
            ]
          );
          insertados++;
          log.push(`➕ Insertado  ${f.num_op} → ${f.estado_autofin} / ${f.estado_credito}`);
        }
      } catch (rowErr) {
        errores++;
        log.push(`✗ Error ${f.num_op}: ${rowErr.message}`);
      }
    }

    return res.json({
      success: true,
      data: { total: filas.length, insertados, actualizados, errores, log },
    });
  } catch (e) {
    console.error('[carga-trinidad importar]', e);
    return res.json({ success: false, error: e.message });
  }
};
