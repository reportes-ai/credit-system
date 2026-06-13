'use strict';
const pool = require('../../../../shared/config/database');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

/* Genera numero_credito igual que creditos.controller (YYMMXXX) */
async function generarNumeroCreditoDesdeCartas() {
  const hoy = new Date();
  const yy = String(hoy.getFullYear()).slice(-2);
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const prefix = `${yy}${mm}`;
  const [[row]] = await pool.query(
    `SELECT numero_credito FROM creditos WHERE numero_credito LIKE ? ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  const seq = row ? parseInt(row.numero_credito.slice(4)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

/* Crea registro en creditos a partir de una carta y devuelve { id, numero_credito } */
async function crearCreditoDesdeCartas(c) {
  const rutNorm = (c.rut_cliente || c.rutCliente || '').replace(/\./g, '').toUpperCase().trim();
  const [[cliRow]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut = ? LIMIT 1', [rutNorm]).catch(() => [[null]]);
  const numero_credito = await generarNumeroCreditoDesdeCartas();
  // Mapear acreedor → financiera
  const finMap = { 'AUTOFIN': 'AUTOFIN', 'AUTOFACIL': 'AUTOFACIL', 'UNIDAD': 'UNIDAD DE CREDITO', 'UNIDAD DE CREDITO': 'UNIDAD DE CREDITO' };
  const financiera = finMap[(c.acreedor || '').toUpperCase()] || 'AUTOFACIL';
  const saldo = c.saldo || null;
  const precio = c.precio_venta || c.precioVenta || null;
  const pie = c.pie || null;
  const pct = (precio && saldo) ? saldo / precio : null;

  const [r] = await pool.query(`
    INSERT INTO creditos
      (numero_credito, financiera, estado_eval, estado,
       id_cliente, rut_concesionario, vendedor,
       fecha_otorgado, mes, valor_vehiculo, pie, saldo_precio, pct_financiado,
       monto_financiado, plazo, tascli_real,
       tipo_vehiculo, marca, modelo, anio, patente,
       automotora, ejecutivo, comdea_real,
       created_at, updated_at)
    VALUES (?,?,
            'OTORGADO','INGRESO',
            ?,?,?,
            NULL, DATE_FORMAT(NOW(),'%Y-%m-01'), ?,?,?,?,
            ?,?,?,
            ?,?,?,?,?,
            ?,?,?,
            NOW(),NOW())
  `, [
    numero_credito, financiera,
    cliRow?.id_cliente || null,
    (c.rut_conc || c.rutConc || null),
    (c.vendedor || null),
    precio, pie, saldo, pct,
    (c.monto_credito_clp || c.montoCreditoCLP || null),
    (c.plazo || null),
    (c.tasa_credito || c.tasaCredito || null),
    (c.tipo_vehiculo || c.tipoVehiculo || null),
    (c.marca || null), (c.modelo || null), (c.anio || null), (c.patente || null),
    (c.concesionario || null),
    (c.ejecutivo_nombre || c.ejecutivoNombre || null),
    (c.part_bruto || c.partBruto || null),
  ]);
  return { id: r.insertId, numero_credito };
}

/* Usuarios activos con permiso de revisar cartas (incluye Administradores) */
async function idsRevisores(excluirEmail) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u
       JOIN perfiles p ON p.id_perfil = u.id_perfil
     WHERE p.nombre = 'Administrador' AND u.estado = 'activo' AND u.email <> ?
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil = u.id_perfil
       JOIN funcionalidades f  ON f.id_funcionalidad = pp.id_funcionalidad
     WHERE f.codigo = 'aprob_revisar' AND pp.habilitado = 1
       AND u.estado = 'activo' AND u.email <> ?`,
    [excluirEmail || '', excluirEmail || '']
  );
  return rows.map(r => r.id_usuario);
}

