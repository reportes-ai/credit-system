/* ════════════════════════════════════════════════════════════════════
   AutoFácil — Humoradas 🎮  (juegos flotantes, lanzados por BG-ADMIN)
   Ventana arrastrable + cerrable que aparece sobre la pantalla de trabajo.
   Sin dependencias. window.AF_JUEGOS = { lanzar, cerrar, lista }.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.AF_JUEGOS) return;
  const CW = 420, CH = 420;
  let win = null, current = null;

  function cerrar() {
    if (current && current.stop) { try { current.stop(); } catch (e) {} }
    current = null;
    if (win) { win.remove(); win = null; }
  }

  function dragify(box, handle) {
    let drag = false, bx = 0, by = 0, sx = 0, sy = 0;
    handle.addEventListener('mousedown', e => {
      drag = true; const r = box.getBoundingClientRect();
      box.style.transform = 'none'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      bx = r.left; by = r.top; sx = e.clientX; sy = e.clientY; e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag || !document.body.contains(box)) return;
      box.style.left = (bx + e.clientX - sx) + 'px'; box.style.top = (by + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  function shell(titulo, mensaje, tip) {
    cerrar();
    win = document.createElement('div');
    win.id = 'afJuegoWin';
    win.style.cssText = 'position:fixed;z-index:2000000;left:50%;top:50%;transform:translate(-50%,-50%);width:' + (CW + 24) + 'px;background:#0b1020;border:1px solid #1f2937;border-radius:16px;box-shadow:0 26px 80px rgba(0,0,0,.6);color:#e5e7eb;font-family:system-ui,sans-serif;user-select:none';
    win.innerHTML =
      '<div id="afJuegoHead" style="cursor:move;display:flex;align-items:center;gap:9px;padding:9px 12px;background:linear-gradient(90deg,#111827,#1f2937);border-radius:16px 16px 0 0">' +
        '<span style="font-size:1rem;font-weight:800;white-space:nowrap">' + titulo + '</span>' +
        '<span style="flex:1;font-size:.72rem;color:#93c5fd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (mensaje || '') + '</span>' +
        '<span style="font-size:.72rem;color:#94a3b8">Puntos</span><span id="afJuegoScore" style="font-size:.95rem;font-weight:800;color:#fbbf24;min-width:20px;text-align:right">0</span>' +
        '<button id="afJuegoX" title="Cerrar" style="background:#7f1d1d;border:none;color:#fff;border-radius:7px;width:26px;height:26px;cursor:pointer;font-weight:800;font-size:.85rem">✕</button>' +
      '</div>' +
      '<canvas id="afJuegoCv" width="' + CW + '" height="' + CH + '" style="display:block;margin:12px;border-radius:11px;background:#0f172a;touch-action:none"></canvas>' +
      '<div style="text-align:center;font-size:.72rem;color:#64748b;padding:0 12px 11px">' + (tip || '') + '</div>';
    document.body.appendChild(win);
    win.querySelector('#afJuegoX').onclick = cerrar;
    dragify(win, win.querySelector('#afJuegoHead'));
    return win.querySelector('#afJuegoCv');
  }
  const setScore = s => { const e = win && win.querySelector('#afJuegoScore'); if (e) e.textContent = s; };

  /* ── helpers de dibujo ── */
  function over(ctx, t, s) {
    ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px system-ui'; ctx.fillText(t, CW / 2, CH / 2 - 10);
    ctx.fillStyle = '#cbd5e1'; ctx.font = '13px system-ui'; ctx.fillText(s, CW / 2, CH / 2 + 20);
  }
  const mpos = (cv, e) => { const r = cv.getBoundingClientRect(); const c = e.touches ? e.touches[0] : e;
    return { x: (c.clientX - r.left) * (CW / r.width), y: (c.clientY - r.top) * (CH / r.height) }; };

  /* ════════════ 1 · SNAKE — Culebra Cobradora ════════════ */
  function snake(cv, ctx, score) {
    const N = 20, S = CW / N; let sn = [{ x: 9, y: 10 }], dir = { x: 1, y: 0 }, nd = dir, fd = spawn(), pts = 0, ov = false, al = true, acc = 0, last = 0;
    function spawn() { let p; do { p = { x: Math.random() * N | 0, y: Math.random() * N | 0 }; } while (sn && sn.some(s => s.x === p.x && s.y === p.y)); return p; }
    function key(e) { const k = e.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault();
      if (ov && (k === 'Enter' || k === ' ')) return reset();
      if (k === 'ArrowUp' && dir.y === 0) nd = { x: 0, y: -1 };
      else if (k === 'ArrowDown' && dir.y === 0) nd = { x: 0, y: 1 };
      else if (k === 'ArrowLeft' && dir.x === 0) nd = { x: -1, y: 0 };
      else if (k === 'ArrowRight' && dir.x === 0) nd = { x: 1, y: 0 };
    }
    function reset() { sn = [{ x: 9, y: 10 }]; dir = { x: 1, y: 0 }; nd = dir; fd = spawn(); pts = 0; ov = false; score(0); }
    window.addEventListener('keydown', key);
    function tick() { dir = nd; const h = { x: sn[0].x + dir.x, y: sn[0].y + dir.y };
      if (h.x < 0 || h.y < 0 || h.x >= N || h.y >= N || sn.some(s => s.x === h.x && s.y === h.y)) { ov = true; return; }
      sn.unshift(h); if (h.x === fd.x && h.y === fd.y) { pts++; score(pts); fd = spawn(); } else sn.pop();
    }
    function frame(t) { if (!al) return; const dt = t - last; last = t;
      if (!ov) { acc += dt; while (acc >= 110) { tick(); acc -= 110; } }
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, CW, CH);
      ctx.font = (S - 3) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('💵', fd.x * S + S / 2, fd.y * S + S / 2);
      sn.forEach((s, i) => { ctx.fillStyle = i === 0 ? '#22d3ee' : '#0ea5e9'; ctx.fillRect(s.x * S + 1, s.y * S + 1, S - 2, S - 2); });
      if (ov) over(ctx, 'GAME OVER', 'Enter o Espacio para reiniciar');
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { stop() { al = false; window.removeEventListener('keydown', key); } };
  }

  /* ════════════ 2 · RUNNER — Pato Run ════════════ */
  function runner(cv, ctx, score) {
    const ground = CH - 60; let py = ground, vy = 0, jmp = false, pts = 0, ov = false, al = true, obs = [], spT = 0, spd = 4.2, last = 0;
    function jump() { if (!jmp) { vy = -11.5; jmp = true; } }
    function act() { ov ? reset() : jump(); }
    function key(e) { if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); act(); } }
    function reset() { py = ground; vy = 0; jmp = false; pts = 0; ov = false; obs = []; spd = 4.2; score(0); }
    window.addEventListener('keydown', key); cv.addEventListener('mousedown', act);
    function frame(t) { if (!al) return; const dt = Math.min(t - last || 16, 40); last = t;
      if (!ov) { vy += 0.62; py += vy; if (py >= ground) { py = ground; vy = 0; jmp = false; }
        spT -= dt; if (spT <= 0) { obs.push({ x: CW + 20, w: 16 + Math.random() * 16, h: 22 + Math.random() * 24 }); spT = 620 + Math.random() * 720; }
        obs.forEach(o => o.x -= spd); obs = obs.filter(o => o.x > -40);
        pts += dt * 0.01; score(pts | 0); spd = 4.2 + pts / 700;
        for (const o of obs) if (78 > o.x && 50 < o.x + o.w && py > ground - o.h + 6) ov = true;
      }
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, CW, CH);
      ctx.fillStyle = '#1e293b'; ctx.fillRect(0, ground + 22, CW, CH - ground - 22);
      ctx.font = '30px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('🦆', 62, py + 4);
      obs.forEach(o => { ctx.fillStyle = '#ef4444'; ctx.fillRect(o.x, ground - o.h + 22, o.w, o.h); });
      if (ov) over(ctx, '¡CHOCASTE!', 'Espacio o clic para reiniciar');
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { stop() { al = false; window.removeEventListener('keydown', key); } };
  }

  /* ════════════ 3 · BREAKOUT — Rompe-Mora ════════════ */
  function breakout(cv, ctx, score) {
    let al = true, ov = false, gano = false, pts = 0;
    let pad = { x: CW / 2 - 42, w: 84 }, ball = { x: CW / 2, y: CH - 44, vx: 3, vy: -3.4, r: 6 };
    const cols = 8, rows = 4, bw = (CW - 40) / cols, bh = 18, cor = ['#f87171', '#fbbf24', '#34d399', '#60a5fa'];
    let br = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) br.push({ x: 20 + c * bw, y: 40 + r * (bh + 6), w: bw - 6, h: bh, on: true, col: cor[r] });
    function move(e) { pad.x = Math.max(0, Math.min(CW - pad.w, mpos(cv, e).x - pad.w / 2)); }
    function reset() { br.forEach(b => b.on = true); ball = { x: CW / 2, y: CH - 44, vx: 3, vy: -3.4, r: 6 }; ov = false; gano = false; pts = 0; score(0); }
    cv.addEventListener('mousemove', move); cv.addEventListener('touchmove', e => { e.preventDefault(); move(e); }, { passive: false });
    cv.addEventListener('mousedown', () => { if (ov) reset(); });
    function frame() { if (!al) return;
      if (!ov) { ball.x += ball.vx; ball.y += ball.vy;
        if (ball.x < ball.r || ball.x > CW - ball.r) ball.vx *= -1;
        if (ball.y < ball.r) ball.vy *= -1;
        if (ball.y > CH) ov = true;
        if (ball.y > CH - 22 - ball.r && ball.x > pad.x && ball.x < pad.x + pad.w && ball.vy > 0) { ball.vy *= -1; ball.vx = (ball.x - (pad.x + pad.w / 2)) / 8; }
        for (const b of br) if (b.on && ball.x > b.x && ball.x < b.x + b.w && ball.y > b.y && ball.y < b.y + b.h) { b.on = false; ball.vy *= -1; pts++; score(pts); break; }
        if (br.every(b => !b.on)) { ov = true; gano = true; }
      }
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, CW, CH);
      br.forEach(b => { if (b.on) { ctx.fillStyle = b.col; ctx.fillRect(b.x, b.y, b.w, b.h); } });
      ctx.fillStyle = '#e5e7eb'; ctx.fillRect(pad.x, CH - 20, pad.w, 10);
      ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.r, 0, 7); ctx.fillStyle = '#fbbf24'; ctx.fill();
      if (ov) over(ctx, gano ? '¡SIN MORA! 🎉' : 'GAME OVER', 'Clic para reiniciar');
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { stop() { al = false; } };
  }

  /* ════════════ 4 · TOPO — Aplasta al Moroso ════════════ */
  function topo(cv, ctx, score) {
    let al = true, ov = false, pts = 0, tl = 30, last = 0, popT = 0;
    const cols = 3, rows = 3, cw = CW / cols, ch = (CH - 24) / rows, cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: c * cw + cw / 2, y: 30 + r * ch + ch / 2, up: false });
    function click(e) { if (ov) return reset(); const p = mpos(cv, e);
      for (const c of cells) if (c.up && Math.hypot(p.x - c.x, p.y - c.y) < 36) { c.up = false; pts++; score(pts); break; } }
    function reset() { pts = 0; tl = 30; ov = false; cells.forEach(c => c.up = false); score(0); }
    cv.addEventListener('mousedown', click);
    function frame(t) { if (!al) return; const dt = t - last || 16; last = t;
      if (!ov) { tl -= dt / 1000; if (tl <= 0) { tl = 0; ov = true; }
        popT -= dt; if (popT <= 0) { const c = cells[Math.random() * cells.length | 0]; c.up = true; setTimeout(() => { c.up = false; }, 850); popT = 480 + Math.random() * 520; } }
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, CW, CH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      cells.forEach(c => { ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.ellipse(c.x, c.y + 20, 36, 13, 0, 0, 7); ctx.fill();
        if (c.up) { ctx.font = '36px system-ui'; ctx.fillText('🧟', c.x, c.y); } });
      ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('⏱ ' + Math.ceil(tl) + 's', 12, 20);
      if (ov) over(ctx, '¡Tiempo! ' + pts + ' morosos', 'Clic para jugar de nuevo');
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { stop() { al = false; } };
  }

  /* ════════════ 5 · CATAPULTA — Catapulta de Cobranza ════════════ */
  function catapulta(cv, ctx, score) {
    let al = true, pts = 0, ball = null, drag = false, aim = null;
    const o = { x: 58, y: CH - 64 }; let blocks = [];
    function build() { blocks = []; const bx = CW - 96; for (let i = 0; i < 5; i++) blocks.push({ x: bx + (i % 2) * 28, y: CH - 50 - i * 30, w: 26, h: 28, on: true }); }
    build();
    function down(e) { if (ball) return; drag = true; aim = mpos(cv, e); }
    function moveE(e) { if (drag) aim = mpos(cv, e); }
    function up() { if (!drag) return; drag = false; const dx = o.x - aim.x, dy = o.y - aim.y; ball = { x: o.x, y: o.y, vx: dx * 0.2, vy: dy * 0.2 }; aim = null; }
    cv.addEventListener('mousedown', down); cv.addEventListener('mousemove', moveE); document.addEventListener('mouseup', up);
    function frame() { if (!al) return;
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, CW, CH);
      ctx.fillStyle = '#1e293b'; ctx.fillRect(0, CH - 24, CW, 24);
      ctx.strokeStyle = '#475569'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, CH - 24); ctx.stroke();
      blocks.forEach(b => { if (b.on) { ctx.fillStyle = '#f59e0b'; ctx.fillRect(b.x, b.y, b.w, b.h); ctx.fillStyle = '#7c2d12'; ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$', b.x + b.w / 2, b.y + b.h / 2); } });
      if (ball) { ball.vy += 0.4; ball.x += ball.vx; ball.y += ball.vy;
        for (const b of blocks) if (b.on && ball.x > b.x && ball.x < b.x + b.w && ball.y > b.y && ball.y < b.y + b.h) { b.on = false; pts++; score(pts); ball.vx *= 0.55; ball.vy *= -0.4; }
        if (ball.y > CH - 24 || ball.x > CW || ball.x < 0) { ball = null; if (blocks.every(b => !b.on)) build(); }
      } else if (drag && aim) { ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(aim.x, aim.y); ctx.stroke(); ctx.setLineDash([]); }
      ctx.font = '24px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🐦', ball ? ball.x : o.x, ball ? ball.y : o.y);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { stop() { al = false; document.removeEventListener('mouseup', up); } };
  }

  const GAMES = {
    snake:     { nombre: '🐍 Culebra Cobradora', tip: 'Flechas para mover · come las cuotas 💵', run: snake },
    runner:    { nombre: '🦆 Pato Run',          tip: 'Espacio o clic para saltar los morosos', run: runner },
    breakout:  { nombre: '🧱 Rompe-Mora',        tip: 'Mueve el mouse · rompe toda la mora', run: breakout },
    topo:      { nombre: '🔨 Aplasta al Moroso', tip: 'Clic sobre el moroso antes que se esconda · 30s', run: topo },
    catapulta: { nombre: '🐦 Catapulta de Cobranza', tip: 'Arrastra hacia atrás y suelta · tumba la torre de deudas', run: catapulta },
  };

  function lanzar(id, mensaje) {
    const g = GAMES[id] || GAMES.snake;
    const cv = shell(g.nombre, mensaje || '¡Break sorpresa del jefe! 🎉', g.tip);
    const ctx = cv.getContext('2d');
    current = g.run(cv, ctx, setScore) || {};
  }

  window.AF_JUEGOS = {
    lanzar, cerrar,
    lista: () => Object.keys(GAMES).map(id => ({ id, nombre: GAMES[id].nombre, tip: GAMES[id].tip })),
  };
})();
