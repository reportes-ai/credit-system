'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   EXCEPCIONES COMERCIALES — parámetros del Simulador de Excepciones del
   Ejecutivo (estrellas, comodín dorado, códigos de aprobación).
   Los parámetros viven en parametros_credito (prefijo exc_) — una sola fuente,
   mismo almacén que el resto de los parámetros de negocio. Este controller
   los expone con su propio permiso y SIN disparar recálculo de meses (estos
   parámetros no cambian la rentabilidad de operaciones ya cursadas).
   El umbral "Decides Tú" (pref_diff_pct) NO se duplica aquí: es el mismo de
   ¿Dónde Curso? y se muestra solo-lectura con link a su mantenedor.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

// Claves propias del mantenedor (whitelist del PUT)
const DEFAULTS = [
  ['exc_piso_pct',          75, 'Piso NIVEL 1 (cuesta 1 estrella): la excepción debe rentar al menos este % de la alternativa más rentable'],
  ['exc_piso2_pct',         50, 'Piso NIVEL 2 (cuesta 2 estrellas): % mínimo de la alternativa más rentable'],
  ['exc_piso2_estrellas',    2, 'Estrellas que cuesta una excepción de NIVEL 2 (piso 50%)'],
  ['exc_piso3_pct',         25, 'Piso NIVEL 3: % mínimo de la alternativa más rentable (se exige ADEMÁS de la condición del factor)'],
  ['exc_nivel3_estrellas',   3, 'Estrellas que cuesta el NIVEL 3 (piso 25% + rentabilidad sobre la comisión más alta)'],
  ['exc_nivel3_factor_pct', 10, 'NIVEL 3: la rentabilidad AutoFácil debe ADEMÁS superar en este % a la MÁS ALTA entre la comisión del dealer y la del ejecutivo'],
  ['exc_tasa_rebaja_max_pct', 5, 'Rebaja MÁXIMA de tasa en Unidad: % relativo sobre la tasa pizarra (ej: pizarra 2,70% → mínimo 2,70 × 0,95 = 2,56%, redondeando hacia abajo). Si la baja pedida supera esto, la op se fuerza a Autofin'],
  ['exc_estrellas_mes1',     3, 'Estrellas (excepciones) del PRIMER mes de un ejecutivo nuevo — de regalo, alcanzan justo para una jugada de nivel 3'],
  ['exc_pct_mensual',       33, '% de las otorgadas del mes anterior que se convierten en estrellas del mes (redondeo HACIA ABAJO: con 2 colocadas → 0; el aliciente es colocar al menos 3)'],
  ['exc_vigencia_horas',    24, 'Vigencia de un código de excepción (horas corridas desde que se genera); vencido sin usar, sus estrellas se devuelven dentro del mismo mes'],
  ['exc_tolerancia_saldo',   0, 'Tolerancia en $ entre el saldo precio de la simulación y el de la carta al validar un código (0 = deben calzar exacto)'],
  ['exc_codigo_digitos',     6, 'Largo del código de aprobación (dígitos)'],
  ['exc_plazo_min_curse',   12, 'Plazo mínimo cursable (cuotas): bajo esto NINGUNA financiera toma la operación — ¿Dónde Curso? muestra ambas en gris'],
  ['exc_plazo_1',           12, 'Simulador — plazo 1 (cuotas)'],
  ['exc_plazo_2',           24, 'Simulador — plazo 2 (cuotas)'],
  ['exc_plazo_3',           36, 'Simulador — plazo 3 (cuotas)'],
  ['exc_plazo_4',           48, 'Simulador — plazo 4 (cuotas)'],
];
const CLAVES = new Set(DEFAULTS.map(d => d[0]));

