'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   CAMPAÑAS DE VENTA (CRM TELEFÓNICO)
   - Bases EXTERNAS (ej.: cartera de otra institución para portabilidad):
     NUNCA se cargan en las tablas normales; viven en tablas propias cv_*.
   - Homologación de campos A MANO: al subir la base se muestran las columnas
     del archivo y el admin mapea cada una contra el catálogo (campos de
     nuestras tablas + campos manuales). El mapeo queda guardado en la campaña.
   - Términos de gestión PARAMÉTRICOS por campaña (contacto directo/indirecto,
     no contactado, fuera de servicio, etc.), con rellamado programado en X
     minutos y destino POOL o EJECUTIVO (el mismo que llamó).
   - Discador manual: entrega registros 1 a 1 en el orden definido por el
     administrador; primero rellamados vencidos (míos, luego pool), después
     la cola de pendientes. Lock paramétrico para que dos ejecutivos no
     tomen el mismo registro.
   - Estadísticas: penetración, contactabilidad, conversión, montos colocados,
     por término y por ejecutivo. Conversión cruza con créditos otorgados
     por RUT posterior al inicio de la campaña (además de la venta manual).
   ───────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const safeJSON = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return null; } };

/* ── Catálogo ÚNICO de campos homologables (backend = fuente de verdad) ──
   grupo CLIENTE espeja columnas de nuestras tablas (clientes); el resto son
   campos manuales de campaña (crédito externo, vehículo, libres). */
const CAMPOS = [
  { key: 'rut',              label: 'RUT Cliente',            grupo: 'Cliente' },
  { key: 'nombre',           label: 'Nombre Cliente',         grupo: 'Cliente' },
  { key: 'email',            label: 'Email',                  grupo: 'Cliente' },
  { key: 'telefono_1',       label: 'Teléfono 1',             grupo: 'Cliente' },
  { key: 'telefono_2',       label: 'Teléfono 2',             grupo: 'Cliente' },
  { key: 'telefono_3',       label: 'Teléfono 3',             grupo: 'Cliente' },
  { key: 'direccion',        label: 'Dirección',              grupo: 'Cliente' },
  { key: 'comuna',           label: 'Comuna',                 grupo: 'Cliente' },
  { key: 'ciudad',           label: 'Ciudad',                 grupo: 'Cliente' },
  { key: 'renta',            label: 'Renta Estimada $',       grupo: 'Cliente', num: true },
  { key: 'institucion',      label: 'Institución del Crédito',grupo: 'Crédito Externo' },
  { key: 'num_operacion',    label: 'N° Operación (externa)', grupo: 'Crédito Externo' },
  { key: 'producto',         label: 'Producto',               grupo: 'Crédito Externo' },
  { key: 'fecha_otorgamiento',label:'Fecha Otorgamiento',     grupo: 'Crédito Externo' },
  { key: 'plazo',            label: 'Plazo (cuotas)',         grupo: 'Crédito Externo', num: true },
  { key: 'cuotas_pagadas',   label: 'Cuotas Pagadas',         grupo: 'Crédito Externo', num: true },
  { key: 'avance_pct',       label: '% Avance del Crédito',   grupo: 'Crédito Externo', num: true },
  { key: 'monto_financiado', label: 'Monto Financiado $',     grupo: 'Crédito Externo', num: true },
  { key: 'capital_adeudado', label: 'Capital Adeudado $',     grupo: 'Crédito Externo', num: true },
  { key: 'deuda_vigente',    label: 'Deuda Vigente $',        grupo: 'Crédito Externo', num: true },
  { key: 'valor_cuota',      label: 'Valor Cuota $',          grupo: 'Crédito Externo', num: true },
  { key: 'tasa',             label: 'Tasa',                   grupo: 'Crédito Externo', num: true },
  { key: 'pie',              label: 'Pie $',                  grupo: 'Crédito Externo', num: true },
  { key: 'pct_pie',          label: '% Pie',                  grupo: 'Crédito Externo', num: true },
  { key: 'dias_mora',        label: 'Días de Mora',           grupo: 'Crédito Externo', num: true },
  { key: 'estado_pago',      label: 'Estado de Pago',         grupo: 'Crédito Externo' },
  { key: 'marca',            label: 'Marca Vehículo',         grupo: 'Vehículo' },
  { key: 'modelo',           label: 'Modelo Vehículo',        grupo: 'Vehículo' },
  { key: 'anio_vehiculo',    label: 'Año Vehículo',           grupo: 'Vehículo', num: true },
  { key: 'patente',          label: 'Patente (PPU)',          grupo: 'Vehículo' },
  { key: 'avaluo',           label: 'Avalúo $',               grupo: 'Vehículo', num: true },
  { key: 'oferta',           label: 'Oferta Especial Cliente', grupo: 'Otros' },
  { key: 'tramo_renta',      label: 'Tramo Renta',            grupo: 'Otros' },
  { key: 'tramo_deuda',      label: 'Tramo Deuda',            grupo: 'Otros' },
  { key: 'comentario',       label: 'Comentario',             grupo: 'Otros' },
  { key: 'libre1',           label: 'Campo Libre 1',          grupo: 'Otros' },
  { key: 'libre2',           label: 'Campo Libre 2',          grupo: 'Otros' },
  { key: 'libre3',           label: 'Campo Libre 3',          grupo: 'Otros' },
  { key: 'libre4',           label: 'Campo Libre 4',          grupo: 'Otros' },
  { key: 'libre5',           label: 'Campo Libre 5',          grupo: 'Otros' },
];
const CAMPO_KEYS = new Set(CAMPOS.map(c => c.key));

