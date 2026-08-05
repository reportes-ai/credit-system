const pool = require('../../../../shared/config/database');
const almacen = require('../../../../shared/almacen-docs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

let pdfParse;
try { pdfParse = require('pdf-parse'); } catch(e) { console.warn('[informes-dealernet] pdf-parse no disponible:', e.message); }

// ── Migración ────────────────────────────────────────────────────────────────
require('../../../../shared/migrate').enFila('informes-dealernet', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS informes_dealernet (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        rut             VARCHAR(15) NOT NULL,
        nombre_completo VARCHAR(200),
        apellido_paterno VARCHAR(100),
        apellido_materno VARCHAR(100),
        nombres          VARCHAR(200),
        fecha_nacimiento VARCHAR(80),
        edad             INT,
        ocupacion        VARCHAR(300),
        estado_civil     VARCHAR(50),
        perfil_socioeconomico VARCHAR(30),
        hijos            INT,
        deuda_total_mk   DECIMAL(15,3) DEFAULT 0,
        impagos_vigentes INT DEFAULT 0,
        direccion_principal TEXT,
        telefonos        JSON,
        emails           JSON,
        fecha_informe    VARCHAR(20),
        pdf_filename     VARCHAR(255),
        pdf_path         VARCHAR(600),
        datos_extraidos  JSON,
        fecha_carga      DATETIME DEFAULT CURRENT_TIMESTAMP,
        usuario_carga    VARCHAR(100),
        INDEX idx_rut (rut),
        INDEX idx_carga (fecha_carga)
      )
    `);

    /* El PDF pasa a vivir EN LA BASE (04-08-2026), como ya lo hacen fundantes,
       cartas y certificados. Antes se guardaba solo en el disco de Render, y eso
       tenía dos problemas: el disco es del servidor, no del sistema (si se
       recrea el servicio los archivos no viajan), y sobre todo **el host de
       contingencia de Cloud Run NO TIENE disco** — al promoverlo, estos informes
       se habrían visto rotos justo en la emergencia.
       `pdf_path` se conserva para no perder la referencia histórica. */
    await pool.query(`ALTER TABLE informes_dealernet ADD COLUMN pdf_data LONGBLOB NULL`)
      .catch(() => {});   // ya existe
    /* Segundo paso del mismo razonamiento: si el disco no sirve porque es del
       servidor, la base tampoco es el lugar de un PDF. Los informes nuevos van
       al bucket (shared/almacen-docs.js), que sí alcanzan los dos hosts. */
    for (const ddl of almacen.sqlColumnas('informes_dealernet')) {
      try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[dealernet almacen]', e.message); }
    }

    /* Traslado de los informes que ya existían: se leen del disco y se suben a la
       base. Tiene que correr DENTRO de Render, que es donde vive ese disco — por
       eso va acá y no en un script suelto de este computador.
       Es idempotente: solo toca las filas sin `pdf_data`, y si el archivo ya no
       está en disco lo informa y sigue (esa fila queda sin adjunto, pero con
       todos sus datos extraídos intactos). */
    try {
      const [pend] = await pool.query(
        `SELECT id, pdf_path, pdf_filename FROM informes_dealernet
          WHERE pdf_data IS NULL AND pdf_path IS NOT NULL AND pdf_path <> ''`);
      if (pend.length) {
        let ok = 0; const perdidos = [];
        for (const r of pend) {
          try {
            if (!fs.existsSync(r.pdf_path)) { perdidos.push(r.pdf_filename || r.id); continue; }
            await pool.query('UPDATE informes_dealernet SET pdf_data = ? WHERE id = ?',
                             [fs.readFileSync(r.pdf_path), r.id]);
            ok++;
          } catch (e) { perdidos.push(`${r.pdf_filename || r.id} (${e.message})`); }
        }
        console.log(`[informes-dealernet] PDFs trasladados a la base: ${ok}/${pend.length}` +
                    (perdidos.length ? ` — sin archivo en disco: ${perdidos.join(', ')}` : ''));
      }
    } catch (e) { console.error('[informes-dealernet] traslado de PDFs:', e.message); }
    console.log('[informes_dealernet] tabla lista');
  } catch(e) {
    console.error('[informes_dealernet] migration error:', e.message);
  }
});

// ── Upload storage ────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../../../../api-gateway/uploads/informes-dealernet');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf'))
      cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF'));
  },
  limits: { fileSize: 30 * 1024 * 1024 }
});

// ── Parser Dealernet PDF ──────────────────────────────────────────────────────

// Extrae el PRIMER valor (periodo más reciente) de una fila del historial SBIF.
// El texto tiene formato: "LABEL\nLABEL2\n  9.956  10.678  10.534  37.552"
// o bien: "LABEL\n0000" (todos ceros sin espacios)
// Retorna valor en PESOS (M$ * 1000).
function histVal(histText, labelFragment) {
  const idx = histText.indexOf(labelFragment);
  if (idx === -1) return 0;
  // Buscar la primera línea NUMÉRICA que sigue al label
  const after = histText.substring(idx + labelFragment.length);
  const m = after.match(/\n\s*([\d\. ]+)\n/);
  if (!m) return 0;
  const line = m[1].trim();
  // "0000" → cuatro ceros consecutivos → primer valor es 0
  if (/^0+$/.test(line)) return 0;
  const first = line.split(/\s+/)[0];
  return (parseInt(first.replace(/\./g, '')) || 0) * 1000;
}

function parseDealernetPDF(text) {
  const r = {
    rut: null, nombre_completo: null,
    apellido_paterno: null, apellido_materno: null, nombres: null,
    fecha_nacimiento: null, edad: null, ocupacion: null,
    estado_civil: null, perfil_socioeconomico: null, hijos: null,
    deuda_total_mk: 0, impagos_vigentes: 0,
    direccion_principal: null, telefonos: [], emails: [], fecha_informe: null,
    // ── Datos financieros SBIF (Historial de Documentos) ──────────────────
    fin: {
      deuda_vigente_total:   0,   // AL DÍA E IMPAGOS < 30 DÍAS  (M$→$)
      deuda_hipotecaria:     0,   // CRÉDITOS PARA VIVIENDA
      deuda_comercial:       0,   // CRÉDITOS COMERCIALES
      deuda_consumo:         0,   // CRÉDITOS DE CONSUMO
      deuda_morosa:          0,   // IMPAGOS 30-90 + 90-180 días
      deuda_vencida:         0,   // IMPAGOS 180 DÍAS Y 3 AÑOS
      deuda_castigada:       0,   // IMPAGOS >= 3 AÑOS
      linea_disponible:      0,   // LINEA CRÉDITO DISPONIBLE
      nro_inst_consumo:      0,   // NRO. ENTIDADES CRED.CONSUMO
      // Protestos (del Boletín de Alertas / CCS)
      protestos_vigentes_q:  0,
      monto_protestos:       0,
    }
  };

  // RUT (formato X.XXX.XXX-X)
  const rutM = text.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dkK])/);
  if (rutM) r.rut = rutM[1];

  // Fecha consulta
  const fechaM = text.match(/Fecha Consulta\s*:\s*(\d{2}-\d{2}-\d{4})/);
  if (fechaM) r.fecha_informe = fechaM[1];

  // Nombre del header: primera línea tipo "ApellidoP ApellidoM Nombre1 [Nombre2]"
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
  for (const l of lines.slice(0, 10)) {
    if (l.match(/^\d|Impreso|Comportamiento|Perfil|Boletín|Gestor/)) continue;
    const words = l.split(/\s+/);
    if (words.length >= 3 && words.every(w => /^[A-ZÁÉÍÓÚÑÜÀ-Ö][a-záéíóúñüà-ö]+$/.test(w))) {
      r.apellido_paterno = words[0];
      r.apellido_materno = words[1];
      r.nombres          = words.slice(2).join(' ');
      r.nombre_completo  = `${r.nombres} ${r.apellido_paterno} ${r.apellido_materno}`;
      break;
    }
  }

  // Deuda Total
  const deudaM = text.match(/Deuda Total\s*:\s*([\d\.]+)/);
  if (deudaM) r.deuda_total_mk = parseFloat(deudaM[1].replace(/\./g, '')) || 0;

  // Perfil Comercial
  const perfIdx = text.indexOf('Perfil Comercial');
  if (perfIdx > -1) {
    const pText = text.substring(perfIdx, perfIdx + 5000);

    const fnM = pText.match(/FECHA DE NACIMIENTO\s+(.+?)(?:\n|LUGAR)/);
    if (fnM) r.fecha_nacimiento = fnM[1].trim();

    const edM = pText.match(/EDAD\s+(\d+)/);
    if (edM) r.edad = parseInt(edM[1]);

    const ocM = pText.match(/OCUPACIÓN\s+([\s\S]+?)(?:PERFIL SOCIO|FECHA DE MATR|ESTADO CIVIL)/);
    if (ocM) r.ocupacion = ocM[1].replace(/\n/g,' ').replace(/\s+/g,' ').replace(/^[\s-]+/,'').trim();

    const ecM = pText.match(/ESTADO CIVIL\s+([A-Za-záéíóúñ]+)/);
    if (ecM) r.estado_civil = ecM[1];

    const pseM = pText.match(/PERFIL SOCIO ECONÓMICO\s+([A-Za-z0-9]+)/);
    if (pseM && pseM[1] !== '---') r.perfil_socioeconomico = pseM[1];

    const hjM = pText.match(/HIJOS\s+(\d+)/);
    if (hjM) r.hijos = parseInt(hjM[1]);

    const sexM = pText.match(/SEXO\s+(Masculino|Femenino)/i);
    if (sexM) r.sexo = sexM[1].toUpperCase();

    const nacM = pText.match(/NACIONALIDAD\s+([A-Za-záéíóúñÑ]+)/);
    if (nacM) r.nacionalidad = nacM[1];
  }

  // Teléfonos del Titular
  const phoneRe = /56\s*\((\d)\)\s*(\d{7,9})/g;
  const seenP = new Set();
  let pm;
  while ((pm = phoneRe.exec(text)) !== null) {
    const phone = `56 (${pm[1]}) ${pm[2]}`;
    if (seenP.has(phone)) continue;
    const after = text.substring(pm.index + phone.length, pm.index + phone.length + 350);
    if (after.includes('Titular')) {
      seenP.add(phone);
      r.telefonos.push({
        numero:   phone,
        tipo:     after.includes('Celular') ? 'Celular' : 'Fijo',
        whatsapp: after.includes('Registrado en Whatsapp')
      });
    }
    if (r.telefonos.length >= 6) break;
  }

  // Emails del Titular
  const emailRe = /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g;
  const seenE = new Set();
  let em;
  while ((em = emailRe.exec(text)) !== null) {
    const email = em[0];
    if (seenE.has(email)) continue;
    const after = text.substring(em.index + email.length, em.index + email.length + 200);
    if (after.includes('Titular')) {
      seenE.add(email);
      r.emails.push(email);
    }
    if (r.emails.length >= 4) break;
  }

  // Dirección principal
  const DIR_LABEL = 'Direcciones más probables de residencia';
  const dirIdx = text.indexOf(DIR_LABEL);
  if (dirIdx > -1) {
    const dText = text.substring(dirIdx + DIR_LABEL.length, dirIdx + 600);
    const dLines = dText.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 5 && !l.startsWith('Contactabilidad') && !l.startsWith('Calidad') && !l.startsWith('Relación'));
    if (dLines.length >= 2) r.direccion_principal = `${dLines[0]}, ${dLines[1]}`;
    else if (dLines.length === 1) r.direccion_principal = dLines[0];
  }

  // Impagos vigentes
  const impM = text.match(/Boletín de Impagos Vigente[\s\S]{0,700}?Total\s+(\d+)/);
  if (impM) r.impagos_vigentes = parseInt(impM[1]);

  // ── Historial financiero SBIF ─────────────────────────────────────────────
  const histStart = text.indexOf('Historial de Documentos');
  const histEnd   = text.indexOf('Perfil Comercial');
  if (histStart > -1) {
    const h = text.substring(histStart, histEnd > histStart ? histEnd : histStart + 4000);

    r.fin.deuda_vigente_total = histVal(h, 'AL DÍA E IMPAGOS < 30');
    r.fin.deuda_hipotecaria   = histVal(h, 'CRÉDITOS PARA\nVIVIENDA');
    r.fin.deuda_comercial     = histVal(h, 'CRÉDITOS\nCOMERCIALES');
    r.fin.deuda_consumo       = histVal(h, 'CRÉDITOS DE\nCONSUMO');
    r.fin.deuda_morosa        = histVal(h, 'IMPAGOS 30 Y 90') +
                                histVal(h, 'IMPAGOS 90 Y 180');
    r.fin.deuda_vencida       = histVal(h, 'IMPAGOS 180');
    r.fin.deuda_castigada     = histVal(h, 'IMPAGOS >= 3');
    r.fin.linea_disponible    = histVal(h, 'LINEA CRÉDITO\nDISPONIBLE');
    // Nº instituciones consumo
    const nroM = h.match(/NRO\. ENTIDADES\nCRED\.CONSUMO\n\s*(\d+)/);
    if (nroM) r.fin.nro_inst_consumo = parseInt(nroM[1]);
  }

  // Protestos (Boletín de Alertas / CCS)
  const protQM = text.match(/Protesto\s+(\d+)/);
  if (protQM) r.fin.protestos_vigentes_q = parseInt(protQM[1]);

  // Monto protestos CCS
  const protMontoM = text.match(/Falta De Fondos[\s\S]{0,100}?\$\s*([\d\.]+)/);
  if (protMontoM) r.fin.monto_protestos = parseInt(protMontoM[1].replace(/\./g,'')) || 0;

  return r;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const getAll = async (req, res) => {
  try {
    const { rut, limit = 100, offset = 0 } = req.query;
    let q = `SELECT id, rut, nombre_completo, deuda_total_mk, impagos_vigentes,
             fecha_informe, fecha_carga, pdf_filename, telefonos, emails, direccion_principal
             FROM informes_dealernet`;
    const params = [];
    if (rut) { q += ' WHERE rut LIKE ?'; params.push(`%${rut.replace(/\./g,'').replace(/-/g,'')}%`); }
    q += ' ORDER BY fecha_carga DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const [rows] = await pool.query(q, params);
    res.json({ success: true, data: rows, error: null });
  } catch(e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const getByRut = async (req, res) => {
  try {
    const rut = req.params.rut.replace(/\./g, '').trim().toUpperCase();
    const [rows] = await pool.query(
      'SELECT * FROM informes_dealernet WHERE REPLACE(rut,\'.\',\'\') = ? ORDER BY fecha_carga DESC',
      [rut]
    );
    res.json({ success: true, data: rows, error: null });
  } catch(e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const uploadInforme = [
  upload.single('pdf'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, data: null, error: 'No se recibió archivo PDF' });

      let parsed = {};
      if (pdfParse) {
        try {
          const buf = fs.readFileSync(req.file.path);
          const pdfData = await pdfParse(buf);
          parsed = parseDealernetPDF(pdfData.text);
        } catch(pe) {
          console.warn('[informes-dealernet] error parsing PDF:', pe.message);
        }
      }

      // RUT override desde body si se envió manualmente — normalizar sin puntos
      const normalizeRut = r => (r || '').replace(/\./g, '').trim().toUpperCase();
      const rut = normalizeRut(req.body.rut || parsed.rut) || 'SIN_RUT';

      /* El PDF va al bucket (shared/almacen-docs.js). Si la lectura del archivo
         fallara se guarda igual la ficha con el resto de los datos: perder el
         adjunto es malo, perder el informe entero es peor. */
      let bufPdf = null;
      try { bufPdf = fs.readFileSync(req.file.path); } catch (_) {}
      const doc = bufPdf
        ? await almacen.colocar({ ambito: 'dealernet', clave: rut, buffer: bufPdf, mime: 'application/pdf', nombre: req.file.filename })
        : { storage: 'db', ruta: null, blob: null, bytes: null };

      const [result] = await pool.query(`
        INSERT INTO informes_dealernet
          (rut, nombre_completo, apellido_paterno, apellido_materno, nombres,
           fecha_nacimiento, edad, ocupacion, estado_civil, perfil_socioeconomico,
           hijos, deuda_total_mk, impagos_vigentes, direccion_principal,
           telefonos, emails, fecha_informe, pdf_filename, pdf_path, pdf_data,
           doc_storage, doc_ruta, doc_bytes, datos_extraidos, usuario_carga)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        rut,
        parsed.nombre_completo  || req.body.nombre || null,
        parsed.apellido_paterno || null,
        parsed.apellido_materno || null,
        parsed.nombres          || null,
        parsed.fecha_nacimiento || null,
        parsed.edad             || null,
        parsed.ocupacion        || null,
        parsed.estado_civil     || null,
        parsed.perfil_socioeconomico || null,
        parsed.hijos            || null,
        parsed.deuda_total_mk   || 0,
        parsed.impagos_vigentes || 0,
        parsed.direccion_principal || null,
        JSON.stringify(parsed.telefonos || []),
        JSON.stringify(parsed.emails   || []),
        parsed.fecha_informe    || null,
        req.file.filename,
        req.file.path,
        doc.blob, doc.storage, doc.ruta, doc.bytes,
        JSON.stringify(parsed),
        req.user?.nombre || 'sistema'
      ]);

      res.json({ success: true, data: { id: result.insertId, rut, parsed }, error: null });
    } catch(e) {
      console.error('[informes-dealernet] upload error:', e);
      res.status(500).json({ success: false, data: null, error: e.message });
    }
  }
];

