'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ── Migración ─────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meses_cerrados (
        mes           VARCHAR(7) PRIMARY KEY COMMENT 'YYYY-MM',
        cerrado       TINYINT(1) NOT NULL DEFAULT 0,
        cerrado_at    DATETIME,
        cerrado_por   INT,
        abierto_at    DATETIME   COMMENT 'Última vez que se abrió manualmente',
        auto_cierre   TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = cerrado por regla automática',
        notas         VARCHAR(255)
      )
    `);
    // Agregar columnas si ya existía la tabla sin ellas
    await pool.query(`ALTER TABLE meses_cerrados ADD COLUMN IF NOT EXISTS abierto_at  DATETIME COMMENT 'Última vez que se abrió manualmente'`).catch(()=>{});
    await pool.query(`ALTER TABLE meses_cerrados ADD COLUMN IF NOT EXISTS auto_cierre TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = cerrado por regla automática'`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_meses (
        clave  VARCHAR(60) PRIMARY KEY,
        valor  VARCHAR(255) NOT NULL,
        label  VARCHAR(120)
      )
    `);
    await pool.query(`
      INSERT IGNORE INTO config_meses (clave, valor, label)
      VALUES ('dias_cierre', '35', 'Días tras fin de mes para cierre automático')
    `);
  } catch (e) {
    console.error('[meses-cerrados migration]', e.message);
  }
})();

/* ── Helpers ─────────────────────────────────────────────────────────── */
function generarMeses(n = 24) {
  const meses = [];
  const hoy = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return meses;
}

function diasDesdeFinMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const ultimoDia = new Date(a, m, 0); // último día del mes
  return Math.floor((Date.now() - ultimoDia.getTime()) / 86400000);
}

/**
 * Corre la lógica de cierre automático:
 * 1. Cierra meses que superan dias_cierre y no están cerrados (y no fueron abiertos manualmente hace < 24h)
 * 2. Re-cierra meses que fueron abiertos manualmente hace más de 24h
 */
async function ejecutarCierreAutomatico(diasCierre) {
  const meses = generarMeses(24);
  const [rows] = await pool.query('SELECT * FROM meses_cerrados');
  const map = {};
  rows.forEach(r => { map[r.mes] = r; });

  for (const mes of meses) {
    const dias = diasDesdeFinMes(mes);
    const row  = map[mes];

    const estaAbierto = !row || !row.cerrado;

    if (estaAbierto && dias >= diasCierre) {
      // Verificar si fue abierto manualmente hace menos de 24h → NO cerrar todavía
      if (row?.abierto_at) {
        const horasDesdeApertura = (Date.now() - new Date(row.abierto_at).getTime()) / 3600000;
        if (horasDesdeApertura < 24) continue; // esperar las 24h
      }
      // Cerrar automáticamente
      await pool.query(`
        INSERT INTO meses_cerrados (mes, cerrado, cerrado_at, auto_cierre)
        VALUES (?, 1, NOW(), 1)
        ON DUPLICATE KEY UPDATE cerrado=1, cerrado_at=NOW(), auto_cierre=1
      `, [mes]);
      auditar({ accion: 'CIERRE_MES', modulo: 'meses-cerrados', entidad: 'mes', entidad_id: mes,
        detalle: `Mes ${mes} cerrado automáticamente por el Sistema (regla de ${diasCierre} días)` });
    }
  }
}

/* ── GET /api/meses-cerrados ─────────────────────────────────────────── */
const getAll = async (_req, res) => {
  try {
    const [cfg] = await pool.query("SELECT valor FROM config_meses WHERE clave = 'dias_cierre'");
    const diasCierre = cfg.length ? parseInt(cfg[0].valor) : 35;

    // Ejecutar cierre automático antes de leer
    await ejecutarCierreAutomatico(diasCierre);

    const [rows] = await pool.query('SELECT * FROM meses_cerrados');
    const map = {};
    rows.forEach(r => { map[r.mes] = r; });

    const meses = generarMeses(24).map(mes => {
      const dias = diasDesdeFinMes(mes);
      const row  = map[mes] || {};
      const cerrado = row.cerrado ? true : false;

      // Calcular si hay re-cierre automático pendiente (fue abierto manualmente, plazo activo)
      let recierre_en_horas = null;
      if (!cerrado && row.abierto_at) {
        const horasDesdeApertura = (Date.now() - new Date(row.abierto_at).getTime()) / 3600000;
        if (horasDesdeApertura < 24) {
          recierre_en_horas = Math.ceil(24 - horasDesdeApertura);
        }
      }

      return {
        mes,
        cerrado,
        cerrado_at:        row.cerrado_at  || null,
        abierto_at:        row.abierto_at  || null,
        auto_cierre:       row.auto_cierre ? true : false,
        dias_transcurridos: dias,
        sugerido_cerrar:   dias >= diasCierre && !cerrado,
        recierre_en_horas,
      };
    });

    res.json({ success: true, data: { meses, dias_cierre: diasCierre }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/meses-cerrados/:mes ────────────────────────────────────── */
const toggle = async (req, res) => {
  try {
    const { mes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(mes))
      return res.status(400).json({ success: false, data: null, error: 'Formato mes inválido (YYYY-MM)' });

    const { cerrado } = req.body;
    const cerradoPor = req.usuario?.id_usuario || null;

    if (cerrado) {
      // Cierre manual
      await pool.query(`
        INSERT INTO meses_cerrados (mes, cerrado, cerrado_at, cerrado_por, auto_cierre)
        VALUES (?, 1, NOW(), ?, 0)
        ON DUPLICATE KEY UPDATE cerrado=1, cerrado_at=NOW(), cerrado_por=VALUES(cerrado_por), auto_cierre=0
      `, [mes, cerradoPor]);
    } else {
      // Apertura manual → guardar abierto_at para el re-cierre automático a las 24h
      await pool.query(`
        INSERT INTO meses_cerrados (mes, cerrado, cerrado_at, abierto_at, auto_cierre)
        VALUES (?, 0, NULL, NOW(), 0)
        ON DUPLICATE KEY UPDATE cerrado=0, cerrado_at=NULL, abierto_at=NOW(), auto_cierre=0
      `, [mes]);
    }

    auditar({ req, accion: 'CIERRE_MES', modulo: 'meses-cerrados', entidad: 'mes', entidad_id: mes,
      detalle: cerrado ? `Cerró el mes ${mes}` : `Reabrió el mes ${mes}` });
    res.json({ success: true, data: { mes, cerrado }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/meses-cerrados/config/dias-cierre ─────────────────────── */
const setDiasCierre = async (req, res) => {
  try {
    const v = parseInt(req.body.dias);
    if (!v || v < 1 || v > 365)
      return res.status(400).json({ success: false, data: null, error: 'Valor inválido (1-365)' });
    await pool.query("UPDATE config_meses SET valor=? WHERE clave='dias_cierre'", [String(v)]);
    auditar({ req, accion: 'EDITAR', modulo: 'meses-cerrados', entidad: 'config', entidad_id: 'dias_cierre',
      detalle: `Cambió los días para cierre automático a ${v}` });
    res.json({ success: true, data: { dias_cierre: v }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/meses-cerrados/check/:mes ─────────────────────────────── */
const checkMes = async (req, res) => {
  try {
    const { mes } = req.params;
    const [rows] = await pool.query('SELECT cerrado FROM meses_cerrados WHERE mes=? LIMIT 1', [mes]);
    res.json({ success: true, data: { mes, cerrado: rows.length ? !!rows[0].cerrado : false }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, toggle, setDiasCierre, checkMes };