/* Tipos de término de gestión (estructura fija; el contenido es paramétrico) */
const TIPOS_TERMINO = [
  { key: 'CONTACTO_DIRECTO',   label: 'Contacto Directo' },
  { key: 'CONTACTO_INDIRECTO', label: 'Contacto Indirecto' },
  { key: 'NO_CONTACTO',        label: 'No Contactado' },
  { key: 'INHABILITADO',       label: 'Teléfono Inhabilitado' },
];
const TIPO_KEYS = new Set(TIPOS_TERMINO.map(t => t.key));

/* Términos por defecto que se siembran al crear cada campaña (100% editables) */
const TERMINOS_DEFAULT = [
  { nombre: 'VENTA CERRADA',            tipo: 'CONTACTO_DIRECTO',   es_cierre: 1, es_venta: 1, rellamar_min: null, destino: null },
  { nombre: 'INTERESADO — VOLVER A LLAMAR', tipo: 'CONTACTO_DIRECTO', es_cierre: 0, es_venta: 0, rellamar_min: 1440, destino: 'EJECUTIVO' },
  { nombre: 'LLAMAR MÁS TARDE',             tipo: 'CONTACTO_DIRECTO', es_cierre: 0, es_venta: 0, rellamar_min: null, destino: null, es_agenda: 1 },
  { nombre: 'NO LE INTERESA',           tipo: 'CONTACTO_DIRECTO',   es_cierre: 1, es_venta: 0, rellamar_min: null, destino: null },
  { nombre: 'NO CUMPLE REQUISITOS',     tipo: 'CONTACTO_DIRECTO',   es_cierre: 1, es_venta: 0, rellamar_min: null, destino: null },
  { nombre: 'RECADO CON TERCERO',       tipo: 'CONTACTO_INDIRECTO', es_cierre: 0, es_venta: 0, rellamar_min: 240,  destino: 'POOL' },
  { nombre: 'NO CONTESTA',              tipo: 'NO_CONTACTO',        es_cierre: 0, es_venta: 0, rellamar_min: 240,  destino: 'POOL' },
  { nombre: 'OCUPADO',                  tipo: 'NO_CONTACTO',        es_cierre: 0, es_venta: 0, rellamar_min: 60,   destino: 'POOL' },
  { nombre: 'BUZÓN DE VOZ',             tipo: 'NO_CONTACTO',        es_cierre: 0, es_venta: 0, rellamar_min: 240,  destino: 'POOL' },
  { nombre: 'FUERA DE SERVICIO',        tipo: 'INHABILITADO',       es_cierre: 0, es_venta: 0, rellamar_min: null, destino: null },
  { nombre: 'NÚMERO EQUIVOCADO',        tipo: 'INHABILITADO',       es_cierre: 0, es_venta: 0, rellamar_min: null, destino: null },
];

/* ── Migración ──────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cv_campanas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        correlativo VARCHAR(20) NOT NULL UNIQUE,
        nombre VARCHAR(200) NOT NULL,
        descripcion VARCHAR(400) NULL,
        estado VARCHAR(12) NOT NULL DEFAULT 'BORRADOR',   -- BORRADOR|ACTIVA|PAUSADA|CERRADA
        archivo_nombre VARCHAR(250) NULL,                 -- nombre del Excel/CSV original
        mapeo JSON NULL,                                  -- { "columna del archivo": "campo homologado" }
        orden_campo VARCHAR(40) NULL,                     -- campo del catálogo que ordena el discado
        orden_dir VARCHAR(4) NOT NULL DEFAULT 'ASC',
        lock_minutos INT NOT NULL DEFAULT 20,
        activada_at DATETIME NULL,
        cerrada_at DATETIME NULL,
        created_by INT NULL, created_nombre VARCHAR(120) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cv_terminos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_campana INT NOT NULL,
        nombre VARCHAR(120) NOT NULL,
        tipo VARCHAR(20) NOT NULL,                        -- CONTACTO_DIRECTO|CONTACTO_INDIRECTO|NO_CONTACTO|INHABILITADO
        es_cierre TINYINT(1) NOT NULL DEFAULT 0,          -- saca el registro de la cola
        es_venta TINYINT(1) NOT NULL DEFAULT 0,           -- marca conversión (pide monto)
        rellamar_min INT NULL,                            -- reencolar en X minutos
        destino VARCHAR(10) NULL,                         -- POOL | EJECUTIVO (dueño del rellamado)
        es_agenda TINYINT(1) NOT NULL DEFAULT 0,          -- pide día + tramo horario + cautivo/pool al gestionar
        orden INT NOT NULL DEFAULT 0,
        INDEX idx_camp (id_campana)
      )`);
    await pool.query('ALTER TABLE cv_terminos ADD COLUMN IF NOT EXISTS es_agenda TINYINT(1) NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE cv_campanas ADD COLUMN IF NOT EXISTS detalle TEXT NULL');   // oferta general de la campaña
    await pool.query('ALTER TABLE cv_campanas ADD COLUMN IF NOT EXISTS script TEXT NULL');    // guion dinámico con variables {{campo}}
    // sembrar LLAMAR MÁS TARDE en campañas existentes que no lo tengan
    const [sinAgenda] = await pool.query(
      `SELECT c.id FROM cv_campanas c WHERE NOT EXISTS (SELECT 1 FROM cv_terminos t WHERE t.id_campana=c.id AND t.es_agenda=1)`);
    for (const cA of sinAgenda) {
      await pool.query(
        `INSERT INTO cv_terminos (id_campana, nombre, tipo, es_cierre, es_venta, rellamar_min, destino, es_agenda, orden)
         VALUES (?, 'LLAMAR MÁS TARDE', 'CONTACTO_DIRECTO', 0, 0, NULL, NULL, 1, 2)`, [cA.id]);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cv_registros (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_campana INT NOT NULL,
        orden_carga INT NOT NULL DEFAULT 0,
        orden_valor DECIMAL(20,6) NULL,                   -- ranking según orden_campo (recalculado)
        rut VARCHAR(15) NULL,
        nombre VARCHAR(200) NULL,
        telefonos JSON NULL,                              -- ["+569...", ...] en orden del archivo
        tel_malos JSON NULL,                              -- teléfonos marcados inhabilitados
        datos JSON NULL,                                  -- TODOS los campos homologados de la fila
        monto_referencia DECIMAL(15,2) NULL,              -- capital adeudado o monto financiado (stats)
        estado VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE',  -- PENDIENTE|AGENDADO|CERRADO
        resultado VARCHAR(120) NULL,                      -- término de cierre aplicado
        intentos INT NOT NULL DEFAULT 0,
        contactado TINYINT(1) NOT NULL DEFAULT 0,         -- tuvo al menos 1 contacto directo
        rellamado_at DATETIME NULL,
        asignado_a INT NULL,                              -- rellamado exclusivo de un ejecutivo (NULL = pool)
        lock_por INT NULL, lock_at DATETIME NULL,
        convertido TINYINT(1) NOT NULL DEFAULT 0,
        convertido_at DATETIME NULL,
        monto_convertido DECIMAL(15,2) NULL,
        convertido_via VARCHAR(12) NULL,                  -- MANUAL (término venta) | CRUCE (créditos otorgados)
        INDEX idx_camp_estado (id_campana, estado),
        INDEX idx_camp_rell (id_campana, rellamado_at),
        INDEX idx_camp_rut (id_campana, rut)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cv_gestiones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_campana INT NOT NULL,
        id_registro INT NOT NULL,
        id_usuario INT NULL, usuario_nombre VARCHAR(120) NULL,
        telefono VARCHAR(30) NULL,
        id_termino INT NULL, termino_nombre VARCHAR(120) NULL, tipo VARCHAR(20) NULL,
        comentario VARCHAR(500) NULL,
        rellamado_at DATETIME NULL,
        monto_venta DECIMAL(15,2) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reg (id_registro), INDEX idx_camp (id_campana), INDEX idx_camp_user (id_campana, id_usuario)
      )`);

    // Card en el Home (anti-hardcode: módulo + funcionalidades + permiso Admin)
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (470001, 'Campañas de Venta (CRM)', 'CRM telefónico: bases externas homologadas, discador con rellamados y estadísticas de conversión', 'bi-telephone-outbound-fill', '/campanas-ventas/', 117, 'activo')`);
    for (const f of [
      { codigo: 'campanas_ventas',       nombre: 'Campañas de Venta (CRM)',   href: '/campanas-ventas/', icono: 'bi-telephone-outbound-fill' },
      { codigo: 'campanas_ventas_admin', nombre: 'Administrar Campañas Venta', href: null,               icono: 'bi-gear' },
    ]) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idFunc = ex && ex.id_funcionalidad;
      if (!idFunc) {
        const [r] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (470001, ?, ?, ?, ?)`,
          [f.nombre, f.codigo, f.href, f.icono]);
        idFunc = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idFunc]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idFunc]);
    }
    console.log('[campanas-ventas] módulo listo');
  } catch (e) { console.error('[campanas-ventas migration]', e.message); }
})();

/* ── Helpers de normalización — las bases vienen de procedencias MUY
   distintas, así que cada dato clave se normaliza a un formato canónico ── */