const getById = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM informes_dealernet WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No encontrado' });
    res.json({ success: true, data: rows[0], error: null });
  } catch(e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const getPDF = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT pdf_path, pdf_filename, pdf_data, doc_ruta FROM informes_dealernet WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No encontrado' });
    const { pdf_path, pdf_filename, pdf_data, doc_ruta } = rows[0];
    const nombre = String(pdf_filename || 'informe').replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_');

    // El ALMACÉN manda: el blob mientras exista, el bucket cuando ya se liberó.
    // Esta ruta leía solo `pdf_data`, así que al soltar los blobs (05-08-2026) los
    // informes caían al disco de Render, que se borra en cada deploy. El disco
    // queda solo para los informes viejos que nunca llegaron al bucket.
    if (doc_ruta || (pdf_data && pdf_data.length))
      return almacen.servir(res, { ruta: doc_ruta, blob: pdf_data, nombre, mime: 'application/pdf' });

    if (!pdf_path || !fs.existsSync(pdf_path))
      return res.status(404).json({ success: false, error: 'Archivo PDF no disponible en servidor' });
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(pdf_path).pipe(res);
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
};

const deleteInforme = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT pdf_path, doc_ruta FROM informes_dealernet WHERE id = ?', [req.params.id]);
    if (rows.length && rows[0].pdf_path && fs.existsSync(rows[0].pdf_path)) {
      try { fs.unlinkSync(rows[0].pdf_path); } catch(_) {}
    }
    await pool.query('DELETE FROM informes_dealernet WHERE id = ?', [req.params.id]);
    if (rows.length && rows[0].doc_ruta) await almacen.borrar(rows[0].doc_ruta);
    res.json({ success: true, data: null, error: null });
  } catch(e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, getByRut, getById, uploadInforme, getPDF, deleteInforme };
