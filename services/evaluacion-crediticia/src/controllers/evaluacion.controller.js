const pool = require('../../../../shared/config/database');
const { analizar } = require('../../../../shared/anthropic');

/* ──────────────────────────────────────────────────────────────────────────
 * Evaluación Crediticia
 * Card propia en el Home (anti-hardcode: vive en BD) + endpoint agregador que
 * arma la "ficha" del cliente por RUT: nombre, antigüedad de antecedentes y
 * cotizaciones guardadas (última primero). El pull en vivo a DealerNet lo hace
 * el módulo /api/dealernet/consultar al iniciar la evaluación.
 * ────────────────────────────────────────────────────────────────────────── */

const normRut = v => v ? String(v).replace(/\./g, '').toUpperCase().trim() : null;

// ── Sincroniza la deuda vigente del informe DealerNet (cód. 16) a informacion_comercial ──
// Mismo mapeo que usa la página de Información Comercial (r1603, M$ → pesos ×1000).
const _wgp = (o, ...ks) => { for (const k of ks) { if (o == null) return undefined; o = o[k]; } return o; };
const _warr = x => x == null ? [] : (Array.isArray(x) ? x : [x]);
function extraerDeudaDN(cont) {
  const cab = _wgp(cont, 'r1603', 'r16031') || {};
  const per = _warr(_wgp(cont, 'r1603', 'r16032'))[0];
  if (!per && cab['@_anomes'] == null) return null;
  const p = per || {};
  const n = v => { const x = Number(v); return isNaN(x) ? 0 : Math.round(x * 1000); };
  return {
    deuda_vigente_total: n(p['@_deuda_direc_vig']),
    deuda_vigente_inst:  (Number(p['@_nro_acree_cred_consumo']) || 0) + (Number(p['@_nro_inst_cred_com']) || 0),
    deuda_hipotecaria:   n(p['@_deuda_cred_hipoteca']),
    deuda_comercial:     n(p['@_deuda_comercial']),
    deuda_comercial_inst: Number(p['@_nro_inst_cred_com']) || 0,
    deuda_consumo:       n(p['@_deuda_cred_consumo']),
    deuda_consumo_inst:  Number(p['@_nro_acree_cred_consumo']) || 0,
    deuda_morosa:        n(p['@_deuda_morosa']),
    deuda_vencida:       n(p['@_deuda_venci_direc']),
    deuda_castigada:     n(p['@_deuda_cast_directa']),
    linea_disponible:    n(p['@_linea_cred_disponible']),
  };
}
async function sincronizarComercialDealernet(rutDash) {
  try {
    const dig = rutDash.replace(/[.\s-]/g, '').toUpperCase();
    const rutDN = dig.length > 1 ? dig.slice(0, -1) : dig;     // dealernet_informes guarda el RUT sin DV
    const [[inf]] = await pool.query(
      "SELECT contenido, created_at FROM dealernet_informes WHERE rut=? AND codigo_producto='16' AND retcode='0' ORDER BY created_at DESC LIMIT 1", [rutDN]);
    if (!inf) return false;
    const [[ic]] = await pool.query('SELECT updated_at FROM informacion_comercial WHERE rut_cliente=? LIMIT 1', [rutDash]);
    if (ic && ic.updated_at && new Date(ic.updated_at) >= new Date(inf.created_at)) return false;  // ya sincronizado, no pisar ediciones
    let cont = inf.contenido; if (typeof cont === 'string') { try { cont = JSON.parse(cont); } catch { return false; } }
    const d = extraerDeudaDN(cont);
    if (!d) return false;
    const cols = ['deuda_vigente_total', 'deuda_vigente_inst', 'deuda_hipotecaria', 'deuda_comercial', 'deuda_comercial_inst', 'deuda_consumo', 'deuda_consumo_inst', 'deuda_morosa', 'deuda_vencida', 'deuda_castigada', 'linea_disponible'];
    await pool.query(
      `INSERT INTO informacion_comercial (rut_cliente, ${cols.join(', ')}) VALUES (${['?', ...cols.map(() => '?')].join(', ')})
       ON DUPLICATE KEY UPDATE ${cols.map(c => `${c}=VALUES(${c})`).join(', ')}, updated_at=CURRENT_TIMESTAMP`,
      [rutDash, ...cols.map(c => d[c])]);
    return true;
  } catch (e) { console.error('[sincronizarComercialDealernet]', e.message); return false; }
}