/* Teléfonos: acepta +56 9 7765 3059 / 9-7765-3059 / 977653059 / 77653059 /
   notación científica de Excel (5.6977653059E10) y VARIOS números en una
   celda separados por ; , / | "y" "·". Canónico: dígitos con prefijo 56. */
const normFonos = v => {
  if (v === null || v === undefined || v === '') return [];
  let s = typeof v === 'number' ? String(Math.round(v)) : String(v);
  return s.split(/[;,\/|·]|\s{2,}|\s+y\s+/i).map(parte => {
    let d = parte.replace(/[^\dkK]/gi, '').replace(/[kK]$/, '');   // limpia +, (), -, espacios
    d = d.replace(/^0+/, '');
    if (d.length === 8) d = '569' + d;                              // celular viejo sin el 9
    else if (d.length === 9) d = '56' + d;                          // 9XXXXXXXX o fijo con área
    else if (d.length === 11 && d.startsWith('56')) { /* ya canónico */ }
    else if (d.length === 10 && d.startsWith('56')) d = '569' + d.slice(2); // 56 + 8 dígitos
    return (d.length >= 10 && d.length <= 12) ? d : null;
  }).filter(Boolean);
};
const normFono = v => normFonos(v)[0] || null;

/* RUT: acepta 16.276.572-8 / 16276572-8 / 162765728 / 16276572 (sin DV,
   lo calcula) / K minúscula. Canónico: CUERPO-DV sin puntos, K mayúscula. */
const calcDV = cuerpo => {
  let suma = 0, mul = 2;
  for (let i = String(cuerpo).length - 1; i >= 0; i--) { suma += Number(String(cuerpo)[i]) * mul; mul = mul === 7 ? 2 : mul + 1; }
  const r = 11 - (suma % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
};
const normRut = v => {
  if (v === null || v === undefined || v === '') return null;
  let s = String(typeof v === 'number' ? Math.round(v) : v).toUpperCase().replace(/[^\dK]/g, '');
  if (s.length < 7 || s.length > 10) return null;
  const cuerpo9 = s.slice(0, -1), dv9 = s.slice(-1);
  if (calcDV(cuerpo9) === dv9) return `${cuerpo9}-${dv9}`;          // último carácter era el DV
  if (/^\d+$/.test(s) && s.length <= 9) return `${s}-${calcDV(s)}`; // venía sin DV: se calcula
  return `${cuerpo9}-${dv9}`;                                       // DV no cuadra: se conserva igual (se cuenta aparte)
};
const rutValido = r => { const [cu, dv] = String(r || '').split('-'); return !!cu && calcDV(cu) === dv; };

/* Números: number nativo de Excel intacto; strings en formato es-CL
   (1.234.567,89), US (1,234,567.89), con $, %, CLP o espacios. */
const toNum = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;   // Excel entrega números crudos: no tocar el punto decimal
  let s = String(v).trim().replace(/[$\s%]|CLP/gi, '');
  const uc = s.lastIndexOf(','), ud = s.lastIndexOf('.');
  if (uc >= 0 && ud >= 0) s = uc > ud ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''); // es-CL vs US
  else if (uc >= 0) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