require('../../../../shared/migrate').enFila('excepciones-comerciales', async () => {
  try {
    // Renombre 2026-08-07: exc_tasa_min_unidad era engañosa (no es tasa piso,
    // es rebaja máxima relativa sobre la pizarra). Conserva el valor si existía.
    await pool.query(`UPDATE IGNORE parametros_credito SET clave='exc_tasa_rebaja_max_pct'
                      WHERE clave='exc_tasa_min_unidad'`).catch(() => {});
    await pool.query(`DELETE FROM parametros_credito WHERE clave='exc_tasa_min_unidad'`).catch(() => {});
    // 2026-08-08: el comodín dorado se reemplaza por la escalera de estrellas
    // (1⭐ piso 75% · 2⭐ piso 50% · 3⭐ cualquier op). Su factor pasa al nivel 3
    // y el resto de sus claves se retira. Primer mes: 3 estrellas de regalo.
    await pool.query(`UPDATE IGNORE parametros_credito SET clave='exc_nivel3_factor_pct'
                      WHERE clave='exc_comodin_factor_pct'`).catch(() => {});
    await pool.query(`DELETE FROM parametros_credito WHERE clave IN
      ('exc_comodin_factor_pct','exc_comodin_cada','exc_comodin_inicial','exc_comodin_max','exc_comodin_desde')`).catch(() => {});
    await pool.query(`UPDATE parametros_credito SET valor=3 WHERE clave='exc_estrellas_mes1' AND valor=2`).catch(() => {});
    for (const [clave, valor, descripcion] of DEFAULTS)
      await pool.query('INSERT IGNORE INTO parametros_credito (clave, valor, descripcion) VALUES (?, ?, ?)',
        [clave, valor, descripcion]);
    // Refrescar descripciones (fuente de la letra chica del mantenedor)
    for (const [clave, , descripcion] of DEFAULTS)
      await pool.query('UPDATE parametros_credito SET descripcion=? WHERE clave=?', [descripcion, clave]);

    // Card del mantenedor + permiso (matriz de Perfiles)
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_excepciones' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Excepciones Comerciales', 'mantenedores_excepciones', '/mantenedores/excepciones-comerciales/', 'bi-stars')`);
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE UPPER(nombre) LIKE 'ADMINISTRADOR%' ORDER BY id_perfil LIMIT 1");
    if (adm) await pool.query(
      `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
       SELECT ?, id_funcionalidad, 1 FROM funcionalidades WHERE codigo='mantenedores_excepciones'`, [adm.id_perfil]);
    // habilitado=1 explícito: el default de la columna es 0 y mis-permisos filtra por él
    await pool.query(
      `UPDATE permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
       SET pp.habilitado = 1 WHERE f.codigo='mantenedores_excepciones' AND pp.id_perfil = ?`, [adm.id_perfil]);
    console.log('[excepciones-comerciales] parámetros + card OK');
  } catch (e) { console.error('[excepciones-comerciales migration]', e.message); }
});

/* GET /api/excepciones-comerciales → parámetros exc_* + referencia pref_diff_pct */
const getAll = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT clave, valor, descripcion, fecha_actualizacion FROM parametros_credito
       WHERE clave LIKE 'exc\\_%' OR clave = 'pref_diff_pct' ORDER BY clave`);
    const obj = {};
    rows.forEach(r => { obj[r.clave] = parseFloat(r.valor); });
    res.json({ success: true, data: { lista: rows, obj }, error: null });
  } catch (e) {
    console.error('[excepciones getAll]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* PUT /api/excepciones-comerciales — solo claves exc_* (whitelist), sin recálculo */
const updateAll = async (req, res) => {
  try {
    const cambios = {};
    for (const [clave, valor] of Object.entries(req.body || {})) {
      if (!CLAVES.has(clave)) continue;                       // whitelist estricta
      const num = parseFloat(valor);
      if (!isFinite(num) || num < 0) return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${clave}` });
      cambios[clave] = num;
    }
    if (!Object.keys(cambios).length) return res.status(400).json({ success: false, data: null, error: 'Nada que actualizar' });
    for (const [clave, valor] of Object.entries(cambios))
      await pool.query('UPDATE parametros_credito SET valor = ? WHERE clave = ?', [valor, clave]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'parametros_credito', entidad_id: 'excepciones',
      detalle: `Actualizó parámetros de Excepciones Comerciales (${Object.keys(cambios).length})`, meta: cambios });
    res.json({ success: true, data: { mensaje: 'Parámetros actualizados' }, error: null });
  } catch (e) {
    console.error('[excepciones updateAll]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getAll, updateAll };
