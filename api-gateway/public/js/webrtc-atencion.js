/* ──────────────────────────────────────────────────────────────────────────
   AutoFácil — Videollamada WebRTC para Atención Remota (módulo compartido).
   Lo usan la consola del ejecutivo y el portal del dealer. La media va P2P;
   la señalización viaja por el WebSocket de la página (evento 'rtc').

   Integración:
     ARTC.init({ role:'exec'|'dealer', selfName, iceUrl, token,
                 signal:(convId,kind,payload)=>{...} });
     ARTC.start(convId,{selfName,peerName})   // sólo el ejecutivo inicia
     ARTC.onRtc(convId, kind, payload, from)  // enrutar mensajes 'rtc' del WS

   La llamada SIEMPRE la inicia el ejecutivo. El dealer recibe una solicitud.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  const S = {
    role: null, selfName: '', iceUrl: '', token: '', signal: null,
    pc: null, local: null, screenStream: null,
    convId: null, peerName: '', state: 'idle',   // idle|testing|calling|incoming|incall
    micOn: true, camOn: true, screen: false, pendingIce: [], ringTimer: null, meterRAF: null,
  };
  let ui = {};
  let pipCanvas = null, pipVideo = null, pipStream = null;

  /* ── Estilos ── */
  function injectCSS() {
    if (document.getElementById('artc-css')) return;
    const st = document.createElement('style');
    st.id = 'artc-css';
    st.textContent = `
      .artc-ov { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:100000; display:none; align-items:center; justify-content:center; padding:16px; }
      .artc-ov.show { display:flex; }
      .artc-modal { background:#fff; border-radius:16px; max-width:440px; width:100%; box-shadow:0 24px 70px rgba(0,0,0,.35); overflow:hidden; font-family:'Segoe UI',system-ui,sans-serif; }
      .artc-mhead { background:linear-gradient(135deg,#012d70,#0141A2); color:#fff; padding:16px 20px; font-weight:700; display:flex; align-items:center; gap:10px; font-size:1.02rem; }
      .artc-mbody { padding:20px; }
      .artc-prev { width:100%; aspect-ratio:16/9; background:#0b1220; border-radius:12px; object-fit:cover; transform:scaleX(-1); }
      .artc-meter { height:8px; background:#e5e7eb; border-radius:5px; margin:12px 0 4px; overflow:hidden; }
      .artc-meter > div { height:100%; width:0%; background:linear-gradient(90deg,#16a34a,#84cc16,#f59e0b); transition:width .08s; }
      .artc-mlbl { font-size:.74rem; color:#64748b; }
      .artc-mfoot { display:flex; gap:10px; justify-content:flex-end; padding:14px 20px; border-top:1px solid #f1f5f9; }
      .artc-btn { border:none; border-radius:10px; padding:11px 18px; font-weight:700; font-size:.9rem; cursor:pointer; display:inline-flex; align-items:center; gap:7px; }
      .artc-btn.ok { background:#16a34a; color:#fff; } .artc-btn.ok:hover { background:#15803d; }
      .artc-btn.no { background:#ef4444; color:#fff; } .artc-btn.no:hover { background:#dc2626; }
      .artc-btn.gh { background:#f1f5f9; color:#334155; }
      .artc-callerav { width:74px; height:74px; border-radius:50%; background:#e8f1ff; color:#0141A2; display:flex; align-items:center; justify-content:center; font-size:2rem; margin:0 auto 12px; }
      .artc-ring { animation:artcPulse 1.3s infinite; }
      @keyframes artcPulse { 0%,100%{ box-shadow:0 0 0 0 rgba(1,65,162,.4);} 50%{ box-shadow:0 0 0 16px rgba(1,65,162,0);} }

      /* Ventana flotante de llamada (~1/8 de pantalla) */
      .artc-win { position:fixed; right:18px; bottom:18px; width:23vw; min-width:260px; max-width:380px; background:#0b1220; border-radius:14px;
        box-shadow:0 18px 50px rgba(0,0,0,.5); z-index:99998; overflow:hidden; display:none; border:1px solid rgba(255,255,255,.1); }
      .artc-win.show { display:block; }
      .artc-whead { background:rgba(255,255,255,.07); color:#fff; padding:7px 10px; font-size:.78rem; display:flex; align-items:center; gap:8px; cursor:move; user-select:none; }
      .artc-whead .st { width:8px; height:8px; border-radius:50%; background:#f59e0b; }
      .artc-whead .st.on { background:#16a34a; }
      .artc-stage { position:relative; width:100%; aspect-ratio:3/4; background:#000; }
      @media(min-width:700px){ .artc-stage { aspect-ratio:4/3; } }
      .artc-remote { width:100%; height:100%; object-fit:cover; background:#0b1220; }
      .artc-local { position:absolute; right:8px; bottom:8px; width:34%; aspect-ratio:4/3; object-fit:cover; border-radius:8px; border:2px solid rgba(255,255,255,.7); background:#111827; transform:scaleX(-1); }
      .artc-name { position:absolute; left:8px; bottom:8px; background:rgba(0,0,0,.55); color:#fff; font-size:.74rem; font-weight:600; padding:3px 9px; border-radius:8px; max-width:60%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .artc-name.localn { left:auto; right:8px; bottom:calc(34% * 0.75 + 14px); display:none; }
      .artc-ctrls { display:flex; gap:8px; justify-content:center; padding:10px; background:#0b1220; }
      .artc-c { width:42px; height:42px; border-radius:50%; border:none; cursor:pointer; font-size:1.05rem; display:flex; align-items:center; justify-content:center; background:#374151; color:#fff; }
      .artc-c:hover { filter:brightness(1.15); }
      .artc-c.off { background:#fbbf24; color:#111827; }
      .artc-c.end { background:#ef4444; }
      .artc-c.act { background:#0141A2; }
      .artc-waitmsg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#cbd5e1; font-size:.85rem; text-align:center; padding:18px; }
    `;
    document.head.appendChild(st);
  }

  /* ── Construcción del DOM ── */
  function build() {
    injectCSS();
    if (document.getElementById('artc-win')) return;

    // Prueba de dispositivos (ejecutivo, antes de llamar)
    const test = document.createElement('div');
    test.className = 'artc-ov'; test.id = 'artc-test';
    test.innerHTML = `
      <div class="artc-modal">
        <div class="artc-mhead"><i class="bi bi-camera-video"></i> Probar cámara y micrófono</div>
        <div class="artc-mbody">
          <video class="artc-prev" id="artc-testvid" autoplay playsinline muted></video>
          <div class="artc-meter"><div id="artc-testmeter"></div></div>
          <div class="artc-mlbl"><i class="bi bi-mic"></i> Habla para ver el nivel del micrófono. <span id="artc-testerr" style="color:#dc2626"></span></div>
        </div>
        <div class="artc-mfoot">
          <button class="artc-btn gh" id="artc-testcancel">Cancelar</button>
          <button class="artc-btn ok" id="artc-testcall"><i class="bi bi-telephone-outbound"></i> Iniciar llamada</button>
        </div>
      </div>`;
    document.body.appendChild(test);

    // Solicitud entrante (dealer)
    const inc = document.createElement('div');
    inc.className = 'artc-ov'; inc.id = 'artc-incoming';
    inc.innerHTML = `
      <div class="artc-modal">
        <div class="artc-mhead"><i class="bi bi-camera-video-fill"></i> Videollamada entrante</div>
        <div class="artc-mbody" style="text-align:center">
          <div class="artc-callerav artc-ring"><i class="bi bi-person-fill"></i></div>
          <div style="font-weight:700;font-size:1.05rem" id="artc-incname">Ejecutivo</div>
          <div style="color:#64748b;font-size:.86rem;margin-top:3px">te está llamando…</div>
        </div>
        <div class="artc-mfoot" style="justify-content:center">
          <button class="artc-btn no" id="artc-increject"><i class="bi bi-telephone-x"></i> Rechazar</button>
          <button class="artc-btn ok" id="artc-incaccept"><i class="bi bi-telephone-inbound"></i> Aceptar</button>
        </div>
      </div>`;
    document.body.appendChild(inc);

    // Ventana de llamada flotante
    const win = document.createElement('div');
    win.className = 'artc-win'; win.id = 'artc-win';
    win.innerHTML = `
      <div class="artc-whead" id="artc-whead"><span class="st" id="artc-wst"></span> <span id="artc-wtitle">En llamada</span></div>
      <div class="artc-stage">
        <video class="artc-remote" id="artc-remote" autoplay playsinline></video>
        <video class="artc-local" id="artc-local" autoplay playsinline muted></video>
        <div class="artc-name" id="artc-remotename">Interlocutor</div>
        <div class="artc-waitmsg" id="artc-wait">Conectando…</div>
      </div>
      <div class="artc-ctrls">
        <button class="artc-c" id="artc-mic" title="Silenciar micrófono"><i class="bi bi-mic-fill"></i></button>
        <button class="artc-c" id="artc-cam" title="Apagar cámara"><i class="bi bi-camera-video-fill"></i></button>
        <button class="artc-c" id="artc-screen" title="Compartir pantalla"><i class="bi bi-display"></i></button>
        <button class="artc-c" id="artc-pip" title="Ventana flotante (otra app)"><i class="bi bi-pip"></i></button>
        <button class="artc-c off" id="artc-fondo" title="Fondo: sin fondo"><i class="bi bi-image"></i></button>
        <button class="artc-c end" id="artc-hang" title="Colgar"><i class="bi bi-telephone-x-fill"></i></button>
      </div>`;
    document.body.appendChild(win);

    // Canvas + video oculto para componer el nombre sobre el video en el PiP.
    pipCanvas = document.createElement('canvas');
    pipVideo = document.createElement('video');
    pipVideo.muted = true; pipVideo.playsInline = true; pipVideo.autoplay = true;
    pipVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0';
    document.body.appendChild(pipVideo);
    pipVideo.addEventListener('leavepictureinpicture', stopPipCompose);

    ui = {
      test, inc, win,
      testVid: test.querySelector('#artc-testvid'), testMeter: test.querySelector('#artc-testmeter'), testErr: test.querySelector('#artc-testerr'),
      incName: inc.querySelector('#artc-incname'),
      remote: win.querySelector('#artc-remote'), localVid: win.querySelector('#artc-local'),
      remoteName: win.querySelector('#artc-remotename'), wait: win.querySelector('#artc-wait'),
      wtitle: win.querySelector('#artc-wtitle'), wst: win.querySelector('#artc-wst'),
      mic: win.querySelector('#artc-mic'), cam: win.querySelector('#artc-cam'),
      screen: win.querySelector('#artc-screen'), pip: win.querySelector('#artc-pip'),
      fondo: win.querySelector('#artc-fondo'), hang: win.querySelector('#artc-hang'),
    };

    test.querySelector('#artc-testcancel').onclick = cancelTest;
    test.querySelector('#artc-testcall').onclick = ring;
    inc.querySelector('#artc-incaccept').onclick = accept;
    inc.querySelector('#artc-increject').onclick = reject;
    ui.mic.onclick = toggleMic; ui.cam.onclick = toggleCam;
    ui.screen.onclick = toggleScreen; ui.pip.onclick = togglePip; ui.hang.onclick = hangup;
    if (ui.fondo) ui.fondo.onclick = toggleFondo;
    makeDraggable(win, win.querySelector('#artc-whead'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && S.state === 'incall' && ui.remote.srcObject && !document.pictureInPictureElement)
        enterPip();
    });
  }

  /* ── Utilidades ── */
  async function getIce() {
    try {
      const r = await fetch(S.iceUrl, { headers: { Authorization: 'Bearer ' + S.token } });
      const j = await r.json();
      return (j.success && j.data.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }];
    } catch (_) { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
  }
  // Traduce el error de getUserMedia a un motivo claro (para diagnosticar).
  function motivoMedia(e) {
    const n = e && e.name || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Permiso denegado — habilita la cámara en el candado de la URL.';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'La cámara está ocupada por otra app o pestaña (Zoom/Meet/otra pestaña). Ciérrala y reintenta.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No se encontró cámara o micrófono conectado.';
    if (n === 'OverconstrainedError') return 'La cámara no soporta la configuración pedida.';
    return n ? '(' + n + ')' : '';
  }
  async function getMedia() {
    if (S.local) return S.local;
    try {
      S.local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      // Si la cámara falla (ocupada por otra pestaña/app, ausente, etc.) pero hay micrófono,
      // la llamada igual conecta SOLO CON AUDIO en vez de quedar sin conectar.
      const camFalla = ['NotReadableError', 'NotFoundError', 'OverconstrainedError', 'AbortError', 'TrackStartError', 'NotAllowedError'].includes(e && e.name);
      if (!camFalla) throw e;
      S.local = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });  // si tampoco hay audio, lanza y se muestra el motivo
      S.camOn = false;
      if (ui.cam) { ui.cam.classList.add('off'); ui.cam.innerHTML = '<i class="bi bi-camera-video-off-fill"></i>'; ui.cam.title = 'Sin cámara disponible'; }
    }
    ui.localVid.srcObject = S.local;
    return S.local;
  }
  async function newPc() {
    const pc = new RTCPeerConnection({ iceServers: await getIce() });
    pc.onicecandidate = e => { if (e.candidate) S.signal(S.convId, 'ice', e.candidate.toJSON()); };
    pc.ontrack = e => { ui.remote.srcObject = e.streams[0]; ui.wait.style.display = 'none'; ui.wst.classList.add('on'); ui.remoteName.textContent = S.peerName || ui.remoteName.textContent; };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && S.state === 'incall') setTimeout(() => { if (pc.connectionState !== 'connected') endLocal(); }, 1500);
    };
    return pc;
  }
  function show(el) { el.classList.add('show'); }
  function hide(el) { el && el.classList.remove('show'); }

  /* ── Flujo ejecutivo: probar → llamar ── */
  async function start(convId, { selfName, peerName }) {
    if (S.state !== 'idle') return;
    build();
    S.convId = convId; S.peerName = peerName || 'Interlocutor'; if (selfName) S.selfName = selfName;
    S.state = 'testing'; ui.testErr.textContent = '';
    try {
      await getMedia(); ui.testVid.srcObject = S.local; startMeter(S.local);
      show(ui.test);
    } catch (e) { ui.testErr.textContent = 'No se pudo acceder a la cámara/micrófono. ' + motivoMedia(e); show(ui.test); }
  }
  function cancelTest() { stopMeter(); hide(ui.test); cleanup(); }
  async function ring() {
    stopMeter(); hide(ui.test);
    if (!S.local) { try { await getMedia(); } catch (e) { alert('No hay acceso a la cámara o el micrófono. ' + motivoMedia(e)); return cleanup(); } }
    S.state = 'calling';
    openCallWindow('Llamando a ' + S.peerName + '…', S.peerName);
    ui.wait.textContent = 'Llamando…';
    S.signal(S.convId, 'call', { fromName: S.selfName });
    clearTimeout(S.ringTimer);
    S.ringTimer = setTimeout(() => { if (S.state === 'calling') { alert('El dealer no contestó.'); endLocal(); } }, 35000);
  }
  // Ejecutivo recibe 'accept' del dealer → crea la oferta
  async function onAccept() {
    clearTimeout(S.ringTimer);
    S.pc = await newPc();
    S.local.getTracks().forEach(t => S.pc.addTrack(t, S.local));
    const offer = await S.pc.createOffer();
    await S.pc.setLocalDescription(offer);
    S.signal(S.convId, 'offer', offer);
    S.state = 'incall'; ui.wait.textContent = 'Conectando…';
  }

  /* ── Flujo dealer: recibe solicitud → acepta/rechaza ── */
  function onIncoming(convId, payload) {
    build();
    if (S.state !== 'idle') { S.signal(convId, 'reject', { busy: true }); return; }
    S.convId = convId; S.peerName = (payload && payload.fromName) || 'Ejecutivo';
    S.state = 'incoming'; ui.incName.textContent = S.peerName;
    show(ui.inc);
  }
  async function accept() {
    hide(ui.inc);
    try { await getMedia(); } catch (e) { alert('No se pudo acceder a la cámara/micrófono. ' + motivoMedia(e)); reject(); return; }
    S.pc = await newPc();
    S.local.getTracks().forEach(t => S.pc.addTrack(t, S.local));
    S.state = 'incall';
    openCallWindow('En llamada', S.peerName);
    ui.wait.textContent = 'Conectando…';
    S.signal(S.convId, 'accept', {});
  }
  function reject() { hide(ui.inc); S.signal(S.convId, 'reject', {}); cleanup(); }
  // Dealer recibe la oferta → responde
  async function onOffer(offer) {
    if (!S.pc) return;
    await S.pc.setRemoteDescription(new RTCSessionDescription(offer));
    drainIce();
    const ans = await S.pc.createAnswer();
    await S.pc.setLocalDescription(ans);
    S.signal(S.convId, 'answer', ans);
  }
  async function onAnswer(ans) { if (S.pc) { await S.pc.setRemoteDescription(new RTCSessionDescription(ans)); drainIce(); } }
  async function onIceMsg(c) {
    if (!c) return;
    if (S.pc && S.pc.remoteDescription) { try { await S.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {} }
    else S.pendingIce.push(c);
  }
  function drainIce() { S.pendingIce.forEach(c => S.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); S.pendingIce = []; }

  /* ── Ventana de llamada / controles ── */
  function openCallWindow(title, remoteName) {
    ui.wtitle.textContent = title; ui.remoteName.textContent = remoteName || S.peerName;
    ui.wait.style.display = 'flex'; ui.wst.classList.remove('on');
    ui.mic.classList.remove('off'); ui.cam.classList.remove('off'); ui.screen.classList.remove('act');
    S.micOn = true; S.camOn = true; S.screen = false;
    setMedia();
    show(ui.win);
  }
  // Nombre del interlocutor en la ventana PiP del sistema (en vez de la URL).
  function setMedia() {
    try {
      if ('mediaSession' in navigator)
        navigator.mediaSession.metadata = new MediaMetadata({ title: S.peerName || 'Interlocutor', artist: 'AutoFácil · Atención Remota' });
    } catch (_) {}
  }
  function toggleMic() { if (!S.local) return; S.micOn = !S.micOn; S.local.getAudioTracks().forEach(t => t.enabled = S.micOn); ui.mic.classList.toggle('off', !S.micOn); ui.mic.innerHTML = `<i class="bi bi-mic${S.micOn ? '-fill' : '-mute-fill'}"></i>`; }
  function toggleCam() { if (!S.local) return; S.camOn = !S.camOn; S.local.getVideoTracks().forEach(t => t.enabled = S.camOn); ui.cam.classList.toggle('off', !S.camOn); ui.cam.innerHTML = `<i class="bi bi-camera-video${S.camOn ? '-fill' : '-off-fill'}"></i>`; }
  // Carga MediaPipe + el módulo de fondo SOLO cuando se usa (no en el arranque de la página).
  let fondoLibProm = null;
  function cargarFondoLib() {
    if (window.AF_FONDO && AF_FONDO.disponible()) return Promise.resolve(true);
    if (fondoLibProm) return fondoLibProm;
    fondoLibProm = new Promise(resolve => {
      const s1 = document.createElement('script'); s1.src = '/js/mediapipe/selfie_segmentation.js';
      s1.onerror = () => resolve(false);
      s1.onload = () => {
        const s2 = document.createElement('script'); s2.src = '/js/fondo-virtual.js';
        s2.onload = () => resolve(!!(window.AF_FONDO && AF_FONDO.disponible()));
        s2.onerror = () => resolve(false);
        document.head.appendChild(s2);
      };
      document.head.appendChild(s1);
    });
    return fondoLibProm;
  }
  // Fondo virtual: cicla sin fondo → desenfoque → oficina AutoFácil, reemplazando el
  // track de video EN VIVO (no toca la cámara base ni renegocia la llamada).
  async function toggleFondo() {
    if (!S.local) return;
    if (!(window.AF_FONDO && AF_FONDO.disponible())) {
      ui.fondo.innerHTML = '<i class="bi bi-hourglass-split"></i>';
      const ok = await cargarFondoLib();
      ui.fondo.innerHTML = '<i class="bi bi-image"></i>';
      if (!ok) { alert('No se pudo cargar el fondo virtual.'); return; }
    }
    const orden = ['ninguno', 'blur', 'imagen'];
    const next = orden[(orden.indexOf(S.fondo || 'ninguno') + 1) % orden.length];
    const rawTrack = S.local.getVideoTracks()[0];
    const sender = S.pc && S.pc.getSenders().find(x => x.track && x.track.kind === 'video');
    try {
      if (next === 'ninguno') {
        AF_FONDO.detener(); S.fondoTrack = null;
        if (sender && rawTrack) await sender.replaceTrack(rawTrack);
        ui.localVid.srcObject = S.local;
      } else if (AF_FONDO.activo()) {
        AF_FONDO.setModo(next);                 // ya procesando: solo cambia el modo (mismo track)
      } else {
        S.fondoTrack = await AF_FONDO.iniciar(rawTrack, next);
        if (sender && S.fondoTrack) await sender.replaceTrack(S.fondoTrack);
        if (S.fondoTrack) ui.localVid.srcObject = new MediaStream([S.fondoTrack, ...S.local.getAudioTracks()]);
      }
    } catch (_) {}
    S.fondo = next;
    const lbl = { ninguno: 'sin fondo', blur: 'desenfocado', imagen: 'oficina AutoFácil' }[next];
    ui.fondo.classList.toggle('off', next === 'ninguno');
    ui.fondo.title = 'Fondo: ' + lbl;
    ui.fondo.innerHTML = `<i class="bi bi-${next === 'imagen' ? 'building' : (next === 'blur' ? 'circle-half' : 'image')}"></i>`;
  }
  async function toggleScreen() {
    if (!S.pc) return;
    if (!S.screen) {
      try {
        const ds = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = ds.getVideoTracks()[0];
        const sender = S.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(track);
        S.screenStream = ds; S.screen = true; ui.screen.classList.add('act');
        ui.localVid.srcObject = ds; ui.localVid.style.transform = 'none';
        track.onended = () => stopScreen();
      } catch (_) {}
    } else stopScreen();
  }
  async function stopScreen() {
    if (S.screenStream) { S.screenStream.getTracks().forEach(t => t.stop()); S.screenStream = null; }
    const camTrack = S.local && S.local.getVideoTracks()[0];
    const sender = S.pc && S.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && camTrack) await sender.replaceTrack(camTrack);
    ui.localVid.srcObject = S.local; ui.localVid.style.transform = 'scaleX(-1)';
    S.screen = false; ui.screen.classList.remove('act');
  }
  // PiP con el nombre del interlocutor dibujado sobre el video (canvas).
  function startPipCompose() {
    if (!pipCanvas) return;
    const v = ui.remote, ctx = pipCanvas.getContext('2d');
    if (!pipStream) { pipStream = pipCanvas.captureStream(15); pipVideo.srcObject = pipStream; }
    const draw = () => {
      const w = v.videoWidth || 640, h = v.videoHeight || 480;
      if (pipCanvas.width !== w) pipCanvas.width = w;
      if (pipCanvas.height !== h) pipCanvas.height = h;
      try { ctx.drawImage(v, 0, 0, w, h); } catch (_) {}
      const name = S.peerName || 'Interlocutor';
      const fs = Math.max(15, Math.round(h * 0.06)), bar = Math.round(fs * 1.7);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, w, bar);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
      ctx.font = '700 ' + fs + 'px Segoe UI, system-ui, sans-serif';
      ctx.fillText(name, Math.round(fs * 0.6), Math.round(bar / 2));
      S._pipRAF = requestAnimationFrame(draw);
    };
    cancelAnimationFrame(S._pipRAF); draw();
  }
  function stopPipCompose() { if (S._pipRAF) cancelAnimationFrame(S._pipRAF); S._pipRAF = null; }
  function enterPip() {
    try {
      startPipCompose();
      pipVideo.play().catch(() => {});
      const go = () => pipVideo.requestPictureInPicture().catch(() => {});
      if (pipVideo.readyState >= 2) go(); else pipVideo.onloadedmetadata = go;
    } catch (_) {}
  }
  async function togglePip() {
    setMedia();
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else enterPip(); } catch (_) {}
  }

  /* ── Medidor de micrófono (prueba) ── */
  function startMeter(stream) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 256; src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      S._meterCtx = ctx;
      const loop = () => {
        an.getByteFrequencyData(data);
        const v = Math.min(100, Math.round((data.reduce((a, b) => a + b, 0) / data.length) * 1.6));
        if (ui.testMeter) ui.testMeter.style.width = v + '%';
        S.meterRAF = requestAnimationFrame(loop);
      };
      loop();
    } catch (_) {}
  }
  function stopMeter() { if (S.meterRAF) cancelAnimationFrame(S.meterRAF); S.meterRAF = null; if (S._meterCtx) { try { S._meterCtx.close(); } catch (_) {} S._meterCtx = null; } if (ui.testMeter) ui.testMeter.style.width = '0%'; }

  /* ── Fin de llamada ── */
  function hangup() { S.signal(S.convId, 'hangup', {}); endLocal(); }
  function endLocal() { cleanup(); }
  function cleanup() {
    clearTimeout(S.ringTimer); stopMeter(); stopPipCompose();
    try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (_) {}
    try { if (pipStream) { pipStream.getTracks().forEach(t => t.stop()); pipStream = null; if (pipVideo) pipVideo.srcObject = null; } } catch (_) {}
    try { if ('mediaSession' in navigator) navigator.mediaSession.metadata = null; } catch (_) {}
    if (S.pc) { try { S.pc.close(); } catch (_) {} S.pc = null; }
    if (S.screenStream) { S.screenStream.getTracks().forEach(t => t.stop()); S.screenStream = null; }
    try { if (window.AF_FONDO) AF_FONDO.detener(); } catch (_) {}
    S.fondo = 'ninguno'; S.fondoTrack = null;
    if (S.local) { S.local.getTracks().forEach(t => t.stop()); S.local = null; }
    if (ui.remote) ui.remote.srcObject = null;
    if (ui.localVid) ui.localVid.srcObject = null;
    hide(ui.win); hide(ui.inc); hide(ui.test);
    S.state = 'idle'; S.pendingIce = []; S.screen = false; S.convId = null;
  }

  /* ── Drag de la ventana ── */
  function makeDraggable(box, handle) {
    let ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', e => {
      dragging = true; const r = box.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      box.style.right = 'auto'; box.style.bottom = 'auto'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      box.style.left = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, e.clientX - ox)) + 'px';
      box.style.top = Math.max(0, Math.min(window.innerHeight - box.offsetHeight, e.clientY - oy)) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  /* ── Enrutador de señales 'rtc' ── */
  function onRtc(convId, kind, payload, from) {
    if (kind === 'call') { onIncoming(convId, payload); return; }
    if (S.convId && convId !== S.convId) return;   // pertenece a otra conversación
    switch (kind) {
      case 'accept': onAccept(); break;
      case 'reject': if (S.state === 'calling') { clearTimeout(S.ringTimer); alert(payload && payload.busy ? 'El dealer está ocupado.' : 'Llamada rechazada.'); endLocal(); } break;
      case 'offer':  onOffer(payload); break;
      case 'answer': onAnswer(payload); break;
      case 'ice':    onIceMsg(payload); break;
      case 'hangup': if (S.state !== 'idle') { endLocal(); } break;
    }
  }

  function init({ role, selfName, iceUrl, token, signal }) {
    S.role = role; S.selfName = selfName || ''; S.iceUrl = iceUrl; S.token = token; S.signal = signal;
    build();
  }
  function setSelfName(n) { S.selfName = n || S.selfName; }
  function busy() { return S.state !== 'idle'; }

  window.ARTC = { init, start, onRtc, hangup, setSelfName, busy };
})();