// tope defensivo para DECIMAL(15,2)
const toMonto = v => { const n = toNum(v); return n !== null && Math.abs(n) < 1e13 ? n : null; };

/* Fechas: serial de Excel (44349), dd/mm/aaaa, dd-mm-aaaa, aaaa-mm-dd.
   Canónico: aaaa-mm-dd. Texto no reconocible (ej. "jun-21") se conserva. */
const normFecha = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000)               // serial Excel (1900-based)
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);       // dd/mm/aaaa
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);           // aaaa-mm-dd
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s;                                                          // texto: se deja tal cual
};
const CAMPOS_FECHA = new Set(['fecha_otorgamiento']);
// expuestos solo para pruebas
exports._norm = { normRut, rutValido, normFonos, toNum, toMonto, normFecha };

async function getCampana(id) {
  const [[c]] = await pool.query('SELECT * FROM cv_campanas WHERE id=?', [id]);
  return c || null;
}

async function seedTerminos(idCampana) {
  const values = TERMINOS_DEFAULT.map((t, i) =>
    [idCampana, t.nombre, t.tipo, t.es_cierre, t.es_venta, t.rellamar_min, t.destino, t.es_agenda ? 1 : 0, i]);
  await pool.query(
    `INSERT INTO cv_terminos (id_campana, nombre, tipo, es_cierre, es_venta, rellamar_min, destino, es_agenda, orden)
     VALUES ${values.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`, values.flat());
}

/* Recalcula orden_valor de todos los registros según orden_campo/orden_dir */
async function recomputarOrden(camp) {
  if (!camp.orden_campo || camp.orden_campo === 'orden_carga') {
    await pool.query(`UPDATE cv_registros SET orden_valor = orden_carga * ${camp.orden_dir === 'DESC' ? -1 : 1} WHERE id_campana=?`, [camp.id]);
    return;
  }
  const def = CAMPOS.find(c => c.key === camp.orden_campo);
  const [rows] = await pool.query('SELECT id, datos FROM cv_registros WHERE id_campana=?', [camp.id]);
  const conVal = rows.map(r => {
    const v = (safeJSON(r.datos) || {})[camp.orden_campo];
    const num = def && def.num ? toNum(v) : null;
    return { id: r.id, v: num !== null ? num : String(v ?? '') };
  });
  conVal.sort((a, b) => {
    const na = typeof a.v === 'number', nb = typeof b.v === 'number';
    let cmp = na && nb ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'es');
    return camp.orden_dir === 'DESC' ? -cmp : cmp;
  });
  // batch update por CASE (en trozos, TiDB agradece)
  for (let i = 0; i < conVal.length; i += 500) {
    const chunk = conVal.slice(i, i + 500);
    await pool.query(
      `UPDATE cv_registros SET orden_valor = CASE id ${chunk.map(() => 'WHEN ? THEN ?').join(' ')} END
       WHERE id IN (${chunk.map(() => '?').join(',')})`,
      [...chunk.flatMap((c, j) => [c.id, i + j]), ...chunk.map(c => c.id)]);
  }
}

/* ── Catálogo ───────────────────────────────────────────────────────────── */
exports.catalogo = (req, res) => ok(res, { campos: CAMPOS, tipos_termino: TIPOS_TERMINO });

