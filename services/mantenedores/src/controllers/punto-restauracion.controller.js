'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PUNTO DE RESTAURACIÓN (UAT) — marca de agua para pruebas de usuario.
   "Crear punto" guarda el ID máximo actual de las tablas de OPERACIONES;
   "Restaurar" borra todo lo creado DESPUÉS de esa marca:
     créditos (+ todas sus tablas hijas por id_credito) — cartas — cotizaciones
     — pre-aprobaciones del portal.
   NO toca clientes, antecedentes, informes comerciales ni data histórica.
   Nivel Dios (mantenedores_solo_dios) y auditado.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const KEY = 'uat_punto_restauracion';

// Tablas raíz con su PK (se borra PK > marca)
const RAICES = [
  { tabla: 'creditos',               pk: 'id' },
  { tabla: 'cartas_aprobacion',      pk: 'id' },
  { tabla: 'cotizaciones',           pk: 'id_cotizacion' },
  { tabla: 'portal_preaprobaciones', pk: 'id' },
];
// Hijas de creditos por id_credito (se borran ANTES que los créditos nuevos)
const HIJAS_ID_CREDITO = [
  'cuotas_credito', 'pagos_credito', 'auditoria_credito', 'broker_validaciones',
  'cobranza_gestiones', 'cobranza_mora_envios', 'credito_documento_vistos',
  'credito_documentos', 'creditos_edicion_log', 'crm_gestiones', 'cuentas_transitorias',
  'digitacion_log', 'documentos_af', 'facturas_brokerage', 'fundantes_brokerage',
  'fundantes_seg', 'fundantes_seg_docs', 'ordenes_pago_cuotas', 'pagos_brokerage',
  'postventa_seguimiento', 'transitorias_cartola', 'wsp_auto_cobranza_envios',
  'wsp_avisos_vencimiento',
];

async function leerPunto() {
  const [[row]] = await pool.query('SELECT config_value FROM dashboard_config WHERE config_key=? LIMIT 1', [KEY]);
  if (!row) return null;
  try { return JSON.parse(row.config_value); } catch (e) { return null; }
}

async function maxDe(tabla, pk) {
  try { const [[r]] = await pool.query(`SELECT COALESCE(MAX(\`${pk}\`),0) mx FROM \`${tabla}\``); return Number(r.mx) || 0; }
  catch (e) { return 0; } // tabla puede no existir aún
}

// GET /api/punto-restauracion — estado del punto + qué se borraría hoy
exports.estado = async (req, res) => {
  try {
    const punto = await leerPunto();
    let pendientes = null;
    if (punto) {
      pendientes = {};
      for (const r of RAICES) {
        const marca = Number(punto.marcas && punto.marcas[r.tabla]) || 0;
        const [[c]] = await pool.query(`SELECT COUNT(*) n FROM \`${r.tabla}\` WHERE \`${r.pk}\` > ?`, [marca]).catch(() => [[{ n: 0 }]]);
        pendientes[r.tabla] = Number(c && c.n) || 0;
      }
    }
    res.json({ success: true, data: { punto, pendientes }, error: null });
  } catch (e) {
    console.error('[punto-restauracion] estado:', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al leer el punto' });
  }
};

// POST /api/punto-restauracion/crear — fija la marca de agua AHORA
exports.crear = async (req, res) => {
  try {
    const marcas = {};
    for (const r of RAICES) marcas[r.tabla] = await maxDe(r.tabla, r.pk);
    const punto = { marcas, creado_at: new Date().toISOString(), creado_por: (req.usuario && (req.usuario.email || req.usuario.id_usuario)) || null };
    await pool.query(
      `INSERT INTO dashboard_config (config_key, config_value) VALUES (?,?)
       ON DUPLICATE KEY UPDATE config_value=VALUES(config_value), updated_at=NOW()`,
      [KEY, JSON.stringify(punto)]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'punto_restauracion', detalle: 'Punto de restauración UAT creado: ' + JSON.stringify(marcas) });
    res.json({ success: true, data: punto, error: null });
  } catch (e) {
    console.error('[punto-restauracion] crear:', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al crear el punto' });
  }
};

// POST /api/punto-restauracion/restaurar — borra TODO lo posterior a la marca
exports.restaurar = async (req, res) => {
  try {
    const punto = await leerPunto();
    if (!punto || !punto.marcas) return res.status(400).json({ success: false, data: null, error: 'No hay punto de restauración creado' });
    if (String(req.body && req.body.confirmar) !== 'RESTAURAR')
      return res.status(400).json({ success: false, data: null, error: 'Falta la confirmación (escribe RESTAURAR)' });

    const borrado = {};

    // 1) Créditos nuevos y todas sus hijas
    const marcaCred = Number(punto.marcas.creditos) || 0;
    const [nuevos] = await pool.query('SELECT id FROM creditos WHERE id > ?', [marcaCred]);
    const ids = nuevos.map(x => x.id);
    if (ids.length) {
      for (let i = 0; i < ids.length; i += 500) {
        const lote = ids.slice(i, i + 500);
        for (const h of HIJAS_ID_CREDITO) {
          try {
            const [r] = await pool.query(`DELETE FROM \`${h}\` WHERE id_credito IN (${lote.map(() => '?').join(',')})`, lote);
            if (r.affectedRows) borrado[h] = (borrado[h] || 0) + r.affectedRows;
          } catch (e) { /* tabla puede no existir */ }
        }
        const [rc] = await pool.query(`DELETE FROM creditos WHERE id IN (${lote.map(() => '?').join(',')})`, lote);
        borrado.creditos = (borrado.creditos || 0) + rc.affectedRows;
      }
    }

    // 2) Otras raíces (cartas, cotizaciones, pre-aprobaciones)
    for (const r of RAICES) {
      if (r.tabla === 'creditos') continue;
      const marca = Number(punto.marcas[r.tabla]) || 0;
      try {
        const [rr] = await pool.query(`DELETE FROM \`${r.tabla}\` WHERE \`${r.pk}\` > ?`, [marca]);
        if (rr.affectedRows) borrado[r.tabla] = rr.affectedRows;
      } catch (e) { /* tabla puede no existir */ }
    }

    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'punto_restauracion',
      detalle: 'RESTAURACIÓN UAT ejecutada — borrado: ' + JSON.stringify(borrado) });
    res.json({ success: true, data: { borrado }, error: null });
  } catch (e) {
    console.error('[punto-restauracion] restaurar:', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al restaurar: ' + e.message });
  }
};

// Card en Mantenedores (solo la ve el Admin: sin permisos_perfil asignados)
require('../../../../shared/migrate').enFila('punto-restauracion', async () => {
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='punto_restauracion' LIMIT 1");
    if (!ex) await pool.query(
      "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (30001, 'Punto de Restauración (UAT)', 'punto_restauracion', '/mantenedores/punto-restauracion/', 'bi-clock-history')");
  } catch (e) { console.error('[punto-restauracion seed]', e.message); }
});
