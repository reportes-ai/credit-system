'use strict';
const pool      = require('../../../../shared/config/database');
const XLSX      = require('xlsx');
const historial = require('./carga-historial.controller');
const { recalcularMeses } = require('../utils/recalcular-mes');
const { isMesCerrado, getMesDeNumOp } = require('../../../../shared/utils/mes-cerrado');

/* ── Migraciones ────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`ALTER TABLE creditos ADD COLUMN estado_autofin VARCHAR(50) NULL COMMENT 'Estado en sistema Trinidad'`);
    console.log('[carga-trinidad] columna estado_autofin creada');
  } catch (e) {
    if (e.errno !== 1060) console.error('[carga-trinidad migration]', e.message);
  }
  try {
    await pool.query(`ALTER TABLE creditos ADD COLUMN ejecutivo_tri VARCHAR(150) NULL COMMENT 'Nombre ejecutivo original en Trinidad'`);
    console.log('[carga-trinidad] columna ejecutivo_tri creada');
  } catch (e) {
    if (e.errno !== 1060) console.error('[carga-trinidad migration ejecutivo_tri]', e.message);
  }
  try {
    const [r] = await pool.query(`UPDATE creditos SET ejecutivo = UPPER(ejecutivo) WHERE ejecutivo IS NOT NULL AND ejecutivo != UPPER(ejecutivo)`);
    if (r.affectedRows > 0) console.log(`[carga-trinidad] ${r.affectedRows} ejecutivos convertidos a mayúsculas`);
  } catch (e) {
    console.error('[carga-trinidad migration uppercase]', e.message);
  }
  try {
    // Parchar registros de Trinidad sin estado_eval usando el estado_credito existente
    const [r] = await pool.query(`
      UPDATE creditos SET estado_eval =
        CASE estado_credito
          WHEN 'Otorgado'  THEN 'OTORGADO'
          WHEN 'Aprobado'  THEN 'APROBADO'
          WHEN 'Rechazado' THEN 'RECHAZADO'
          WHEN 'Digitado'  THEN 'PENDIENTE'
          ELSE UPPER(estado_credito)
        END
      WHERE (estado_eval IS NULL OR estado_eval = '') AND estado_credito IS NOT NULL AND estado_credito != ''
    `);
    if (r.affectedRows > 0) console.log(`[carga-trinidad] ${r.affectedRows} registros con estado_eval parcheado desde estado_credito`);
  } catch (e) {
    console.error('[carga-trinidad migration estado_eval]', e.message);
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

  // Buscar dinámicamente la fila de headers (la que contiene columna "ID")
  let headerIdx = raw.findIndex(row => Array.isArray(row) && row.some(c => String(c||'').trim().toUpperCase() === 'ID'));
  if (headerIdx < 0) headerIdx = 2; // fallback
  const headers = (raw[headerIdx] || []).map(h => String(h || '').trim());
  const dataRows = raw.slice(headerIdx + 1);

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

      const estadoCredito = mapEstado(estadoTri, mapaEstados);
      // Derivar estado_eval (usado por el dashboard) desde estado_credito
      const EVAL_MAP = { 'Otorgado':'OTORGADO', 'Aprobado':'APROBADO', 'Rechazado':'RECHAZADO', 'Digitado':'PENDIENTE' };
      const estadoEval = EVAL_MAP[estadoCredito] || estadoCredito?.toUpperCase() || null;

      return {
        num_op,
        estado_autofin:  estadoTri,
        estado_credito:  estadoCredito,
        estado_eval:     estadoEval,
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
        marca:           normStr(get('Marca')),
        modelo:          normStr(get('Modelo')),
        vendedor:        normStr(get('Vendedor')),
        rut_cliente:     normRut(get('Rut Cliente')),
        nombre_cliente:  normStr(get('Nombre')),
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

    // Traer registros actuales (por num_op propio)
    const [existing] = await pool.query(
      `SELECT num_op, estado_autofin, estado_credito FROM creditos
       WHERE num_op IN (${numOps.map(() => '?').join(',')})`,
      numOps
    );
    const existMap = Object.fromEntries(existing.map(r => [r.num_op, r]));

    // Detectar num_ops Trinidad que ya existen como id_financiera en un registro AUTOFIN
    // Esos no se insertan para evitar duplicados (el registro AUTOFIN es la fuente canónica)
    const [afEquiv] = await pool.query(
      `SELECT id_financiera FROM creditos
       WHERE id_financiera IN (${numOps.map(() => '?').join(',')})
         AND financiera != 'NO APLICA'`,
      numOps.map(String)
    );
    const afEquivSet = new Set(afEquiv.map(r => parseInt(r.id_financiera)));

    let insertados   = 0;
    let actualizados = 0;
    let errores      = 0;
    const clienteCache = {};   // rut → id_cliente (resuelto/creado en tabla clientes)
    const log          = [];
    const detallesIns  = [];   // para historial inserts
    const cambiosLog   = [];   // para historial cambios
    const cursadosIds        = [];   // num_ops (campo num_op en BD)
    const cursadosIdFinanciera = []; // num_ops Trinidad que están como id_financiera en BD

    for (const f of filas) {
      try {
        // Verificar mes cerrado (aplica a updates, no a inserts nuevos)
        const _mesTriCheck = existMap[f.num_op]?.mes || null;
        if (_mesTriCheck) {
          const _mesTriStr = String(_mesTriCheck).slice(0, 7);
          if (await isMesCerrado(_mesTriStr)) {
            log.push(`⏭ Omitido ${f.num_op}: mes ${_mesTriStr} cerrado`);
            continue;
          }
        }

        // Resolver id_cliente desde rut/nombre del Excel (viven en la tabla
        // clientes; el dashboard y el listado hacen JOIN por id_cliente).
        let idCliente = null;
        if (f.rut_cliente) {
          if (clienteCache[f.rut_cliente] === undefined) {
            const [[cl]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut = ?', [f.rut_cliente]);
            if (cl) clienteCache[f.rut_cliente] = cl.id_cliente;
            else {
              const [insCli] = await pool.query(
                `INSERT INTO clientes (rut, nombre_completo) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE id_cliente = LAST_INSERT_ID(id_cliente)`,
                [f.rut_cliente, f.nombre_cliente || null]);
              clienteCache[f.rut_cliente] = insCli.insertId;
            }
          }
          idCliente = clienteCache[f.rut_cliente] || null;
        }

        // Si ya existe un registro AUTOFIN con id_financiera = este num_op Trinidad,
        // no insertar duplicado. Actualizar estado_autofin (y el cliente si falta).
        if (afEquivSet.has(f.num_op)) {
          await pool.query(
            `UPDATE creditos SET estado_autofin = ?, ejecutivo_tri = ?,
               estado_credito = ?, estado_eval = ?, id_cliente = COALESCE(id_cliente, ?), updated_at = NOW()
             WHERE id_financiera = ? AND financiera != 'NO APLICA'`,
            [f.estado_autofin, f.ejecutivo_tri, f.estado_credito, f.estado_eval, idCliente, String(f.num_op)]
          );
          actualizados++;
          log.push(`↔ Sincronizado en AF ${f.num_op} → ${f.estado_autofin} / ${f.estado_credito}`);
          if ((f.estado_credito||'').toLowerCase() === 'otorgado') cursadosIdFinanciera.push(String(f.num_op));
          continue;
        }

        if (existMap[f.num_op]) {
          const actual = existMap[f.num_op];
          // Solo registrar cambio de estado_autofin (estado_credito NO se pisa — viene de AutoFácil)
          const ant = actual['estado_autofin'] ?? null;
          const nvo = f['estado_autofin']      ?? null;
          if (String(ant ?? '') !== String(nvo ?? '')) {
            cambiosLog.push({ num_op: f.num_op, campo: 'estado_autofin', valor_anterior: ant, valor_nuevo: nvo });
          }
          await pool.query(
            `UPDATE creditos SET
               estado_autofin = ?, ejecutivo_tri = ?,
               estado_credito = ?,
               estado_eval    = ?,
               id_financiera  = COALESCE(NULLIF(id_financiera,''), ?),
               id_cliente     = COALESCE(id_cliente, ?),
               marca    = COALESCE(?, marca), modelo   = COALESCE(?, modelo),
               vendedor = COALESCE(?, vendedor), updated_at = NOW()
             WHERE num_op = ?`,
            [f.estado_autofin, f.ejecutivo_tri, f.estado_credito, f.estado_eval, String(f.num_op), idCliente, f.marca, f.modelo, f.vendedor, f.num_op]
          );
          actualizados++;
          log.push(`✓ Actualizado ${f.num_op} → ${f.estado_autofin} / ${f.estado_credito}`);
          if ((f.estado_credito||'').toLowerCase() === 'otorgado') cursadosIds.push(f.num_op);
        } else {
          await pool.query(
            `INSERT INTO creditos
               (num_op, id_financiera, estado_autofin, estado_credito, estado_eval,
                producto, ejecutivo, ejecutivo_tri, automotora, valor_vehiculo, pie, saldo_precio,
                monto_financiado, fecha_otorgado, mes,
                marca, modelo, vendedor, id_cliente,
                financiera, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'AUTOFIN', NOW(), NOW())`,
            [
              f.num_op, String(f.num_op),
              f.estado_autofin, f.estado_credito, f.estado_eval,
              f.producto, f.ejecutivo, f.ejecutivo_tri, f.automotora,
              f.valor_vehiculo, f.pie, f.saldo_precio,
              f.monto_financiado, f.fecha_otorgado, f.mes,
              f.marca, f.modelo, f.vendedor, idCliente,
            ]
          );
          insertados++;
          detallesIns.push({ num_op: f.num_op, datos: f });
          log.push(`➕ Insertado  ${f.num_op} → ${f.estado_autofin} / ${f.estado_credito}`);
          if ((f.estado_credito||'').toLowerCase() === 'otorgado') cursadosIds.push(f.num_op);
        }
      } catch (rowErr) {
        errores++;
        log.push(`✗ Error ${f.num_op}: ${rowErr.message}`);
      }
    }

    // ── Guardar en historial ──────────────────────────────────────
    if (insertados > 0 || actualizados > 0) {
      historial.crearSesion({
        fuente:      'trinidad',
        usuario:     req.user?.nombre || req.user?.email || null,
        archivo:     req.file?.originalname || null,
        insertados, actualizados, errores,
        total:       filas.length,
      }).then(sesionId => {
        for (const d of detallesIns) {
          historial.logDetalle(sesionId, d.num_op, 'insert', d.datos).catch(() => {});
        }
        for (const c of cambiosLog) {
          historial.logCambio(sesionId, c.num_op, c.campo, c.valor_anterior, c.valor_nuevo).catch(() => {});
        }
      }).catch(() => {});
    }

    // ── Recálculo completo de comisiones (incluye tiers UNIDAD) ─────────
    if (insertados > 0 || actualizados > 0) {
      try {
        const mesesSet = new Set(filas.map(f => (f.mes || '').slice(0, 7)).filter(Boolean));
        const resultado = await recalcularMeses([...mesesSet]);
        console.log('[carga-trinidad recalc]', resultado.log.join(' | '));
        log.push(`🔄 Comisiones recalculadas: ${resultado.actualizados} ops`);
      } catch (e) {
        console.error('[carga-trinidad recalc]', e.message);
        log.push(`⚠ Recálculo comisiones: ${e.message}`);
      }
    }

    // Devolver datos de cursados para el popup de datos faltantes
    let cursados = [];
    if (cursadosIds.length > 0 || cursadosIdFinanciera.length > 0) {
      try {
        const conditions = [];
        const params = [];
        if (cursadosIds.length > 0) { conditions.push('num_op IN (?)'); params.push(cursadosIds); }
        if (cursadosIdFinanciera.length > 0) { conditions.push('id_financiera IN (?)'); params.push(cursadosIdFinanciera); }
        const [rows] = await pool.query(
          `SELECT id, num_op, ejecutivo, automotora, monto_financiado, valor_vehiculo,
                  rut_cliente, fecha_otorgado, estado_credito, plazo, tascli_real,
                  monto_comision_fin, seguro_rdh, comdea_real, com_parque
           FROM creditos WHERE ${conditions.join(' OR ')}`,
          params
        );
        cursados = rows;
      } catch(e) { log.push(`⚠ No se pudieron cargar datos de cursados: ${e.message}`); }
    }

    return res.json({
      success: true,
      data: { total: filas.length, insertados, actualizados, errores, log, cursados },
    });
  } catch (e) {
    console.error('[carga-trinidad importar]', e);
    return res.json({ success: false, error: e.message });
  }
};

/* ── POST /api/carga-trinidad/reprocesar-estados ────────────────
   Lee la tabla trinidad_estados y actualiza estado_credito + estado_eval
   en todos los creditos que tienen estado_autofin registrado.
───────────────────────────────────────────────────────────────── */
exports.reprocesarEstados = async (req, res) => {
  try {
    const mapaEstados = await cargarMapaEstados();
    const EVAL_MAP = { 'Otorgado':'OTORGADO', 'Aprobado':'APROBADO', 'Rechazado':'RECHAZADO', 'Digitado':'PENDIENTE' };

    // Traer todos los créditos con estado_autofin
    const [creditos] = await pool.query(
      `SELECT id, num_op, estado_autofin FROM creditos WHERE estado_autofin IS NOT NULL AND estado_autofin != ''`
    );

    if (!creditos.length) return res.json({ success: true, data: { actualizados: 0, mensaje: 'No hay créditos con estado Trinidad' } });

    let actualizados = 0;
    for (const c of creditos) {
      const estadoCredito = mapEstado(c.estado_autofin, mapaEstados);
      const estadoEval    = EVAL_MAP[estadoCredito] || estadoCredito?.toUpperCase() || null;
      await pool.query(
        `UPDATE creditos SET estado_credito = ?, estado_eval = ?, updated_at = NOW() WHERE id = ?`,
        [estadoCredito, estadoEval, c.id]
      );
      actualizados++;
    }

    return res.json({ success: true, data: { actualizados, mensaje: `${actualizados} créditos actualizados con las equivalencias actuales` } });
  } catch (e) {
    console.error('[carga-trinidad reprocesar-estados]', e);
    return res.json({ success: false, error: e.message });
  }
};