/* ── CRUD campañas ──────────────────────────────────────────────────────── */
exports.listar = async (req, res) => {
  try {
    const historicas = req.query.historicas === '1';
    const [rows] = await pool.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM cv_registros r WHERE r.id_campana=c.id) total,
        (SELECT COUNT(*) FROM cv_registros r WHERE r.id_campana=c.id AND r.intentos>0) gestionados,
        (SELECT COUNT(*) FROM cv_registros r WHERE r.id_campana=c.id AND r.contactado=1) contactados,
        (SELECT COUNT(*) FROM cv_registros r WHERE r.id_campana=c.id AND r.convertido=1) ventas,
        (SELECT IFNULL(SUM(r.monto_convertido),0) FROM cv_registros r WHERE r.id_campana=c.id AND r.convertido=1) monto_vendido
       FROM cv_campanas c
       WHERE c.estado ${historicas ? '=' : '<>'} 'CERRADA'
       ORDER BY c.id DESC`);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

exports.crear = async (req, res) => {
  try {
    const { nombre, descripcion } = req.body || {};
    if (!nombre || !String(nombre).trim()) return fail(res, 'Falta el nombre de la campaña', 400);
    const [[m]] = await pool.query("SELECT IFNULL(MAX(CAST(SUBSTRING(correlativo,4) AS UNSIGNED)),0) n FROM cv_campanas");
    const correlativo = 'CV-' + String(m.n + 1).padStart(4, '0');
    const [r] = await pool.query(
      `INSERT INTO cv_campanas (correlativo, nombre, descripcion, created_by, created_nombre)
       VALUES (?,?,?,?,?)`,
      [correlativo, String(nombre).trim().slice(0, 200), (descripcion || '').slice(0, 400) || null,
       req.user?.id_usuario || null, req.user?.nombre_completo || req.user?.nombre || null]);
    await seedTerminos(r.insertId);
    ok(res, { id: r.insertId, correlativo });
  } catch (e) { fail(res, e.message); }
};

exports.obtener = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const [terminos] = await pool.query('SELECT * FROM cv_terminos WHERE id_campana=? ORDER BY orden, id', [c.id]);
    const [[cnt]] = await pool.query(
      `SELECT COUNT(*) total,
        SUM(estado='PENDIENTE') pendientes, SUM(estado='AGENDADO') agendados, SUM(estado='CERRADO') cerrados,
        SUM(intentos>0) gestionados, SUM(contactado=1) contactados, SUM(convertido=1) ventas
       FROM cv_registros WHERE id_campana=?`, [c.id]);
    c.mapeo = safeJSON(c.mapeo);
    ok(res, { campana: c, terminos, contadores: cnt });
  } catch (e) { fail(res, e.message); }
};

exports.actualizar = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const { nombre, descripcion, orden_campo, orden_dir, lock_minutos, detalle, script } = req.body || {};
    const oc = (orden_campo === 'orden_carga' || CAMPO_KEYS.has(orden_campo)) ? orden_campo : c.orden_campo;
    const od = ['ASC', 'DESC'].includes(orden_dir) ? orden_dir : c.orden_dir;
    await pool.query(
      `UPDATE cv_campanas SET nombre=?, descripcion=?, orden_campo=?, orden_dir=?, lock_minutos=?, detalle=?, script=? WHERE id=?`,
      [nombre ? String(nombre).trim().slice(0, 200) : c.nombre,
       descripcion !== undefined ? (descripcion || '').slice(0, 400) || null : c.descripcion,
       oc, od, Math.max(5, Math.min(240, parseInt(lock_minutos, 10) || c.lock_minutos)),
       detalle !== undefined ? (detalle || '').slice(0, 4000) || null : c.detalle,
       script  !== undefined ? (script  || '').slice(0, 8000) || null : c.script, c.id]);
    if (oc !== c.orden_campo || od !== c.orden_dir) await recomputarOrden({ ...c, orden_campo: oc, orden_dir: od });
    ok(res, { actualizado: true });
  } catch (e) { fail(res, e.message); }
};

exports.cambiarEstado = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const { estado } = req.body || {};
    if (!['BORRADOR', 'ACTIVA', 'PAUSADA', 'CERRADA'].includes(estado)) return fail(res, 'Estado inválido', 400);
    if (estado === 'ACTIVA') {
      const [[n]] = await pool.query('SELECT COUNT(*) n FROM cv_registros WHERE id_campana=?', [c.id]);
      if (!n.n) return fail(res, 'La campaña no tiene registros cargados', 400);
    }
    await pool.query(
      `UPDATE cv_campanas SET estado=?,
        activada_at = IF(?='ACTIVA' AND activada_at IS NULL, NOW(), activada_at),
        cerrada_at  = IF(?='CERRADA', NOW(), cerrada_at) WHERE id=?`,
      [estado, estado, estado, c.id]);
    ok(res, { estado });
  } catch (e) { fail(res, e.message); }
};

exports.eliminar = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'Solo se puede eliminar una campaña en borrador', 400);
    await pool.query('DELETE FROM cv_gestiones WHERE id_campana=?', [c.id]);
    await pool.query('DELETE FROM cv_registros WHERE id_campana=?', [c.id]);
    await pool.query('DELETE FROM cv_terminos WHERE id_campana=?', [c.id]);
    await pool.query('DELETE FROM cv_campanas WHERE id=?', [c.id]);
    ok(res, { eliminado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Términos de gestión (paramétricos por campaña) ─────────────────────── */
exports.guardarTerminos = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const terminos = Array.isArray(req.body?.terminos) ? req.body.terminos : [];
    if (!terminos.length) return fail(res, 'Debe haber al menos un término', 400);
    for (const t of terminos) {
      if (!t.nombre || !String(t.nombre).trim()) return fail(res, 'Término sin nombre', 400);
      if (!TIPO_KEYS.has(t.tipo)) return fail(res, `Tipo inválido: ${t.tipo}`, 400);
    }
    // conservar ids para no romper el historial de gestiones: update los que vienen con id, insert los nuevos, delete el resto
    const [actuales] = await pool.query('SELECT id FROM cv_terminos WHERE id_campana=?', [c.id]);
    const vivos = new Set();
    let orden = 0;
    for (const t of terminos) {
      const row = [String(t.nombre).trim().slice(0, 120), t.tipo, t.es_cierre ? 1 : 0, t.es_venta ? 1 : 0,
        t.rellamar_min ? Math.max(1, parseInt(t.rellamar_min, 10)) : null,
        ['POOL', 'EJECUTIVO'].includes(t.destino) ? t.destino : null, t.es_agenda ? 1 : 0, orden++];
      if (t.id && actuales.some(a => a.id === Number(t.id))) {
        await pool.query('UPDATE cv_terminos SET nombre=?, tipo=?, es_cierre=?, es_venta=?, rellamar_min=?, destino=?, es_agenda=?, orden=? WHERE id=? AND id_campana=?',
          [...row, t.id, c.id]);
        vivos.add(Number(t.id));
      } else {
        const [r] = await pool.query('INSERT INTO cv_terminos (nombre, tipo, es_cierre, es_venta, rellamar_min, destino, es_agenda, orden, id_campana) VALUES (?,?,?,?,?,?,?,?,?)',
          [...row, c.id]);
        vivos.add(r.insertId);
      }
    }
    const borrar = actuales.filter(a => !vivos.has(a.id)).map(a => a.id);
    if (borrar.length) await pool.query(`DELETE FROM cv_terminos WHERE id_campana=? AND id IN (${borrar.map(() => '?').join(',')})`, [c.id, ...borrar]);
    ok(res, { guardados: terminos.length });
  } catch (e) { fail(res, e.message); }
};

/* ── Carga de registros con mapeo homologado ────────────────────────────── */
exports.cargarRegistros = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'Solo se puede cargar la base en borrador', 400);
    const { mapeo, filas, archivo_nombre } = req.body || {};
    if (!mapeo || typeof mapeo !== 'object') return fail(res, 'Falta el mapeo de campos', 400);
    const destinos = Object.values(mapeo).filter(v => v && v !== 'IGNORAR');
    if (!destinos.includes('rut')) return fail(res, 'El mapeo debe incluir el campo RUT Cliente', 400);
    if (!destinos.some(d => d.startsWith('telefono_'))) return fail(res, 'El mapeo debe incluir al menos un Teléfono', 400);
    for (const d of destinos) if (!CAMPO_KEYS.has(d)) return fail(res, `Campo destino inválido: ${d}`, 400);
    const rows = Array.isArray(filas) ? filas.slice(0, 50000) : [];
    if (!rows.length) return fail(res, 'Sin filas', 400);

    await pool.query('DELETE FROM cv_gestiones WHERE id_campana=?', [c.id]);
    await pool.query('DELETE FROM cv_registros WHERE id_campana=?', [c.id]);

    let cargados = 0, sinRut = 0, sinFono = 0, dvMalos = 0;
    const values = [];
    rows.forEach((fila, idx) => {
      const datos = {};
      for (const [colOrigen, campo] of Object.entries(mapeo)) {
        if (!campo || campo === 'IGNORAR') continue;
        const v = fila[colOrigen];
        if (v === undefined || v === null || v === '') continue;
        datos[campo] = typeof v === 'string' ? v.trim() : v;
      }
      // normalización a formato canónico (las bases vienen en cualquier formato)
      const telefonos = [...new Set(['telefono_1', 'telefono_2', 'telefono_3'].flatMap(k => normFonos(datos[k])))];
      const rut = normRut(datos.rut);
      if (!rut) { sinRut++; return; }
      if (!telefonos.length) { sinFono++; return; }
      if (!rutValido(rut)) dvMalos++;                    // se carga igual, pero se informa
      datos.rut = rut;
      for (const k of CAMPOS_FECHA) if (datos[k] !== undefined) datos[k] = normFecha(datos[k]);
      const montoRef = toMonto(datos.capital_adeudado) ?? toMonto(datos.deuda_vigente) ?? toMonto(datos.monto_financiado);
      values.push([c.id, idx, idx, rut.slice(0, 15), String(datos.nombre || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
        JSON.stringify(telefonos), JSON.stringify(datos), montoRef]);
      cargados++;
    });
    if (!values.length) return fail(res, 'Ninguna fila válida (todas sin RUT o sin teléfono)', 400);
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      await pool.query(
        `INSERT INTO cv_registros (id_campana, orden_carga, orden_valor, rut, nombre, telefonos, datos, monto_referencia)
         VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`, chunk.flat());
    }
    await pool.query('UPDATE cv_campanas SET mapeo=?, archivo_nombre=? WHERE id=?',
      [JSON.stringify(mapeo), (archivo_nombre || '').slice(0, 250) || null, c.id]);
    if (c.orden_campo) await recomputarOrden(await getCampana(c.id));
    ok(res, { cargados, sin_rut: sinRut, sin_telefono: sinFono, rut_dv_invalido: dvMalos });
  } catch (e) { fail(res, e.message); }
};

exports.registros = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const pag = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const porPag = 100;
    const where = ['id_campana=?']; const params = [c.id];
    if (req.query.estado) { where.push('estado=?'); params.push(req.query.estado); }
    if (req.query.q) { where.push('(rut LIKE ? OR nombre LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const [[tot]] = await pool.query(`SELECT COUNT(*) n FROM cv_registros WHERE ${where.join(' AND ')}`, params);
    const [rows] = await pool.query(
      `SELECT id, orden_carga, rut, nombre, telefonos, estado, resultado, intentos, contactado,
              rellamado_at, asignado_a, convertido, monto_convertido, monto_referencia, datos
       FROM cv_registros WHERE ${where.join(' AND ')}
       ORDER BY orden_valor ASC, id ASC LIMIT ? OFFSET ?`, [...params, porPag, (pag - 1) * porPag]);
    ok(res, { total: tot.n, pagina: pag, por_pagina: porPag, rows });
  } catch (e) { fail(res, e.message); }
};

/* ── DISCADOR ───────────────────────────────────────────────────────────── */
/* Orden de la cola:
   1. Mi registro ya tomado (lock vigente) — para retomar tras recargar.
   2. Rellamados vencidos asignados a MÍ.
   3. Rellamados vencidos del POOL (asignado_a NULL).
   4. Pendientes según el orden del administrador (orden_valor). */
exports.siguiente = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'ACTIVA') return fail(res, 'La campaña no está activa', 400);
    const uid = req.user?.id_usuario || 0;
    const lockMin = c.lock_minutos || 20;
    const libre = `(lock_por IS NULL OR lock_por=? OR lock_at < DATE_SUB(NOW(), INTERVAL ${lockMin} MINUTE))`;

    const candidatos = [
      [`estado<>'CERRADO' AND lock_por=? AND lock_at >= DATE_SUB(NOW(), INTERVAL ${lockMin} MINUTE)`, [uid], 'lock_at DESC'],
      [`estado='AGENDADO' AND rellamado_at<=NOW() AND asignado_a=? AND ${libre}`, [uid, uid], 'rellamado_at ASC'],
      [`estado='AGENDADO' AND rellamado_at<=NOW() AND asignado_a IS NULL AND ${libre}`, [uid], 'rellamado_at ASC'],
      [`estado='PENDIENTE' AND ${libre}`, [uid], 'orden_valor ASC, id ASC'],
    ];
    let reg = null;
    for (const [cond, params, orden] of candidatos) {
      // hasta 5 intentos por carrera de locks
      for (let i = 0; i < 5 && !reg; i++) {
        const [[cand]] = await pool.query(
          `SELECT id FROM cv_registros WHERE id_campana=? AND ${cond} ORDER BY ${orden} LIMIT 1 OFFSET ${i}`, [c.id, ...params]);
        if (!cand) break;
        const [r] = await pool.query(
          `UPDATE cv_registros SET lock_por=?, lock_at=NOW()
           WHERE id=? AND (lock_por IS NULL OR lock_por=? OR lock_at < DATE_SUB(NOW(), INTERVAL ${lockMin} MINUTE))`,
          [uid, cand.id, uid]);
        if (r.affectedRows) { const [[row]] = await pool.query('SELECT * FROM cv_registros WHERE id=?', [cand.id]); reg = row; }
      }
      if (reg) break;
    }
    // contadores de cola para el header del discador
    const [[cola]] = await pool.query(
      `SELECT SUM(estado='PENDIENTE') pendientes,
              SUM(estado='AGENDADO' AND rellamado_at<=NOW() AND (asignado_a IS NULL OR asignado_a=?)) rellamados_listos,
              SUM(estado='AGENDADO' AND rellamado_at>NOW()) agendados_futuros
       FROM cv_registros WHERE id_campana=?`, [uid, c.id]);
    if (!reg) return ok(res, { registro: null, cola });

    reg.telefonos = safeJSON(reg.telefonos) || [];
    reg.tel_malos = safeJSON(reg.tel_malos) || [];
    reg.datos = safeJSON(reg.datos) || {};
    const [gestiones] = await pool.query(
      'SELECT * FROM cv_gestiones WHERE id_registro=? ORDER BY id DESC LIMIT 30', [reg.id]);
    // teléfonos por contactabilidad: contacto directo → sin intentos → indirecto → no contacto → inhabilitados
    const score = {};
    for (const t of reg.telefonos) score[t] = 5;
    for (const g of gestiones) {
      if (!g.telefono || !(g.telefono in score)) continue;
      const s = g.tipo === 'CONTACTO_DIRECTO' ? 1 : g.tipo === 'CONTACTO_INDIRECTO' ? 6 : g.tipo === 'NO_CONTACTO' ? 7 : 9;
      score[g.telefono] = Math.min(score[g.telefono] === 5 ? 99 : score[g.telefono], s); // 5 = nunca llamado se conserva solo si no hay gestión
    }
    for (const t of reg.tel_malos) score[t] = 9;
    reg.telefonos_ordenados = [...reg.telefonos].sort((a, b) => (score[a] ?? 5) - (score[b] ?? 5));
    const [terminos] = await pool.query('SELECT * FROM cv_terminos WHERE id_campana=? ORDER BY orden, id', [c.id]);
    ok(res, { registro: reg, gestiones, terminos, cola, campana: { detalle: c.detalle, script: c.script } });
  } catch (e) { fail(res, e.message); }
};

exports.liberar = async (req, res) => {
  try {
    const uid = req.user?.id_usuario || 0;
    await pool.query('UPDATE cv_registros SET lock_por=NULL, lock_at=NULL WHERE id_campana=? AND lock_por=?', [req.params.id, uid]);
    ok(res, { liberado: true });
  } catch (e) { fail(res, e.message); }
};

/* Saltar: libera el registro y lo manda al FINAL de la cola de pendientes
   (si no, «tomar siguiente» devolvería el mismo cliente de inmediato). */
exports.saltar = async (req, res) => {
  try {
    const uid = req.user?.id_usuario || 0;
    const idReg = parseInt(req.body?.id_registro, 10);
    if (!idReg) return fail(res, 'Falta id_registro', 400);
    const [[mx]] = await pool.query('SELECT IFNULL(MAX(orden_valor),0) mx FROM cv_registros WHERE id_campana=?', [req.params.id]);
    await pool.query(
      `UPDATE cv_registros SET lock_por=NULL, lock_at=NULL, orden_valor=?
       WHERE id=? AND id_campana=? AND (lock_por=? OR lock_por IS NULL)`,
      [Number(mx.mx) + 1, idReg, req.params.id, uid]);
    ok(res, { saltado: true });
  } catch (e) { fail(res, e.message); }
};

exports.gestionar = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const { id_registro, id_termino, telefono, comentario, monto_venta, rellamado_en, destino_agenda } = req.body || {};
    const [[reg]] = await pool.query('SELECT * FROM cv_registros WHERE id=? AND id_campana=?', [id_registro, c.id]);
    if (!reg) return fail(res, 'Registro no existe', 404);
    const [[term]] = await pool.query('SELECT * FROM cv_terminos WHERE id=? AND id_campana=?', [id_termino, c.id]);
    if (!term) return fail(res, 'Término de gestión no existe', 400);
    const uid = req.user?.id_usuario || null;
    const unombre = req.user?.nombre_completo || req.user?.nombre || null;
    const fono = normFono(telefono);

    let rellamadoAt = null, destinoRell = term.destino;
    if (term.es_agenda) {
      // agenda con día + hora elegidos por el ejecutivo (LLAMAR MÁS TARDE)
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(rellamado_en || ''))) return fail(res, 'Falta el día y la hora del rellamado', 400);
      rellamadoAt = rellamado_en + ':00';
      destinoRell = destino_agenda === 'POOL' ? 'POOL' : 'EJECUTIVO';     // cautivo por defecto
    } else if (!term.es_cierre && term.rellamar_min) {
      const [[f]] = await pool.query('SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) f', [term.rellamar_min]);
      rellamadoAt = f.f;
    }
    await pool.query(
      `INSERT INTO cv_gestiones (id_campana, id_registro, id_usuario, usuario_nombre, telefono, id_termino, termino_nombre, tipo, comentario, rellamado_at, monto_venta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [c.id, reg.id, uid, unombre, fono, term.id, term.nombre, term.tipo,
       (comentario || '').slice(0, 500) || null, rellamadoAt, term.es_venta ? toMonto(monto_venta) : null]);

    // teléfono inhabilitado → se marca malo (queda al final del orden de contactabilidad)
    let telMalos = safeJSON(reg.tel_malos) || [];
    if (term.tipo === 'INHABILITADO' && fono && !telMalos.includes(fono)) telMalos = [...telMalos, fono];

    const esContacto = term.tipo === 'CONTACTO_DIRECTO' ? 1 : reg.contactado;
    if (term.es_cierre) {
      await pool.query(
        `UPDATE cv_registros SET estado='CERRADO', resultado=?, intentos=intentos+1, contactado=?,
          tel_malos=?, rellamado_at=NULL, asignado_a=NULL, lock_por=NULL, lock_at=NULL,
          convertido = IF(?=1, 1, convertido),
          convertido_at = IF(?=1 AND convertido=0, NOW(), convertido_at),
          monto_convertido = IF(?=1, ?, monto_convertido),
          convertido_via = IF(?=1, 'MANUAL', convertido_via)
         WHERE id=?`,
        [term.nombre, esContacto, JSON.stringify(telMalos),
         term.es_venta, term.es_venta, term.es_venta, toMonto(monto_venta), term.es_venta, reg.id]);
    } else if (rellamadoAt) {
      await pool.query(
        `UPDATE cv_registros SET estado='AGENDADO', intentos=intentos+1, contactado=?, tel_malos=?,
          rellamado_at=?, asignado_a=?, lock_por=NULL, lock_at=NULL WHERE id=?`,
        [esContacto, JSON.stringify(telMalos), rellamadoAt, destinoRell === 'EJECUTIVO' ? uid : null, reg.id]);
    } else {
      // sin rellamado programado (p.ej. teléfono inhabilitado): vuelve a la cola normal
      await pool.query(
        `UPDATE cv_registros SET estado='PENDIENTE', intentos=intentos+1, contactado=?, tel_malos=?,
          rellamado_at=NULL, asignado_a=NULL, lock_por=NULL, lock_at=NULL WHERE id=?`,
        [esContacto, JSON.stringify(telMalos), reg.id]);
    }
    ok(res, { gestionado: true, rellamado_at: rellamadoAt });
  } catch (e) { fail(res, e.message); }
};

