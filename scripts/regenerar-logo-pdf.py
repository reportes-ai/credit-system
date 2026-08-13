# Regenera api-gateway/public/js/logo-pdf.js desde el logo oficial.
#
# El PDF no maneja la transparencia del PNG ni su compresión, así que el logo se
# aplana sobre blanco y se guarda como JPEG, que el PDF incrusta tal cual
# (DCTDecode). Va embebido en base64 para que el documento no dependa de la red
# al generarse en el navegador.
#
# Correr solo si cambia el logo:  python scripts/regenerar-logo-pdf.py
import base64, io, os
from PIL import Image

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGEN = os.path.join(RAIZ, 'api-gateway', 'public', 'img', 'logo.png')
DESTINO = os.path.join(RAIZ, 'api-gateway', 'public', 'js', 'logo-pdf.js')
ANCHO = 700   # a ~42 mm impresos son más de 400 dpi: de sobra y liviano

im = Image.open(ORIGEN).convert('RGBA')
fondo = Image.new('RGB', im.size, (255, 255, 255))
fondo.paste(im, mask=im.split()[3])
alto = round(im.size[1] * ANCHO / im.size[0])
fondo = fondo.resize((ANCHO, alto), Image.LANCZOS)

buf = io.BytesIO()
fondo.save(buf, 'JPEG', quality=88, optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()

with open(DESTINO, 'w', encoding='utf-8') as f:
    f.write('''/* Logo oficial de AutoFácil listo para incrustar en un PDF.
   Es el mismo /img/logo.png, aplanado sobre blanco (el PDF no maneja la
   transparencia del PNG) y guardado como JPEG, que se incrusta tal cual sin
   descomprimir. Va embebido para que el documento no dependa de la red.
   Regenerar: python scripts/regenerar-logo-pdf.py */
(function (raiz) {
  var LOGO = { ancho: %d, alto: %d, jpegB64: '%s' };
  if (typeof module !== 'undefined' && module.exports) module.exports = LOGO;
  if (raiz) raiz.AF_LOGO_PDF = LOGO;
})(typeof window !== 'undefined' ? window : null);
''' % (ANCHO, alto, b64))

print('logo-pdf.js regenerado: %d x %d, %d KB en base64' % (ANCHO, alto, len(b64) / 1024))