/* ── Parseo de Carta de Aprobación Trinidad (PDF) → campos de digitación ──
   Usa coordenadas (x,y) de los items de texto para mapear etiqueta→valor,
   tolerando el orden desordenado de la extracción plana de pdf-parse.        */
exports.parseCarta = async (req, res) => {
  try {
    const pdfParse = require('pdf-parse');
    const buf = req.file ? req.file.buffer
              : (req.body && req.body.pdf_base64 ? Buffer.from(req.body.pdf_base64, 'base64') : null);
    if (!buf) return res.status(400).json({ success: false, error: 'No se recibió el PDF' });

    const items = [];
    await pdfParse(buf, {
      max: 1,
      pagerender: (p) => p.getTextContent({ disableCombineTextItems: true }).then(tc => {
        for (const it of tc.items) {
          const t = it.transform;
          items.push({ s: it.str, x: Math.round(t[4]), y: Math.round(t[5]) });
        }
        return '';
      }),
    });

    // valor a la derecha de la etiqueta (mismo renglón), saltando el ":"
    const findVal = (label) => {
      const lab = items.find(i => i.s.trim() === label) || items.find(i => i.s.trim().startsWith(label));
      if (!lab) return null;
      const colon = items.filter(i => Math.abs(i.y - lab.y) <= 3 && i.s.trim() === ':' && i.x > lab.x)
                         .sort((a, b) => a.x - b.x)[0];
      const startX = colon ? colon.x : lab.x;
      const cand = items.filter(i => Math.abs(i.y - lab.y) <= 3 && i.s.trim() && i.s.trim() !== ':' && i.x > startX)
                        .sort((a, b) => a.x - b.x)[0];
      return cand ? cand.s.trim() : null;
    };

    const firstNum = s => { const m = String(s || '').match(/\d[\d.]*(?:,\d+)?/); return m ? m[0] : null; };
    const numCL = s => { const f = firstNum(s); if (f == null) return null; const n = parseFloat(f.replace(/\./g, '').replace(',', '.')); return isNaN(n) ? null : n; };
    const dateCL = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
    const allText = items.map(i => i.s).join(' ');
    const rut = (allText.match(/\b\d{7,8}-[\dkK]\b/) || [])[0] || null;
    const limpiaAFA = s => (s || '').replace(/\s*\(AFA\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();

    // Mapeo de ejecutivo Trinidad → AutoFácil (tabla trinidad_ejecutivos, con fallback)
    const ejecutivoRaw = limpiaAFA(findVal('Ejecutivo'));
    const DIACRIT = new RegExp('[\\u0300-\\u036f]', 'g');
    const normEj = s => (s || '').toLowerCase()
      .replace(/\(afa\)|\(jl\)|\(ls\)|\bgte\b/gi, '')
      .normalize('NFD').replace(DIACRIT, '')
      .replace(/[^a-z ]/gi, '').replace(/\s+/g, ' ').trim();
    let ejecutivo = ejecutivoRaw;
    try {
      const [rows] = await pool.query('SELECT nombre_trinidad, nombre_autofacil FROM trinidad_ejecutivos');
      const k = normEj(ejecutivoRaw);
      const hit = rows.find(r => normEj(r.nombre_trinidad) === k);
      if (hit) ejecutivo = hit.nombre_autofacil;
      else { const w = (ejecutivoRaw || '').trim().split(/\s+/); ejecutivo = w.slice(0, 2).join(' ').toUpperCase(); }
    } catch (e) { /* usa raw */ }

    const data = {
      nro_credito:      findVal('Nº Crédito'),
      fecha_aprobacion: dateCL(findVal('Fecha Aprobación')),
      telefono:         findVal('Telefono'),
      rut_cliente:      rut,
      nombre_cliente:   findVal('Cliente'),
      email:            findVal('Email'),
      ejecutivo:        ejecutivo,
      ejecutivo_raw:    ejecutivoRaw,
      concesionario:    findVal('Concesionario'),
      sucursal:         limpiaAFA(findVal('Sucursal')),
      marca:            findVal('Marca'),
      modelo:           findVal('Modelo'),
      anio:             numCL(findVal('Año')),
      estado_vehiculo:  findVal('Estado'),
      version:          findVal('Versión'),
      precio:           numCL(findVal('Precio')),
      pie:              numCL(findVal('Pie')),
      producto:         findVal('Producto'),
      tasa:             numCL(findVal('Tasa')),
      cuotas:           numCL(findVal('Número de cuotas')),
      total_pagare:     numCL(findVal('Total pagaré')),
      monto_solicitado: numCL(findVal('Monto solicitado')),
      total_recargos:   numCL(findVal('Total de recargos')),
      seguro_rdh:       numCL(findVal('Seguro RDH+E')),
      seguro_cesantia:  numCL(findVal('Seguro Cesantia')),
      reparaciones:     numCL(findVal('Reparaciones Menores')),
      seguro_desgrav:   numCL(findVal('Seguro Desgravamen')),
      impuesto_timbre:  numCL(findVal('Impuesto timbre')),
      inscripcion:      numCL(findVal('Inscripción')),
      gps:              numCL(findVal('GPS')),
      comision:         numCL(findVal('Comisión')),
      fecha_curse:      dateCL(findVal('Fecha curse')),
    };

    // Gastos operacionales = Impuesto de timbre + Inscripción (van sumados en la carta)
    data.gastos_operacionales = (data.impuesto_timbre || 0) + (data.inscripcion || 0);

    // Fecha primera cuota = primera fecha del cuadro de pago (la más temprana posterior al curse)
    const curseD = data.fecha_curse ? new Date(data.fecha_curse + 'T00:00:00') : null;
    let primera = null;
    for (const ds of (allText.match(/\d{2}\/\d{2}\/\d{4}/g) || [])) {
      const m = ds.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const d = new Date(+m[3], +m[2] - 1, +m[1]);
      if (curseD && d > curseD && (!primera || d < primera)) primera = d;
    }
    data.fecha_primera_cuota = primera
      ? `${primera.getFullYear()}-${String(primera.getMonth() + 1).padStart(2, '0')}-${String(primera.getDate()).padStart(2, '0')}`
      : null;

    return res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[carga-trinidad parseCarta]', e);
    return res.status(500).json({ success: false, error: 'No se pudo leer el PDF: ' + e.message });
  }
};