(async () => {
  try {
    // Documentos que el ejecutivo carga para evaluar (por RUT + documento requerido).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS evaluacion_documentos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        rut_cliente    VARCHAR(15)  NOT NULL,
        ocupacion      VARCHAR(80),
        documento      VARCHAR(255) NOT NULL,
        archivo_nombre VARCHAR(500),
        archivo_size   INT,
        mime_type      VARCHAR(120),
        archivo_data   LONGBLOB,
        subido_por     INT,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_rut_doc (rut_cliente, documento),
        INDEX idx_evdoc_rut (rut_cliente)
      )`);
    for (const sql of [
      'ALTER TABLE evaluacion_documentos ADD COLUMN validado TINYINT NULL',          // 1 ok · 0 observado · null sin validar
      'ALTER TABLE evaluacion_documentos ADD COLUMN validacion_texto VARCHAR(255) NULL',
      'ALTER TABLE evaluacion_documentos ADD COLUMN validacion_url VARCHAR(300) NULL', // validador de la AFP detectada
    ]) { try { await pool.query(sql); } catch (e) { if (e.errno !== 1060) console.error('[evdoc alter]', e.message); } }

    // Módulo/card propio "Evaluación Crediticia" en el Home.
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (390001, 'Evaluación Crediticia',
               'Evalúa crediticiamente a un cliente por RUT: antecedentes, cotizaciones e informe DealerNet',
               'bi-clipboard-pulse', '/evaluacion-crediticia/', 106, 'activo')`);

    // Funcionalidad (genera la card por permiso y el sub-item gestionable).
    let idFunc;
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='evaluacion_crediticia' LIMIT 1");
    if (ex) idFunc = ex.id_funcionalidad;
    else {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (390001,?,?,?,?)",
        ['Evaluación Crediticia', 'evaluacion_crediticia', '/evaluacion-crediticia/', 'bi-clipboard-pulse']);
      idFunc = r.insertId;
    }

    // Permisos por defecto: Administrador (bypass igual) + perfiles que evalúan crédito.
    const nombres = ['Administrador', 'Gerente', 'Ejecutivo', 'Ejecutivo Comercial',
                     'Analista', 'Supervisor de Crédito', 'Jefe Comercial'];
    const [perfs] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre IN (?)', [nombres]);
    for (const { id_perfil } of perfs) {
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [id_perfil, idFunc]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [id_perfil, idFunc]);
    }
    console.log('[evaluacion-crediticia] módulo/card y permisos listos');
  } catch (e) { console.error('[evaluacion-crediticia migration]', e.message); }
})();