// Auto-migración: crea tablas si no existen
(async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS cartas_ejecutivos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL,
      mail VARCHAR(150) DEFAULT NULL,
      tel VARCHAR(30) DEFAULT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS cartas_parametros (
      \`key\` VARCHAR(100) NOT NULL PRIMARY KEY,
      \`value\` LONGTEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by VARCHAR(150) DEFAULT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cartas_aprobacion (
      id INT AUTO_INCREMENT PRIMARY KEY,
      op_carta VARCHAR(30) DEFAULT NULL,
      id_financiera VARCHAR(50) DEFAULT NULL,
      tipo VARCHAR(50) DEFAULT NULL,
      ejecutivo_idx INT DEFAULT NULL,
      ejecutivo_nombre VARCHAR(150) DEFAULT NULL,
      ejecutivo_mail VARCHAR(150) DEFAULT NULL,
      ejecutivo_tel VARCHAR(30) DEFAULT NULL,
      cliente VARCHAR(200) DEFAULT NULL,
      rut_cliente VARCHAR(20) DEFAULT NULL,
      tipo_vehiculo VARCHAR(50) DEFAULT NULL,
      marca VARCHAR(100) DEFAULT NULL,
      modelo VARCHAR(100) DEFAULT NULL,
      anio VARCHAR(10) DEFAULT NULL,
      patente VARCHAR(20) DEFAULT NULL,
      prenda VARCHAR(10) DEFAULT NULL,
      precio_venta BIGINT DEFAULT NULL,
      pie BIGINT DEFAULT NULL,
      saldo BIGINT DEFAULT NULL,
      plazo INT DEFAULT NULL,
      acreedor VARCHAR(100) DEFAULT NULL,
      parque VARCHAR(150) DEFAULT NULL,
      concesionario VARCHAR(200) DEFAULT NULL,
      rut_conc VARCHAR(20) DEFAULT NULL,
      vendedor VARCHAR(150) DEFAULT NULL,
      part_neto BIGINT DEFAULT NULL,
      part_iva BIGINT DEFAULT NULL,
      part_bruto BIGINT DEFAULT NULL,
      fecha DATE DEFAULT NULL,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      creado_por VARCHAR(150) DEFAULT NULL,
      creado_por_nombre VARCHAR(200) DEFAULT NULL,
      creado_por_initials VARCHAR(10) DEFAULT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE',
      aprobado_por VARCHAR(150) DEFAULT NULL,
      aprobado_por_nombre VARCHAR(200) DEFAULT NULL,
      aprobado_por_initials VARCHAR(10) DEFAULT NULL,
      fecha_aprobacion DATETIME DEFAULT NULL,
      rechazado_por VARCHAR(150) DEFAULT NULL,
      rechazado_por_nombre VARCHAR(200) DEFAULT NULL,
      fecha_rechazo DATETIME DEFAULT NULL,
      motivo_rechazo TEXT DEFAULT NULL,
      anulado_por VARCHAR(150) DEFAULT NULL,
      fecha_anulacion DATETIME DEFAULT NULL,
      eliminado_por VARCHAR(150) DEFAULT NULL,
      fecha_eliminacion DATETIME DEFAULT NULL,
      fecha_correccion DATETIME DEFAULT NULL,
      corregido_por VARCHAR(150) DEFAULT NULL,
      otorgado TINYINT(1) NOT NULL DEFAULT 0,
      fecha_otorgado DATETIME DEFAULT NULL,
      tasa_credito DECIMAL(8,4) DEFAULT NULL,
      monto_credito_clp BIGINT DEFAULT NULL,
      monto_credito_uf DECIMAL(12,4) DEFAULT NULL,
      excepciones JSON DEFAULT NULL,
      excepciones_comentarios JSON DEFAULT NULL,
      INDEX idx_status (status),
      INDEX idx_fecha (fecha),
      INDEX idx_rut_cliente (rut_cliente),
      INDEX idx_creado_por (creado_por)
    )`
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); }
    catch (e) { console.error('[cartas migration]', e.message); }
  }

  // Agregar columnas numero_credito_creado e id_credito_creado si no existen
  try {
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS numero_credito_creado VARCHAR(30) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS id_credito_creado INT DEFAULT NULL`);
  } catch(e) { /* columna ya existe */ }

  // Homologación: renombrar op_origen → id_financiera (alinear con creditos.id_financiera)
  try {
    const [[oc]] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'cartas_aprobacion' AND column_name = 'op_origen'`);
    if (oc.c > 0) {
      await pool.query(`ALTER TABLE cartas_aprobacion CHANGE COLUMN op_origen id_financiera VARCHAR(50) DEFAULT NULL`);
    }
  } catch(e) { console.error('[cartas migration rename op_origen]', e.message); }

  // Seed ejecutivos si la tabla está vacía
  try {
    const [[{ cnt }]] = await pool.query('SELECT COUNT(*) AS cnt FROM cartas_ejecutivos');
    if (cnt === 0) {
      const seed = [
        ['Solange Vucina',      'solange.vucina@autofacilchile.cl',      '+56976354089'],
        ['Tatiana Arriagada',   'tatiana.arriagada@autofacilchile.cl',   '+56949808667'],
        ['Alvaro Pinochet',     'alvaro.pinochet@autofacilchile.cl',     '+56978730681'],
        ['Alvaro Vargas',       'alvaro.vargas@autofacilchile.cl',       '+56934998273'],
        ['Carlo Moreno',        'carlo.moreno@autofacilchile.cl',        '+56932280210'],
        ['Karen Farías',        'karen.farias@autofacilchile.cl',        '+56931250518'],
        ['Luis Soto Ravello',   'luis.soto@autofacilchile.cl',           '+56981980972'],
        ['Florencia Bazan',     'florencia.bazan@autofacilchile.cl',     '+56951930421'],
        ['Sebastian Millar',    'sebastian.millar@autofacilchile.cl',    '+56937496188'],
        ['Juan Muñoz',          'juan.munoz@autofacilchile.cl',          '+56966184542'],
        ['Cristina Peña',       'cristina.pena@autofacilchile.cl',       '+56932645136'],
        ['Catherinne Vargas',   'catherinne.vargas@autofacilchile.cl',   '+56989216789'],
        ['Claudia Vergara',     'claudia.vergara@autofacilchile.cl',     '+56968796402'],
      ];
      for (const [nombre, mail, tel] of seed) {
        await pool.query(
          'INSERT IGNORE INTO cartas_ejecutivos (nombre, mail, tel) VALUES (?,?,?)',
          [nombre, mail, tel]
        );
      }
      console.log('✓ cartas_ejecutivos: seeded con lista inicial de ejecutivos');
    }
  } catch (e) { console.error('[cartas ejecutivos seed]', e.message); }
})();

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseJSON(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

function mapRow(r) {
  // Participación dealer: usa lo guardado en la carta o, si no viene, deriva del
  // crédito enlazado (comdea_real = bruto con IVA → neto = bruto/1.19).
  const brutoStore = Number(r.part_bruto) || 0;
  const brutoCred  = Number(r.cred_comdea_real) || 0;
  const partBruto  = brutoStore || brutoCred || null;
  const partNeto   = (r.part_neto != null) ? r.part_neto : (partBruto ? Math.round(partBruto / 1.19) : null);
  const partIVA    = (r.part_iva  != null) ? r.part_iva  : (partBruto ? partBruto - Math.round(partBruto / 1.19) : null);
  const cv = (a, b) => (a == null || a === '' || a === 0) ? (b ?? null) : a;
  return {
    id:                       r.id,
    opCarta:                  r.op_carta,
    opOrigen:                 r.id_financiera,
    tipo:                     r.tipo,
    ejecutivoIdx:             r.ejecutivo_idx,
    ejecutivoNombre:          r.ejecutivo_nombre,
    ejecutivoMail:            r.ejecutivo_mail,
    ejecutivoTel:             r.ejecutivo_tel,
    cliente:                  r.cliente,
    rutCliente:               r.rut_cliente,
    tipoVehiculo:             cv(r.tipo_vehiculo, r.cred_tipo_vehiculo),
    marca:                    cv(r.marca, r.cred_marca),
    modelo:                   cv(r.modelo, r.cred_modelo),
    anio:                     cv(r.anio, r.cred_anio),
    patente:                  cv(r.patente, r.cred_patente),
    prenda:                   r.prenda,
    precioVenta:              cv(r.precio_venta, r.cred_valor_vehiculo),
    pie:                      cv(r.pie, r.cred_pie),
    saldo:                    r.saldo,
    plazo:                    cv(r.plazo, r.cred_plazo),
    acreedor:                 r.acreedor,
    parque:                   r.parque,
    concesionario:            r.concesionario,
    rutConc:                  r.rut_conc,
    vendedor:                 r.vendedor,
    partNeto:                 partNeto,
    partIVA:                  partIVA,
    partBruto:                partBruto,
    fecha:                    r.fecha,
    fechaCreacion:            r.fecha_creacion,
    creadoPor:                r.creado_por,
    creadoPorNombre:          r.creado_por_nombre,
    creadoPorInitials:        r.creado_por_initials,
    status:                   r.status,
    aprobadoPor:              r.aprobado_por,
    aprobadoPorNombre:        r.aprobado_por_nombre,
    aprobadoPorInitials:      r.aprobado_por_initials,
    fechaAprobacion:          r.fecha_aprobacion,
    rechazadoPor:             r.rechazado_por,
    rechazadoPorNombre:       r.rechazado_por_nombre,
    fechaRechazo:             r.fecha_rechazo,
    motivoRechazo:            r.motivo_rechazo,
    anuladoPor:               r.anulado_por,
    fechaAnulacion:           r.fecha_anulacion,
    eliminadoPor:             r.eliminado_por,
    fechaEliminacion:         r.fecha_eliminacion,
    fechaCorreccion:          r.fecha_correccion,
    corregidoPor:             r.corregido_por,
    otorgado:                 !!r.otorgado,
    fechaOtorgado:            r.fecha_otorgado,
    tasaCredito:              r.tasa_credito ? parseFloat(r.tasa_credito) : 0,
    montoCreditoCLP:          r.monto_credito_clp,
    montoCreditoUF:           r.monto_credito_uf ? parseFloat(r.monto_credito_uf) : 0,
    excepciones:              parseJSON(r.excepciones) || [],
    excepcionesComentarios:   parseJSON(r.excepciones_comentarios),
    numeroCreditoCreado:      r.numero_credito_creado || null,
    idCreditoCreado:          r.id_credito_creado || null,
    numOp:                    r.cred_num_op || null,                                  // NUESTRO N° de operación (creditos.num_op)
    numeroCredito:            r.cred_numero_credito || r.numero_credito_creado || null,
  };
}

// ── Permiso aprob_ver_todas: perfil base + override individual ───────────────
// Transición segura: si el perfil NO tiene registro del permiso (no configurado
// aún en Perfiles y Permisos), se mantiene el comportamiento histórico (ve todas).
// Al guardar la matriz de permisos queda 0/1 explícito y se aplica la restricción.
async function puedeVerTodas(usuario) {
  if (!usuario) return false;
  if (usuario.perfil_nombre === 'Administrador') return true;
  try {
    const [[ov]] = await pool.query(
      `SELECT pu.habilitado FROM permisos_usuario pu
       JOIN funcionalidades f ON f.id_funcionalidad = pu.id_funcionalidad
       WHERE pu.id_usuario = ? AND f.codigo = 'aprob_ver_todas'`,
      [usuario.id_usuario]
    );
    if (ov) return ov.habilitado === 1;
  } catch (_) { /* tabla permisos_usuario puede no existir */ }
  try {
    const [[pp]] = await pool.query(
      `SELECT pp.habilitado FROM permisos_perfil pp
       JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
       WHERE pp.id_perfil = ? AND f.codigo = 'aprob_ver_todas'`,
      [usuario.id_perfil]
    );
    return pp ? pp.habilitado === 1 : true; // sin registro → legacy: ve todas
  } catch (_) { return true; }
}

// ── Controladores ─────────────────────────────────────────────────────────────

const getAll = async (req, res) => {
  try {
    const verTodas = await puedeVerTodas(req.usuario);
    const login = req.usuario?.email || String(req.usuario?.id_usuario || '');
    // JOIN al crédito enlazado: NUESTRO N° de operación (num_op), numero_credito,
    // y datos de vehículo/participación como respaldo cuando la carta no los trae.
    const SEL = `SELECT ca.*, cr.num_op AS cred_num_op, cr.numero_credito AS cred_numero_credito,
                   cr.tipo_vehiculo AS cred_tipo_vehiculo, cr.marca AS cred_marca, cr.modelo AS cred_modelo,
                   cr.anio AS cred_anio, cr.patente AS cred_patente, cr.valor_vehiculo AS cred_valor_vehiculo,
                   cr.pie AS cred_pie, cr.plazo AS cred_plazo, cr.comdea_real AS cred_comdea_real
                 FROM cartas_aprobacion ca
                 LEFT JOIN creditos cr ON cr.id = ca.id_credito_creado`;
    const [rows] = verTodas
      ? await pool.query(`${SEL} ORDER BY ca.fecha_creacion DESC`)
      : await pool.query(`${SEL} WHERE ca.creado_por = ? ORDER BY ca.fecha_creacion DESC`, [login]);
    res.json({ success: true, data: rows.map(mapRow), verTodas, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const upsert = async (req, res) => {
  try {
    const c = req.body;
    // Estado previo (para detectar transiciones que generan notificación)
    let prevStatus = null;
    if (c.id) {
      const [[prev]] = await pool.query('SELECT status FROM cartas_aprobacion WHERE id = ?', [c.id]);
      prevStatus = prev?.status || null;
    }
    const vals = [
      c.opCarta, c.opOrigen, c.tipo,
      c.ejecutivoIdx || null, c.ejecutivoNombre, c.ejecutivoMail, c.ejecutivoTel,
      c.cliente, c.rutCliente,
      c.tipoVehiculo, c.marca, c.modelo, c.anio, c.patente, c.prenda,
      c.precioVenta || null, c.pie || null, c.saldo || null,
      c.plazo || null, c.acreedor, c.parque,
      c.concesionario, c.rutConc, c.vendedor,
      c.partNeto || null, c.partIVA || null, c.partBruto || null,
      c.fecha || null, c.fechaCreacion || new Date(),
      c.creadoPor, c.creadoPorNombre, c.creadoPorInitials,
      c.status || 'PENDIENTE',
      c.aprobadoPor || null, c.aprobadoPorNombre || null, c.aprobadoPorInitials || null,
      c.fechaAprobacion || null,
      c.rechazadoPor || null, c.rechazadoPorNombre || null,
      c.fechaRechazo || null, c.motivoRechazo || null,
      c.anuladoPor || null, c.fechaAnulacion || null,
      c.eliminadoPor || null, c.fechaEliminacion || null,
      c.fechaCorreccion || null, c.corregidoPor || null,
      c.otorgado ? 1 : 0, c.fechaOtorgado || null,
      c.tasaCredito || null,
      c.montoCreditoCLP || null,
      c.montoCreditoUF || null,
      c.excepciones ? JSON.stringify(c.excepciones) : null,
      c.excepcionesComentarios ? JSON.stringify(c.excepcionesComentarios) : null,
      c.numeroCreditoCreado || null,
      c.idCreditoCreado || null,
    ];

    if (c.id) {
      // UPDATE existente
      await pool.query(
        `UPDATE cartas_aprobacion SET
          op_carta=?, id_financiera=?, tipo=?,
          ejecutivo_idx=?, ejecutivo_nombre=?, ejecutivo_mail=?, ejecutivo_tel=?,
          cliente=?, rut_cliente=?,
          tipo_vehiculo=?, marca=?, modelo=?, anio=?, patente=?, prenda=?,
          precio_venta=?, pie=?, saldo=?,
          plazo=?, acreedor=?, parque=?,
          concesionario=?, rut_conc=?, vendedor=?,
          part_neto=?, part_iva=?, part_bruto=?,
          fecha=?, fecha_creacion=?,
          creado_por=?, creado_por_nombre=?, creado_por_initials=?,
          status=?,
          aprobado_por=?, aprobado_por_nombre=?, aprobado_por_initials=?,
          fecha_aprobacion=?,
          rechazado_por=?, rechazado_por_nombre=?,
          fecha_rechazo=?, motivo_rechazo=?,
          anulado_por=?, fecha_anulacion=?,
          eliminado_por=?, fecha_eliminacion=?,
          fecha_correccion=?, corregido_por=?,
          otorgado=?, fecha_otorgado=?,
          tasa_credito=?, monto_credito_clp=?, monto_credito_uf=?,
          excepciones=?, excepciones_comentarios=?,
          numero_credito_creado=?, id_credito_creado=?
        WHERE id=?`,
        [...vals, c.id]
      );
      res.json({ success: true, data: { id: c.id }, error: null });
      // Sincronizar estado del crédito vinculado
      if (c.idCreditoCreado || c.id_credito_creado) {
        const idCred = c.idCreditoCreado || c.id_credito_creado;
        if (c.status === 'APROBADA') {
          pool.query(`UPDATE creditos SET estado='CARTA_APROBACION', updated_at=NOW() WHERE id=? AND estado='INGRESO'`, [idCred]).catch(e => console.error('[carta→credito estado]', e.message));
        } else if (c.status === 'RECHAZADA') {
          pool.query(`UPDATE creditos SET estado='INGRESO', updated_at=NOW() WHERE id=? AND estado='CARTA_APROBACION'`, [idCred]).catch(e => console.error('[carta→credito estado]', e.message));
        }
      }
      notificarCambios(c, prevStatus);
    } else {
      // INSERT nuevo: crear crédito asociado primero
      let credCreado = null;
      try { credCreado = await crearCreditoDesdeCartas(c); } catch(e) { console.error('[carta→credito]', e.message); }
      if (credCreado) {
        vals[vals.length - 2] = credCreado.numero_credito; // numero_credito_creado
        vals[vals.length - 1] = credCreado.id;             // id_credito_creado
      }
      const [r] = await pool.query(
        `INSERT INTO cartas_aprobacion (
          op_carta, id_financiera, tipo,
          ejecutivo_idx, ejecutivo_nombre, ejecutivo_mail, ejecutivo_tel,
          cliente, rut_cliente,
          tipo_vehiculo, marca, modelo, anio, patente, prenda,
          precio_venta, pie, saldo,
          plazo, acreedor, parque,
          concesionario, rut_conc, vendedor,
          part_neto, part_iva, part_bruto,
          fecha, fecha_creacion,
          creado_por, creado_por_nombre, creado_por_initials,
          status,
          aprobado_por, aprobado_por_nombre, aprobado_por_initials,
          fecha_aprobacion,
          rechazado_por, rechazado_por_nombre,
          fecha_rechazo, motivo_rechazo,
          anulado_por, fecha_anulacion,
          eliminado_por, fecha_eliminacion,
          fecha_correccion, corregido_por,
          otorgado, fecha_otorgado,
          tasa_credito, monto_credito_clp, monto_credito_uf,
          excepciones, excepciones_comentarios,
          numero_credito_creado, id_credito_creado
        ) VALUES (${vals.map(() => '?').join(',')})`,
        vals
      );
      res.status(201).json({ success: true, data: { id: r.insertId, numero_credito_creado: credCreado?.numero_credito || null }, error: null });
      notificarCambios(c, null);
    }
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* Notificaciones del flujo (no bloquea la respuesta HTTP) */
function notificarCambios(c, prevStatus) {
  (async () => {
    try {
      const esNuevaPendiente   = !prevStatus && c.status === 'PENDIENTE';
      const vuelveAlPool       = prevStatus === 'RECHAZADA' && c.status === 'PENDIENTE';
      const resuelta           = prevStatus === 'PENDIENTE' && (c.status === 'APROBADA' || c.status === 'RECHAZADA');

      if (esNuevaPendiente || vuelveAlPool) {
        const ids = await idsRevisores(c.creadoPor);
        // Cliente esperando → alta prioridad y sonido distinto para que no pase desapercibida
        await notificar(ids, {
          tipo: 'CARTA_NUEVA',
          titulo: vuelveAlPool ? '🔁 Carta corregida para revisión' : '🛎️ Nueva carta para revisión',
          mensaje: `${c.creadoPorNombre || 'Un ejecutivo'} envió la carta ${c.opCarta || ''} — ${c.cliente || ''}`,
          href: '/aprobaciones/?tab=revision',
          prioridad: 'alta', sonar: 1, son_tipo: 'dingdong',
        });
      }
      if (resuelta) {
        const [[u]] = await pool.query('SELECT id_usuario FROM usuarios WHERE email = ? LIMIT 1', [c.creadoPor]);
        if (u) {
          const ok = c.status === 'APROBADA';
          // Resolución → al ejecutivo, alta prioridad (también tiene al cliente esperando)
          await notificar([u.id_usuario], {
            tipo: 'CARTA_' + c.status,
            titulo: ok ? '✅ Carta aprobada' : '❌ Carta rechazada',
            mensaje: ok
              ? `Tu carta ${c.opCarta || ''} (${c.cliente || ''}) fue aprobada — ya puedes imprimirla`
              : `Tu carta ${c.opCarta || ''} fue rechazada${c.motivoRechazo ? ': ' + c.motivoRechazo : ''}. Corrígela y reenvíala.`,
            href: '/aprobaciones/',
            prioridad: 'alta', sonar: 1, son_tipo: ok ? 'dingdong' : 'alarma',
          });
        }
      }
    } catch (e) { console.error('[cartas notif]', e.message); }
  })();
}

/* ── Carga masiva de Cartas de Aprobación (histórico) ──────────────────────────
   Por cada fila: genera op_carta = YY + N°ID + iniciales ejecutivo; enlaza al crédito
   por N° OPERACIÓN si existe (respeta sus datos), o crea cliente+crédito (YYMMxxx) si falta. */
const _inicEjec = (nombre) => {
  const w = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase();
};
const _normRut = (r) => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
const _num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return isNaN(n) ? null : Math.round(n); };
async function _numeroCreditoMes(yy, mm) {
  const prefix = `${yy}${mm}`;
  const [[row]] = await pool.query(
    `SELECT numero_credito FROM creditos WHERE numero_credito LIKE ? ORDER BY numero_credito DESC LIMIT 1`, [prefix + '%']);
  const seq = row && /^\d+$/.test(row.numero_credito.slice(4)) ? parseInt(row.numero_credito.slice(4)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

const cargaMasivaCartas = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, data: null, error: 'Sin filas para cargar' });
    const u = req.usuario || {};
    const creadoPor = u.email || 'carga-masiva';
    const creadoPorNombre = ((u.nombre || '') + ' ' + (u.apellido || '')).trim() || 'Carga Masiva';
    const finMap = { AUTOFIN: 'AUTOFIN', AUTOFACIL: 'AUTOFACIL', UNIDAD: 'UNIDAD DE CREDITO', 'UNIDAD DE CREDITO': 'UNIDAD DE CREDITO' };

    let creadas = 0, omitidas = 0, enlazadas = 0, creditosCreados = 0, clientesCreados = 0;
    const errores = [];

    for (const r of rows) {
      try {
        const nId = String(r.nId || '').trim();
        const ejec = String(r.ejecutivo || '').trim();
        const nOp = String(r.nOp || '').trim();
        if (!nId || !ejec) { errores.push({ nOp, error: 'Falta N° ID o ejecutivo' }); continue; }

        const fecha = r.mes ? new Date(r.mes) : null;
        const valida = fecha && !isNaN(fecha);
        const yy = String(valida ? fecha.getFullYear() : new Date().getFullYear()).slice(-2);
        const mm = String((valida ? fecha.getMonth() : new Date().getMonth()) + 1).padStart(2, '0');
        const fechaISO = valida ? fecha.toISOString().slice(0, 10) : null;
        const opCarta = `${yy}${nId}${_inicEjec(ejec)}`;

        const [[ya]] = await pool.query('SELECT id FROM cartas_aprobacion WHERE op_carta=? LIMIT 1', [opCarta]);
        if (ya) { omitidas++; continue; }

        const rutCli = _normRut(r.rutCliente);
        const rutConc = _normRut(r.rutConc);
        const saldo = _num(r.saldo);
        const comision = _num(r.comision);
        const financiera = finMap[String(r.acreedor || '').toUpperCase()] || 'AUTOFACIL';

        // Enlazar a crédito existente por N° OPERACIÓN, o crear cliente+crédito
        let idCredito = null, numeroCredito = null, veh = {};
        let credito = null;
        if (nOp) { const [[cr]] = await pool.query('SELECT * FROM creditos WHERE num_op=? LIMIT 1', [nOp]); credito = cr || null; }
        if (credito) {
          idCredito = credito.id;
          numeroCredito = credito.numero_credito || null;
          veh = { tipo_vehiculo: credito.tipo_vehiculo, marca: credito.marca, modelo: credito.modelo,
                  anio: credito.anio, patente: credito.patente, precio: credito.valor_vehiculo,
                  pie: credito.pie, plazo: credito.plazo };
          enlazadas++;
        } else {
          let idCliente = null;
          if (rutCli) {
            const [[clx]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut=? LIMIT 1', [rutCli]);
            if (clx) idCliente = clx.id_cliente;
            else { const [ci] = await pool.query('INSERT INTO clientes (rut, nombre_completo) VALUES (?,?)', [rutCli, r.cliente || null]); idCliente = ci.insertId; clientesCreados++; }
          }
          numeroCredito = await _numeroCreditoMes(yy, mm);
          const [ci] = await pool.query(
            `INSERT INTO creditos (numero_credito, num_op, financiera, estado_eval, estado, id_cliente,
               rut_concesionario, vendedor, fecha_otorgado, mes, saldo_precio, automotora, ejecutivo, comdea_real, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
            [numeroCredito, nOp || null, financiera, 'OTORGADO', 'INGRESO', idCliente,
             rutConc || null, r.vendedor || null, fechaISO, valida ? fechaISO.slice(0, 7) + '-01' : null,
             saldo, r.concesionario || null, ejec, comision]);
          idCredito = ci.insertId; creditosCreados++;
        }

        await pool.query(
          `INSERT INTO cartas_aprobacion
             (op_carta, id_financiera, ejecutivo_nombre, cliente, rut_cliente,
              tipo_vehiculo, marca, modelo, anio, patente, precio_venta, pie, saldo, plazo,
              acreedor, concesionario, rut_conc, vendedor, part_bruto, fecha,
              creado_por, creado_por_nombre, status, otorgado, fecha_otorgado, fecha_aprobacion,
              numero_credito_creado, id_credito_creado)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [opCarta, nId, ejec, r.cliente || null, rutCli || null,
           veh.tipo_vehiculo || null, veh.marca || null, veh.modelo || null, veh.anio || null, veh.patente || null,
           veh.precio || null, veh.pie || null, saldo, veh.plazo || null,
           r.acreedor || null, r.concesionario || null, rutConc || null, r.vendedor || null, comision, fechaISO,
           creadoPor, creadoPorNombre, 'APROBADA', 1, fechaISO, fechaISO,
           numeroCredito, idCredito]);
        creadas++;
      } catch (eRow) { errores.push({ nOp: r.nOp, error: eRow.message }); }
    }
    res.json({ success: true, data: { total: rows.length, creadas, enlazadas, creditosCreados, clientesCreados, omitidas, errores }, error: null });
  } catch (e) {
    console.error('[cartas cargaMasiva]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getAll, upsert, cargaMasivaCartas };