/* ── ESTADÍSTICAS ───────────────────────────────────────────────────────── */
exports.stats = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const [[base]] = await pool.query(
      `SELECT COUNT(*) total,
        SUM(estado='PENDIENTE') pendientes, SUM(estado='AGENDADO') agendados, SUM(estado='CERRADO') cerrados,
        SUM(intentos>0) gestionados, SUM(intentos) intentos_totales,
        SUM(contactado=1) contactados, SUM(convertido=1) ventas,
        IFNULL(SUM(IF(convertido=1, monto_convertido, 0)),0) monto_vendido,
        IFNULL(SUM(monto_referencia),0) monto_base
       FROM cv_registros WHERE id_campana=?`, [c.id]);
    const [porTermino] = await pool.query(
      `SELECT termino_nombre, tipo, COUNT(*) n FROM cv_gestiones WHERE id_campana=?
       GROUP BY termino_nombre, tipo ORDER BY n DESC`, [c.id]);
    const [porEjecutivo] = await pool.query(
      `SELECT g.usuario_nombre, COUNT(*) gestiones,
        SUM(g.tipo='CONTACTO_DIRECTO') contactos,
        SUM(t.es_venta=1) ventas, IFNULL(SUM(IF(t.es_venta=1, g.monto_venta, 0)),0) monto
       FROM cv_gestiones g LEFT JOIN cv_terminos t ON t.id=g.id_termino
       WHERE g.id_campana=? GROUP BY g.usuario_nombre ORDER BY gestiones DESC`, [c.id]);
    const [porDia] = await pool.query(
      `SELECT DATE(created_at) dia, COUNT(*) gestiones, SUM(tipo='CONTACTO_DIRECTO') contactos
       FROM cv_gestiones WHERE id_campana=? GROUP BY DATE(created_at) ORDER BY dia`, [c.id]);
    const t = Number(base.total) || 0, g = Number(base.gestionados) || 0,
          ct = Number(base.contactados) || 0, v = Number(base.ventas) || 0;
    ok(res, {
      base,
      indicadores: {
        penetracion_pct:      t ? +(g / t * 100).toFixed(1) : 0,   // gestionados / base
        contactabilidad_pct:  g ? +(ct / g * 100).toFixed(1) : 0,  // contactados / gestionados
        conversion_pct:       ct ? +(v / ct * 100).toFixed(1) : 0, // ventas / contactados
        tasa_conversion_base: t ? +(v / t * 100).toFixed(2) : 0,   // ventas / base total
        intentos_promedio:    g ? +(Number(base.intentos_totales) / g).toFixed(1) : 0,
      },
      por_termino: porTermino, por_ejecutivo: porEjecutivo, por_dia: porDia,
    });
  } catch (e) { fail(res, e.message); }
};

/* Cruce de conversión: RUTs de la campaña con crédito OTORGADO nuestro
   posterior a la activación de la campaña. */
exports.recalcularConversion = async (req, res) => {
  try {
    const c = await getCampana(req.params.id);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const desde = c.activada_at || c.created_at;
    const [cruces] = await pool.query(
      `SELECT r.id, cr.monto_financiado, cr.fecha_otorgado
       FROM cv_registros r
       JOIN clientes cl ON REPLACE(REPLACE(UPPER(cl.rut),'.',''),'-','') = REPLACE(REPLACE(UPPER(r.rut),'.',''),'-','')
       JOIN creditos cr ON cr.id_cliente = cl.id_cliente AND cr.estado='OTORGADO' AND cr.fecha_otorgado >= DATE(?)
       WHERE r.id_campana=? AND r.convertido=0`, [desde, c.id]);
    for (const x of cruces) {
      await pool.query(
        `UPDATE cv_registros SET convertido=1, convertido_at=?, monto_convertido=?, convertido_via='CRUCE' WHERE id=?`,
        [x.fecha_otorgado, x.monto_financiado, x.id]);
    }
    ok(res, { nuevos_convertidos: cruces.length });
  } catch (e) { fail(res, e.message); }
};
