/* ─────────────────────────────────────────────────────────────────────────
   Fondo virtual para videollamadas — MediaPipe Selfie Segmentation (autoalojado).
   NO INVASIVO: recibe el track de video de la cámara y devuelve un track NUEVO
   (del canvas) con la persona sobre fondo desenfocado o imagen. NUNCA detiene la
   cámara real (ese track lo maneja quien llama). Así el flujo base de cámara
   queda intacto y el fondo es solo una capa que se activa a pedido.

   AF_FONDO.iniciar(videoTrack, modo) → track de video procesado.
   AF_FONDO.setModo('blur'|'imagen'); AF_FONDO.getModo(); AF_FONDO.detener(); AF_FONDO.activo().
   Imagen de reemplazo: /img/fondo-videollamada.jpg
   ───────────────────────────────────────────────────────────────────────── */
window.AF_FONDO = (function () {
  const BG_URL = '/img/fondo-videollamada.jpg';
  let seg = null, modo = 'blur', bgImg = null, rawVideo = null,
      canvas = null, ctx = null, running = false, raf = null, out = null;

  const disponible = () => typeof SelfieSegmentation !== 'undefined';
  const activo = () => running;

  function cargarSeg() {
    if (seg || !disponible()) return seg;
    seg = new SelfieSegmentation({ locateFile: f => '/js/mediapipe/' + f });
    seg.setOptions({ modelSelection: 1 });
    seg.onResults(pintar);
    return seg;
  }

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
    ctx.drawImage(res.segmentationMask, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(res.image, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-over';
    if (modo === 'imagen' && bgImg && bgImg.complete && bgImg.naturalWidth) coverDraw(bgImg, w, h);
    else { ctx.filter = 'blur(10px)'; ctx.drawImage(res.image, 0, 0, w, h); ctx.filter = 'none'; }
    ctx.restore();
  }

  async function loop() {
    if (!running) return;
    try {
      if (rawVideo && rawVideo.readyState >= 2 && seg) await seg.send({ image: rawVideo });
    } catch (_) {}
    raf = requestAnimationFrame(loop);
  }

  // Recibe el track de la cámara; devuelve un track de video procesado (del canvas).
  async function iniciar(videoTrack, modoInicial) {
    if (!videoTrack) return null;
    modo = modoInicial || 'blur';
    const s = videoTrack.getSettings();
    rawVideo = document.createElement('video');
    rawVideo.muted = true; rawVideo.playsInline = true; rawVideo.autoplay = true;
    rawVideo.srcObject = new MediaStream([videoTrack]);   // referencia el MISMO track; no lo posee
    await rawVideo.play().catch(() => {});
    canvas = document.createElement('canvas');
    canvas.width = s.width || 640; canvas.height = s.height || 480;
    ctx = canvas.getContext('2d');
    bgImg = new Image(); bgImg.src = BG_URL;
    cargarSeg();
    running = true; loop();
    out = canvas.captureStream(24);
    return out.getVideoTracks()[0];
  }

  function setModo(m) { modo = m; }
  function getModo() { return modo; }
  // Detiene SOLO el procesamiento y el track del canvas. NO toca la cámara real.
  function detener() {
    running = false; if (raf) cancelAnimationFrame(raf);
    try { if (rawVideo) rawVideo.srcObject = null; } catch (_) {}
    try { if (out) out.getVideoTracks().forEach(t => t.stop()); } catch (_) {}
    canvas = null; ctx = null; rawVideo = null; out = null;
  }

  return { iniciar, setModo, getModo, detener, disponible, activo };
})();
