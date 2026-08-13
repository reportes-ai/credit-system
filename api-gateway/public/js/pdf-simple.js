'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   GENERADOR DE PDF MÍNIMO — texto, líneas y rectángulos. Sin dependencias.

   Por qué existe: los PDF del sistema se armaban FOTOGRAFIANDO la pantalla
   (html2canvas). Eso depende de cómo esté el navegador en ese instante — scroll,
   imágenes a medio cargar, el clon que hace la librería — y cuando falla no
   avisa: devuelve una hoja EN BLANCO. El 13-08-2026 un parque recibió así su
   cartola vacía. Dibujar el documento no depende de la pantalla: sale igual
   siempre, el texto queda seleccionable y el archivo pesa una fracción.

   Isomorfo: module.exports + window.AF_PDF (vive en public/js como rut-core.js:
   el backend lo requiere desde ahí, una sola copia). En el navegador entrega un Blob;
   en Node un Buffer — así el mismo documento se puede probar de verdad
   (tests/pdf-simple.test.js lo genera y lo lee con pdf-parse).

   Coordenadas en MILÍMETROS con el origen ARRIBA-IZQUIERDA, que es como uno
   piensa una hoja; internamente se convierten a puntos y al origen de PDF.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (raiz) {
  const MM = 72 / 25.4;                       // 1 mm en puntos PDF
  const CARTA = { ancho: 215.9, alto: 279.4 };  // Letter en mm

  /* PDF usa WinAnsiEncoding: latin-1 con algunos huecos rellenos. Las tildes van
     directas; el guion largo y las comillas tipográficas tienen código propio. */
  const WINANSI = { '—': 0x97, '–': 0x96, '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '•': 0x95, '…': 0x85, '€': 0x80 };
  const escapar = txt => String(txt == null ? '' : txt).split('').map(c => {
    const cod = WINANSI[c] != null ? WINANSI[c] : c.charCodeAt(0);
    if (cod > 255) return '?';                       // fuera de WinAnsi: no se inventa
    if (c === '(' || c === ')' || c === '\\') return '\\' + c;
    return cod < 32 || cod > 126 ? '\\' + cod.toString(8).padStart(3, '0') : c;
  }).join('');

  /* Métricas de Helvetica (unidades por 1000 del cuerpo). Los dígitos, el $ y el
     punto son los que deciden si una columna de montos queda pareja. */
  const ANCHOS = (() => {
    const a = {};
    for (const c of '0123456789$') a[c] = 556;
    for (const c of '.,:;\'|') a[c] = 278;
    for (const c of ' ') a[c] = 278;
    for (const c of '-') a[c] = 333;
    for (const c of '()[]{}/') a[c] = 333;
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) =>
      a[c] = [667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611][i]);
    'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) =>
      a[c] = [556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500][i]);
    for (const [c, base] of [['á','a'],['é','e'],['í','i'],['ó','o'],['ú','u'],['ñ','n'],['Á','A'],['É','E'],['Í','I'],['Ó','O'],['Ú','U'],['Ñ','N']])
      a[c] = a[base];
    a['°'] = 400; a['—'] = 1000; a['%'] = 889;
    return a;
  })();

  /* base64 → string binario (1 char = 1 byte), en navegador y en Node. */
  const deBase64 = b64 => (typeof atob === 'function')
    ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');

  const num = n => (Math.round(Number(n) * 100) / 100).toString();
  const col = c => (Array.isArray(c) ? c : [0, 0, 0]).map(v => num(v / 255)).join(' ');

  function crear(opts = {}) {
    const hoja = opts.hoja || CARTA;
    const paginas = [];
    const imgs = [];          // imágenes incrustadas, compartidas por todas las hojas
    let actual = [];
    const aY = mm => (hoja.alto - mm) * MM;   // mm desde arriba → puntos desde abajo

    const api = {
      hoja,
      /* Ancho del texto en mm, con las métricas reales de Helvetica. Importa para
         alinear a la derecha: con un promedio, una columna de montos queda
         desprolija porque "$99.500" y "$196.250" no miden lo mismo por carácter. */
      ancho(txt, size = 10) {
        /* Sin corrección por negrita: en Helvetica-Bold los DÍGITOS, el $ y el
           punto miden exactamente lo mismo que en la redonda, y son los que
           forman una columna de montos. Inflar el ancho corría los totales
           2 pt respecto del resto de la columna. */
        let u = 0;
        for (const c of String(txt || '')) u += ANCHOS[c] != null ? ANCHOS[c] : 556;
        return u / 1000 * size / MM;
      },
      texto(x, y, txt, o = {}) {
        const size = o.size || 10, bold = !!o.bold;
        let px = x;
        if (o.align === 'right') px = x - api.ancho(txt, size);
        else if (o.align === 'center') px = x - api.ancho(txt, size) / 2;
        actual.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${col(o.color)} rg ` +
                    `${num(px * MM)} ${num(aY(y))} Td (${escapar(txt)}) Tj ET`);
        return api;
      },
      rect(x, y, ancho, alto, color) {
        actual.push(`${col(color)} rg ${num(x * MM)} ${num(aY(y + alto))} ${num(ancho * MM)} ${num(alto * MM)} re f`);
        return api;
      },
      linea(x1, y1, x2, y2, color, grosor = 0.2) {
        actual.push(`${col(color)} RG ${num(grosor * MM)} w ${num(x1 * MM)} ${num(aY(y1))} m ${num(x2 * MM)} ${num(aY(y2))} l S`);
        return api;
      },
      /* Imagen JPEG (base64). Se incrusta tal cual con DCTDecode: el PDF entiende
         JPEG nativamente, así que no hay que descomprimir ni recodificar nada.
         PNG no sirve directo — su compresión no es la del PDF y la
         transparencia habría que aplanarla igual. */
      imagen(x, y, anchoMM, altoMM, img) {
        if (!img || !img.jpegB64) return api;
        const id = imgs.push({ b64: img.jpegB64, w: img.ancho, h: img.alto }) ;
        actual.push(`q ${num(anchoMM * MM)} 0 0 ${num(altoMM * MM)} ${num(x * MM)} ${num(aY(y + altoMM))} cm /Im${id} Do Q`);
        return api;
      },
      paginaNueva() { paginas.push(actual); actual = []; return api; },

      /* Ensambla el archivo. El xref exige el offset EXACTO de cada objeto: se
         calcula sobre el mismo string que se devuelve, nunca estimado. */
      construir() {
        const hojas = [...paginas, actual];
        const nObj = 3 + hojas.length * 2;          // catálogo, páginas, 2 fuentes, y por hoja: página + contenido
        const objs = [];
        const idsPagina = hojas.map((_, i) => 5 + i * 2);

        /* /Info e /ID los espera todo lector estricto; sin ellos, el de pdf-parse
           (pdfjs) rechaza el archivo. El ID es un hash simple del contenido: no
           tiene que ser único en el mundo, solo estar presente y ser estable. */
        const idImg0 = 3 + hojas.length * 2 + 2;          // ids de las imágenes
        const idInfo = idImg0 + imgs.length;
        let h = 0x811c9dc5;
        for (const c of hojas.flat().join('').slice(0, 4000)) { h ^= c.charCodeAt(0); h = (h * 0x01000193) >>> 0; }
        const ID = (h.toString(16) + '0123456789abcdef0123456789abcdef').slice(0, 32).toUpperCase();
        objs[idInfo] = `<< /Producer (AutoFacil Business Suite) /Title (Documento) >>`;
        /* Cada imagen es un XObject con el JPEG crudo dentro del stream. Los bytes
           se manejan como latin1 (1 char = 1 byte), que es como se escribe el
           archivo: así los offsets del xref siguen siendo exactos. */
        const recursoImg = imgs.length
          ? ' /XObject << ' + imgs.map((_, k) => `/Im${k + 1} ${idImg0 + k} 0 R`).join(' ') + ' >>' : '';
        imgs.forEach((im, k) => {
          const bytes = deBase64(im.b64);
          objs[idImg0 + k] = `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>
stream
${bytes}
endstream`;
        });

        objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        objs[2] = `<< /Type /Pages /Kids [${idsPagina.map(i => `${i} 0 R`).join(' ')}] /Count ${hojas.length} >>`;
        objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
        hojas.forEach((cont, i) => {
          const idP = idsPagina[i], idC = idP + 1;
          objs[idP] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(hoja.ancho * MM)} ${num(hoja.alto * MM)}] ` +
                      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${recursoImg} >> /Contents ${idC} 0 R >>`;
          const flujo = cont.join('\n');
          objs[idC] = `<< /Length ${flujo.length} >>\nstream\n${flujo}\nendstream`;
        });

        let pdf = '%PDF-1.4\n';
        const offsets = [];
        for (let i = 1; i < objs.length; i++) {
          if (!objs[i]) continue;
          offsets[i] = pdf.length;
          pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
        }
        const inicioXref = pdf.length;
        const total = objs.length;
        /* Cada entrada del xref debe ocupar EXACTAMENTE 20 bytes. Se usa el
           terminador "\r\n" (el clásico) porque los lectores antiguos leen por
           posición fija y con " \n" algunos responden "bad XRef entry". */
        pdf += `xref\n0 ${total}\n0000000000 65535 f\r\n`;
        for (let i = 1; i < total; i++)
          pdf += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n\r\n`;
        /* /Info e /ID no son decorativos: los lectores estrictos esperan verlos
           en el trailer, y sin ellos algunos rechazan el archivo. */
        pdf += `trailer\n<< /Size ${total} /Root 1 0 R /Info ${idInfo} 0 R /ID [<${ID}> <${ID}>] >>\n` +
               `startxref\n${inicioXref}\n%%EOF`;
        return pdf;
      },

      /* Blob en el navegador (para adjuntar o abrir), Buffer en Node (para probar).
         Se decide por `window`, no por `Blob`: Node 20+ también define Blob. */
      salida() {
        const pdf = api.construir();
        if (typeof window === 'undefined' && typeof Buffer !== 'undefined') return Buffer.from(pdf, 'binary');
        const bytes = new Uint8Array(pdf.length);
        for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
        return new Blob([bytes], { type: 'application/pdf' });
      },
    };
    return api;
  }

  const api = { crear, CARTA, MM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (raiz) raiz.AF_PDF = api;
})(typeof window !== 'undefined' ? window : null);
