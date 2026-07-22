/* ─────────────────────────────────────────────────────────────────────────
   Fondo virtual para videollamadas — MediaPipe Selfie Segmentation (autoalojado).
   Procesa el video de la cámara en un canvas (persona nítida + fondo desenfocado
   o imagen de reemplazo) y expone ese canvas como MediaStream para la llamada.

   AF_FONDO.iniciar(rawStream, modo) → MediaStream procesado (video del canvas +
     audio original). AF_FONDO.setModo('ninguno'|'blur'|'imagen'). AF_FONDO.detener().
   La imagen de reemplazo vive en /img/fondo-videollamada.jpg.
   ───────────────────────────────────────────────────────────────────────── */
window.AF_FONDO = (function () {
  const BG_URL = '/img/fondo-videollamada.jpg';
  let seg = null, modo = 'ninguno', bgImg = null, rawVideo = null,
      canvas = null, ctx = null, running = false, raf = null, out = null;

  const disponible = () => typeof SelfieSegmentation !== 'undefined';

  function cargarSeg() {
    if (seg || !disponible()) return seg;
    seg = new SelfieSegmentation({ locateFile: f => '/js/mediapipe/' + f });
    seg.setOptions({ modelSelection: 1 });   // 1 = modelo landscape (rápido y estable)
    seg.onResults(pintar);
    return seg;
  }

  // Dibuja una imagen tipo "cover" (cubre todo el canvas manteniendo proporción).
  function coverDraw(img, w, h) {
    const ir = img.width / img.height, cr = w / h;
    let dw, dh, dx, dy;
    if (ir > cr) { dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0; }
    else { dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function pintar(res) {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    // 1) máscara de la persona → 2) recorta la persona sobre la máscara
    ctx.drawImage(res.segmentationMask, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(res.image, 0, 0, w, h);
    // 3) fondo detrás de la persona
    ctx.globalCompositeOperation = 'destination-over';
    if (modo === 'imagen' && bgImg && bgImg.complete && bgImg.naturalWidth) {
      coverDraw(bgImg, w, h);
    } else {   // 'blur' (y fallback si la imagen no cargó)
      ctx.filter = 'blur(10px)';
      ctx.drawImage(res.image, 0, 0, w, h);
      ctx.filter = 'none';
    }
    ctx.restore();
  }

  async function loop() {
    if (!running) return;
    try {
      if (rawVideo && rawVideo.readyState >= 2) {
        if (modo === 'ninguno' || !seg) ctx.drawImage(rawVideo, 0, 0, canvas.width, canvas.height);
        else await seg.send({ image: rawVideo });   // pintar() dibuja el resultado
      }
    } catch (_) {}
    raf = requestAnimationFrame(loop);
  }

  async function iniciar(rawStream, modoInicial) {
    modo = modoInicial || 'ninguno';
    const vt = rawStream.getVideoTracks()[0];
    if (!vt) return rawStream;                 // sin video: devuelve el original
    const s = vt.getSettings();
    rawVideo = document.createElement('video');
    rawVideo.muted = true; rawVideo.playsInline = true; rawVideo.autoplay = true;
    rawVideo.srcObject = new MediaStream([vt]);
    await rawVideo.play().catch(() => {});
    canvas = document.createElement('canvas');
    canvas.width = s.width || 640; canvas.height = s.height || 480;
    ctx = canvas.getContext('2d');
    bgImg = new Image(); bgImg.src = BG_URL;
    cargarSeg();
    running = true; loop();
    out = canvas.captureStream(24);
    rawStream.getAudioTracks().forEach(t => out.addTrack(t));
    out._raw = rawStream;                       // referencia para detener la cámara real
    return out;
  }

  function setModo(m) { modo = m; }
  function getModo() { return modo; }
  function detener() {
    running = false; if (raf) cancelAnimationFrame(raf);
    try { if (rawVideo) rawVideo.srcObject = null; } catch (_) {}
    try { if (out && out._raw) out._raw.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { if (out) out.getTracks().forEach(t => t.stop()); } catch (_) {}
    seg = null; canvas = null; ctx = null; rawVideo = null; out = null; modo = 'ninguno';
  }

  return { iniciar, setModo, getModo, detener, disponible };
})();