/* GET /api/evaluacion-crediticia/ficha/:rut — ficha del cliente para evaluar */
const ficha = async (req, res) => {
  try {
    const rut = normRut(decodeURIComponent(req.params.rut || ''));
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido' });

    // 1) Cliente (nombre + fecha antecedentes personales)
    let cliente = null;
    try {
      const [[c]] = await pool.query(
        'SELECT rut, nombre_completo, nombres, apellido_paterno, apellido_materno, fecha_actualizacion, fecha_creacion FROM clientes WHERE rut=? LIMIT 1', [rut]);
      if (c) {
        const armado = [c.nombres, c.apellido_paterno, c.apellido_materno].filter(Boolean).join(' ').trim();
        cliente = { rut: c.rut, nombre: (c.nombre_completo && c.nombre_completo.trim()) || armado || null,
                    fecha: c.fecha_actualizacion || c.fecha_creacion || null };
      }
    } catch (_) {}
    // Fallback: nombre desde créditos (carga masiva) si no está en clientes
    if (!cliente) {
      try {
        const [[op]] = await pool.query(
          `SELECT cl.rut, COALESCE(cl.nombre_completo,'') AS nombre
           FROM clientes cl JOIN creditos cr ON cr.id_cliente = cl.id_cliente
           WHERE cl.rut=? LIMIT 1`, [rut]);
        if (op) cliente = { rut: op.rut, nombre: op.nombre || null };
      } catch (_) {}
    }

    // 2) Antecedentes laborales (antigüedad en días)
    let antecedentes = null;
    try {
      const [[a]] = await pool.query(
        `SELECT updated_at, created_at, tipo_trabajador,
                DATEDIFF(NOW(), COALESCE(updated_at, created_at)) AS dias
         FROM antecedentes_laborales WHERE rut_cliente=? LIMIT 1`, [rut]);
      if (a) antecedentes = {
        existe: true,
        fecha: a.updated_at || a.created_at,
        dias: a.dias == null ? null : Number(a.dias),
        tipo_trabajador: a.tipo_trabajador || null,
      };
    } catch (_) {}

    // 2b) Carga la deuda del informe DealerNet a la información del cliente (si hay informe nuevo)
    await sincronizarComercialDealernet(rut);

    // 2c) Informes comerciales: tabla propia y/o el informe DealerNet (de donde
    //     sale la data comercial de muchos clientes). Se muestra la fecha más reciente.
    let comercial = null;
    const fechasCom = [];
    try {
      const [[ic]] = await pool.query('SELECT updated_at, created_at FROM informacion_comercial WHERE rut_cliente=? LIMIT 1', [rut]);
      if (ic) fechasCom.push(ic.updated_at || ic.created_at);
    } catch (_) {}
    try {
      const dig = rut.replace(/[.\s-]/g, '').toUpperCase();
      const rutDN = dig.length > 1 ? dig.slice(0, -1) : dig;   // dealernet_informes guarda el RUT sin DV
      const [[dn]] = await pool.query("SELECT MAX(created_at) AS fecha FROM dealernet_informes WHERE rut=? AND retcode='0'", [rutDN]);
      if (dn && dn.fecha) fechasCom.push(dn.fecha);
    } catch (_) {}
    const ordenadas = fechasCom.filter(Boolean).map(f => new Date(f)).sort((a, b) => b - a);
    if (ordenadas.length) comercial = { existe: true, fecha: ordenadas[0] };

    // 3) Cotizaciones guardadas (última primero)
    let cotizaciones = [];
    try {
      const [rows] = await pool.query(
        `SELECT id_cotizacion, fecha_cotizacion, created_at, valor_vehiculo, pie,
                monto_financiado, cuota, plazo
         FROM cotizaciones WHERE rut_cliente=? ORDER BY created_at DESC LIMIT 20`, [rut]);
      cotizaciones = rows.map(r => ({
        id: r.id_cotizacion,
        fecha: r.fecha_cotizacion || r.created_at,
        valor_vehiculo: r.valor_vehiculo,
        pie: r.pie,
        saldo_precio: (Number(r.valor_vehiculo) || 0) - (Number(r.pie) || 0),
        monto_credito: r.monto_financiado,
        cuota: r.cuota,
        plazo: r.plazo,
      }));
    } catch (_) {}

    res.json({ success: true, data: { cliente, antecedentes, comercial, cotizaciones }, error: null });
  } catch (e) {
    console.error('[evaluacion ficha]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* GET /api/evaluacion-crediticia/documentos/:rut — documentos ya cargados */
const getDocumentos = async (req, res) => {
  try {
    const rut = normRut(decodeURIComponent(req.params.rut || ''));
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido' });
    const [rows] = await pool.query(
      `SELECT id, ocupacion, documento, archivo_nombre, archivo_size, mime_type, validado, validacion_texto, validacion_url, created_at
       FROM evaluacion_documentos WHERE rut_cliente=? ORDER BY id`, [rut]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[evaluacion getDocumentos]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* POST /api/evaluacion-crediticia/documento — sube/reemplaza un documento (base64) */
const subirDocumento = async (req, res) => {
  try {
    const { rut, ocupacion, documento, archivo_nombre, archivo_size, mime_type, archivo_data } = req.body || {};
    const r = normRut(rut);
    if (!r || !documento || !archivo_data)
      return res.status(400).json({ success: false, data: null, error: 'rut, documento y archivo_data son requeridos' });
    const buffer = Buffer.from(archivo_data, 'base64');
    if (buffer.length > 15 * 1024 * 1024)
      return res.status(413).json({ success: false, data: null, error: 'El archivo supera 15 MB' });
    const id_usuario = req.usuario?.id_usuario || null;
    await pool.query(
      `INSERT INTO evaluacion_documentos
         (rut_cliente, ocupacion, documento, archivo_nombre, archivo_size, mime_type, archivo_data, subido_por)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE ocupacion=VALUES(ocupacion), archivo_nombre=VALUES(archivo_nombre),
         archivo_size=VALUES(archivo_size), mime_type=VALUES(mime_type), archivo_data=VALUES(archivo_data),
         subido_por=VALUES(subido_por), created_at=CURRENT_TIMESTAMP`,
      [r, ocupacion || null, String(documento).slice(0, 255), archivo_nombre || 'documento',
       archivo_size || buffer.length, mime_type || 'application/octet-stream', buffer, id_usuario]);
    const [[row]] = await pool.query('SELECT id FROM evaluacion_documentos WHERE rut_cliente=? AND documento=? LIMIT 1', [r, String(documento).slice(0, 255)]);
    res.json({ success: true, data: { id: row ? row.id : null }, error: null });
  } catch (e) {
    console.error('[evaluacion subirDocumento]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* GET /api/evaluacion-crediticia/documento/:id/view — ver archivo */
const verDocumento = async (req, res) => {
  try {
    const [[doc]] = await pool.query(
      'SELECT archivo_nombre, mime_type, archivo_data FROM evaluacion_documentos WHERE id=?', [req.params.id]);
    if (!doc) return res.status(404).json({ success: false, data: null, error: 'No encontrado' });
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.archivo_nombre || 'documento')}`);
    res.send(doc.archivo_data);
  } catch (e) {
    console.error('[evaluacion verDocumento]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* DELETE /api/evaluacion-crediticia/documento/:id — elimina archivo cargado */
const removeDocumento = async (req, res) => {
  try {
    await pool.query('DELETE FROM evaluacion_documentos WHERE id=?', [req.params.id]);
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) {
    console.error('[evaluacion removeDocumento]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* POST /api/evaluacion-crediticia/documento/:id/validar-afp — la IA valida el
   certificado de cotizaciones de AFP: que sea genuino, RUT del cliente y períodos. */
const SYSTEM_AFP = `Eres un validador documental de una financiera automotriz chilena. Recibes un archivo que DEBERÍA ser un Certificado de Cotizaciones de AFP. Determina si es ese documento, extrae sus datos y verifica que correspondan al cliente. No es verificación forense ni de folio en la AFP; es validación de contenido.`;
const promptAFP = (rutCliente) => `Valida el documento adjunto como Certificado de Cotizaciones de AFP del cliente con RUT ${rutCliente}. Responde SOLO este JSON:
{
  "es_cotizaciones_afp": true|false,
  "afp": "nombre de la AFP o null",
  "rut_documento": "RUT que aparece en el documento o null",
  "rut_coincide": true|false,
  "folio": "folio si aparece o null",
  "n_periodos": number,
  "ultimo_periodo": "MM/AAAA o null",
  "veredicto": "validado|observado|no_es_certificado",
  "motivo": "1 frase: por qué es válido, o qué falla (RUT no coincide, ilegible, faltan períodos, no es certificado de cotizaciones, etc.)"
}`;

const validarAfp = async (req, res) => {
  try {
    const [[doc]] = await pool.query('SELECT id, rut_cliente, documento, mime_type, archivo_data FROM evaluacion_documentos WHERE id=?', [req.params.id]);
    if (!doc) return res.status(404).json({ success: false, data: null, error: 'Documento no encontrado' });
    const mt = (doc.mime_type || '').toLowerCase();
    if (!doc.archivo_data || !(mt.includes('pdf') || mt.startsWith('image/')))
      return res.json({ success: true, data: { validado: null, texto: 'Solo se valida PDF o imagen' }, error: null });

    const documentos = mt.includes('pdf')
      ? [{ tipo: 'pdf', data: Buffer.from(doc.archivo_data).toString('base64') }]
      : [{ tipo: 'image', media_type: mt, data: Buffer.from(doc.archivo_data).toString('base64') }];

    let x = null, texto = null, validado = null;
    try {
      const r = await analizar({
        codigo: 'evaluacion_consistencia', id_usuario: req.usuario?.id_usuario,
        system: SYSTEM_AFP, prompt: promptAFP(doc.rut_cliente), documentos, json: true, max_tokens: 800, thinking: false,
      });
      x = r.datos;
      if (!x && r.texto) { const m = r.texto.match(/\{[\s\S]*\}/); if (m) { try { x = JSON.parse(m[0]); } catch (_) {} } }
    } catch (e) {
      if (e.code === 'IA_OFF') return res.json({ success: true, data: { validado: null, texto: 'IA desactivada' }, error: null });
      if (e.code === 'NO_KEY') return res.json({ success: true, data: { validado: null, texto: 'IA no configurada' }, error: null });
      throw e;
    }
    if (!x) return res.json({ success: true, data: { validado: null, texto: 'No se pudo leer la validación' }, error: null });

    // URL del validador de la AFP detectada (desde el mantenedor de AFP)
    let urlValidador = null;
    if (x.afp) {
      try {
        const [[afpRow]] = await pool.query(
          "SELECT url_validador FROM parametros_afp WHERE url_validador IS NOT NULL AND url_validador<>'' AND ? LIKE CONCAT('%', nombre, '%') ORDER BY CHAR_LENGTH(nombre) DESC LIMIT 1",
          [String(x.afp)]);
        if (afpRow) urlValidador = afpRow.url_validador;
      } catch (_) {}
    }

    if (x.es_cotizaciones_afp && x.rut_coincide && x.veredicto === 'validado') {
      validado = 1;
      texto = 'Validado en Certificado de Cotizaciones' + (x.afp ? ' · ' + String(x.afp).slice(0, 40) : '') + (x.n_periodos ? ' · ' + x.n_periodos + ' períodos' : '');
    } else {
      validado = 0;
      texto = 'Revisar: ' + (x.motivo || (!x.es_cotizaciones_afp ? 'no parece un certificado de cotizaciones' : !x.rut_coincide ? 'el RUT no coincide' : 'observado'));
    }
    texto = texto.slice(0, 255);
    await pool.query('UPDATE evaluacion_documentos SET validado=?, validacion_texto=?, validacion_url=? WHERE id=?', [validado, texto, urlValidador, doc.id]);
    res.json({ success: true, data: { validado, texto, url: urlValidador, detalle: x }, error: null });
  } catch (e) {
    console.error('[evaluacion validarAfp]', e.message);
    res.status(422).json({ success: false, data: null, error: 'No se pudo validar: ' + (e.message || 'error') });
  }
};

module.exports = { ficha, getDocumentos, subirDocumento, verDocumento, removeDocumento, validarAfp };
