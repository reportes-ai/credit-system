const pool = require('../../../../shared/config/database');
const { verifyToken } = require('../../../../shared/middleware/auth');

const CONFIG_KEY = 'workflow_estados_v1';

// ── Migración tabla ────────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_config (
        config_key   VARCHAR(80)  NOT NULL PRIMARY KEY,
        config_value MEDIUMTEXT   NOT NULL,
        updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('[workflow] CREATE TABLE:', e.message);
  }
})();

// ── Etapas por defecto ─────────────────────────────────────────────────────
const DEFAULT_ETAPAS = [
  {
    id: 'INGRESO', nombre: 'Ingresado', color: '#854d0e', bg: '#fef9c3',
    icono: 'bi-pencil-square', orden: 1, terminal: false,
    perfiles_ver:     ['Administrador','Ejecutivo Comercial','Analista de Crédito'],
    perfiles_aprobar: ['Ejecutivo Comercial','Administrador'],
    escalamiento: { activo: false, dias: 2, notificar: ['Administrador'] },
    descripcion: 'El Ejecutivo Comercial ingresa los datos del crédito',
  },
  {
    id: 'CARGA_RESPALDOS', nombre: 'Carga Respaldos', color: '#c2410c', bg: '#ffedd5',
    icono: 'bi-paperclip', orden: 2, terminal: false,
    perfiles_ver:     ['Administrador','Ejecutivo Comercial','Analista de Crédito'],
    perfiles_aprobar: ['Ejecutivo Comercial','Administrador'],
    escalamiento: { activo: true, dias: 1, notificar: ['Administrador'] },
    descripcion: 'El Ejecutivo carga los documentos del cliente',
  },
  {
    id: 'EN_ANALISIS', nombre: 'En Análisis', color: '#5b21b6', bg: '#f5f3ff',
    icono: 'bi-clipboard2-check', orden: 3, terminal: false,
    perfiles_ver:     ['Administrador','Analista de Crédito'],
    perfiles_aprobar: ['Analista de Crédito','Administrador'],
    escalamiento: { activo: true, dias: 1, notificar: ['Administrador'] },
    descripcion: 'El Analista de Crédito aprueba el crédito y valida los documentos',
  },
  {
    id: 'EMISION_DOCUMENTOS', nombre: 'Emisión Documentos', color: '#0369a1', bg: '#e0f2fe',
    icono: 'bi-file-earmark-text', orden: 4, terminal: false,
    perfiles_ver:     ['Administrador','Ejecutivo Comercial'],
    perfiles_aprobar: ['Ejecutivo Comercial','Administrador'],
    escalamiento: { activo: true, dias: 2, notificar: ['Administrador'] },
    descripcion: 'El Ejecutivo Comercial emite y obtiene firmas de los documentos',
  },
  {
    id: 'CARGA_DOCUMENTOS_AF', nombre: 'Carga Docs. AF', color: '#7e22ce', bg: '#faf5ff',
    icono: 'bi-cloud-upload', orden: 5, terminal: false,
    perfiles_ver:     ['Administrador','Ejecutivo Comercial','Analista de Crédito'],
    perfiles_aprobar: ['Ejecutivo Comercial','Administrador'],
    escalamiento: { activo: true, dias: 1, notificar: ['Administrador','Analista de Crédito'] },
    descripcion: 'El Ejecutivo sube los documentos firmados al sistema',
  },
  {
    id: 'VALIDACION_FIRMA', nombre: 'Validación Firma', color: '#b45309', bg: '#fffbeb',
    icono: 'bi-pen-fill', orden: 6, terminal: false,
    perfiles_ver:     ['Administrador','Analista de Crédito'],
    perfiles_aprobar: ['Analista de Crédito','Administrador'],
    escalamiento: { activo: true, dias: 1, notificar: ['Administrador'] },
    descripcion: 'El Analista valida las firmas de los documentos uno a uno',
  },
  {
    id: 'VIGENTE', nombre: 'Vigente', color: '#166534', bg: '#dcfce7',
    icono: 'bi-check-circle-fill', orden: 7, terminal: true,
    perfiles_ver:     ['Administrador','Ejecutivo Comercial','Analista de Crédito'],
    perfiles_aprobar: [],
    escalamiento: { activo: false, dias: 0, notificar: [] },
    descripcion: 'Crédito otorgado y vigente',
  },
];

// ── GET ────────────────────────────────────────────────────────────────────
exports.get = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT config_value FROM workflow_config WHERE config_key = ?', [CONFIG_KEY]
    );
    const etapas = rows.length ? JSON.parse(rows[0].config_value) : DEFAULT_ETAPAS;
    res.json({ success: true, data: etapas });
  } catch (e) {
    console.error('[workflow] get:', e);
    res.status(500).json({ success: false, error: e.message });
  }
};

// ── PUT ────────────────────────────────────────────────────────────────────
exports.put = async (req, res) => {
  try {
    const { etapas } = req.body;
    if (!Array.isArray(etapas) || etapas.length === 0)
      return res.status(400).json({ success: false, error: 'etapas inválidas' });
    // Re-asignar orden según posición del array
    const ordenadas = etapas.map((e, i) => ({ ...e, orden: i + 1 }));
    await pool.query(`
      INSERT INTO workflow_config (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()
    `, [CONFIG_KEY, JSON.stringify(ordenadas)]);
    res.json({ success: true, data: ordenadas });
  } catch (e) {
    console.error('[workflow] put:', e);
    res.status(500).json({ success: false, error: e.message });
  }
};
