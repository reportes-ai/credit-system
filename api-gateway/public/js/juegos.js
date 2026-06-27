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

  /* ════════════ 6 · COME-LETRAS — Pac-Man que se come la pantalla real 😈 ════════════
     Humorada INTRUSIVA: un Pac-Man recorre la app y va borrando las letras visibles
     del DOM (no toca inputs/textarea para no perder lo que el usuario escribe).
     "Restaurar" recarga la página. */
  function comeLetras(mensaje) {
    let alive = true, eaten = 0, raf = null, target = null, biteCd = 0, lastT = 0;
    let px = window.innerWidth / 2, py = window.innerHeight * 0.4;
    const BAD = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'CANVAS', 'IMG']);

    const lay = document.createElement('div');
    lay.id = 'afComeLetras'; lay.style.cssText = 'position:fixed;inset:0;z-index:2000000;pointer-events:none';
    const pac = document.createElement('div');
    pac.style.cssText = 'position:fixed;font-size:30px;line-height:1;text-align:center;left:0;top:0;transform:translate(-50%,-50%);filter:drop-shadow(0 2px 5px rgba(0,0,0,.45));transition:none';
    pac.textContent = '🟡';
    const chip = document.createElement('div');
    chip.id = 'afCLchip';
    chip.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);pointer-events:auto;background:#111827;color:#fff;border-radius:30px;padding:8px 14px;font:600 13px system-ui;display:flex;gap:12px;align-items:center;z-index:2000003;box-shadow:0 10px 30px rgba(0,0,0,.45)';
    chip.innerHTML = '<span>🟡 Come-Letras' + (mensaje ? ' — <span style="color:#93c5fd">' + mensaje + '</span>' : '') + '</span>' +
      '<span style="color:#fbbf24">comidas <b id="afCLn">0</b></span>' +
      '<button id="afCLrest" style="background:#1f2937;border:none;color:#fff;border-radius:20px;padding:4px 11px;cursor:pointer;font-weight:700">🔄 Restaurar</button>' +
      '<button id="afCLx" style="background:#7f1d1d;border:none;color:#fff;border-radius:20px;padding:4px 10px;cursor:pointer;font-weight:800">✕</button>';
    document.body.appendChild(lay); lay.appendChild(pac); document.body.appendChild(chip);
    pac.style.left = px + 'px'; pac.style.top = py + 'px';

    function visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }
    function nodos() {
      const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          let p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest('#afComeLetras') || p.closest('#afCLchip') || p.closest('#afJuegoWin')) return NodeFilter.FILTER_REJECT;
          for (let a = p; a; a = a.parentElement) if (BAD.has(a.tagName)) return NodeFilter.FILTER_REJECT;
          if (!visible(p)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let c, i = 0; while ((c = w.nextNode()) && i++ < 600) out.push(c);
      return out;
    }
    function primChar(n) { const s = n.nodeValue; let i = 0; while (i < s.length && /\s/.test(s[i])) i++; if (i >= s.length) return null;
      try { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const rc = r.getBoundingClientRect(); if (!rc.width && !rc.height) return null; return { rect: rc, index: i }; } catch (e) { return null; } }
    function pick() { const ns = nodos(); let best = null, bd = Infinity;
      for (const n of ns) { const fc = primChar(n); if (!fc) continue; const cx = fc.rect.left + fc.rect.width / 2, cy = fc.rect.top + fc.rect.height / 2; const d = (cx - px) * (cx - px) + (cy - py) * (cy - py); if (d < bd) { bd = d; best = n; } }
      return best; }

    function frame(t) { if (!alive) return; const dt = Math.min(t - lastT || 16, 50); lastT = t;
      if (!target || !target.parentElement || !target.nodeValue || !target.nodeValue.trim()) target = pick();
      if (target) { const fc = primChar(target);
        if (!fc) { target = null; }
        else { const cx = fc.rect.left + fc.rect.width / 2, cy = fc.rect.top + fc.rect.height / 2, dx = cx - px, dy = cy - py, dist = Math.hypot(dx, dy) || 1, sp = Math.min(9, dist);
          if (dist > 3) { px += dx / dist * sp; py += dy / dist * sp; }
          pac.style.left = px + 'px'; pac.style.top = py + 'px';
          biteCd -= dt;
          if (dist < 18 && biteCd <= 0) { const s = target.nodeValue; target.nodeValue = s.slice(0, fc.index) + s.slice(fc.index + 1);
            eaten++; const e = document.getElementById('afCLn'); if (e) e.textContent = eaten; biteCd = 55; pac.textContent = pac.textContent === '🟡' ? '😮' : '🟡'; }
        }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    chip.querySelector('#afCLx').onclick = () => window.AF_JUEGOS.cerrar();
    chip.querySelector('#afCLrest').onclick = () => location.reload();
    return { esPagina: true, stop() { alive = false; if (raf) cancelAnimationFrame(raf); lay.remove(); chip.remove(); } };
  }

  /* ════════════ 7 · MÓDULOS ESCURRIDIZOS — las cards se escapan al clickear 😈 ════════════
     El 1er clic en una card no hace nada; el 2º la hace "escapar" intercambiando lugar
     con otra (animado FLIP). Con el tiempo escala: más cards saltando, cada vez más rápido.
     A los 2 minutos restaura el orden original y libera los clics. 100% cosmético. */
  function notaFlotante(txt) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2000003;background:#111827;color:#fff;border-radius:12px;padding:9px 14px;font:600 13px system-ui;box-shadow:0 10px 30px rgba(0,0,0,.4)';
    d.textContent = txt; document.body.appendChild(d); setTimeout(() => d.remove(), 6000); return d;
  }
  function escapistas(mensaje) {
    const SEL = '.module-card, .ap-card, .report-card';
    let alive = true, waitId = null, tries = 0, cleanup = null;
    // Las cards del Inicio se generan por JS tras cargar permisos → esperamos a que existan.
    function start() {
      if (!alive) return;
      const lista = [...document.querySelectorAll(SEL)];
      if (lista.length < 2) { if (tries++ < 40) waitId = setTimeout(start, 500); else notaFlotante('🃏 Humorada activa — abre una pantalla con módulos para verla'); return; }
      let timer = null, torn = false, t0 = Date.now(); const intentos = new Map();
      const grid = lista[0].parentElement;
      const original = [...grid.children].filter(c => c.matches(SEL));
      const cards = () => [...grid.children].filter(c => c.matches(SEL));
      const rnd = a => a[Math.random() * a.length | 0];
      function swapNodes(a, b) { if (!a || !b || a === b) return; const m = document.createComment('x'); a.parentNode.insertBefore(m, a); b.parentNode.insertBefore(a, b); m.parentNode.insertBefore(b, m); m.remove(); }
      function flip(reorder) {
        const cs = cards(), bef = new Map(); cs.forEach(c => bef.set(c, c.getBoundingClientRect())); reorder();
        cs.forEach(c => { const a = bef.get(c), b = c.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top; if (!dx && !dy) return;
          c.style.transition = 'none'; c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; c.style.zIndex = '40';
          requestAnimationFrame(() => { c.style.transition = 'transform .5s cubic-bezier(.2,.85,.3,1)'; c.style.transform = 'translate(0,0)'; });
          setTimeout(() => { c.style.transition = ''; c.style.transform = ''; c.style.zIndex = ''; }, 560);
        });
      }
      function swapDos(excl) { const cs = cards(); if (cs.length < 2) return; const a = excl && cs.includes(excl) ? excl : rnd(cs); let b, g = 0; do { b = rnd(cs); } while (b === a && g++ < 12); flip(() => swapNodes(a, b)); }
      function wiggle(el) { let i = 0; el.style.transition = 'transform .08s'; const id = setInterval(() => { el.style.transform = 'translate(' + ((i % 2 ? -1 : 1) * 6) + 'px,0)'; if (i++ > 5) { clearInterval(id); el.style.transform = ''; setTimeout(() => el.style.transition = '', 120); } }, 50); }
      const onClick = e => { if (!alive) return; const card = e.target.closest(SEL); if (!card || !grid.contains(card)) return;
        e.preventDefault(); e.stopPropagation();
        const n = (intentos.get(card) || 0) + 1; intentos.set(card, n);
        if (n >= 2) swapDos(card); else wiggle(card);
      };
      document.addEventListener('click', onClick, true);
      function tick() { if (!alive) return; const el = Date.now() - t0; if (el >= 60000) { cleanup(); return; }
        const f = el / 60000, nS = 1 + Math.floor(f * 2); for (let i = 0; i < nS; i++) swapDos();
        timer = setTimeout(tick, Math.max(550, 4500 - f * 3800));
      }
      timer = setTimeout(tick, 4000);
      const chip = document.createElement('div'); chip.id = 'afEscChip';
      chip.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2000003;background:#111827;color:#fff;border-radius:30px;padding:8px 14px;font:600 13px system-ui;display:flex;gap:12px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.45)';
      chip.innerHTML = '<span>🃏 Módulos Escurridizos' + (mensaje ? ' — <span style="color:#93c5fd">' + mensaje + '</span>' : '') + '</span><button id="afEscX" style="background:#7f1d1d;border:none;color:#fff;border-radius:20px;padding:4px 10px;cursor:pointer;font-weight:800">✕</button>';
      document.body.appendChild(chip);
      chip.querySelector('#afEscX').onclick = () => window.AF_JUEGOS.cerrar();
      cleanup = function () { if (torn) return; torn = true; alive = false; if (timer) clearTimeout(timer); document.removeEventListener('click', onClick, true); try { flip(() => original.forEach(c => grid.appendChild(c))); } catch (e) {} chip.remove(); };
    }
    start();
    return { esPagina: true, stop() { alive = false; if (waitId) clearTimeout(waitId); if (cleanup) cleanup(); } };
  }

  /* ════════════ 8 · VIDRIO ROTO — el clic quiebra la pantalla (10 veces) 🔨🪟 ════════════
     Cambia el cursor y, en cada clic, dibuja una grieta de vidrio en ese punto con
     sonido de vidrio roto (sintetizado). Tras 10 clics, restaura todo. Cosmético: no
     bloquea la app (overlay pointer-events:none, no preventDefault). */
  function vidrio(mensaje) {
    if (sessionStorage.getItem('af_vidrio_done') === '1') return { esPagina: true, stop() {} };
    let alive = true, left = parseInt(sessionStorage.getItem('af_vidrio_left') || '10', 10) || 10, actx = null;
    const NS = 'http://www.w3.org/2000/svg';
    const lay = document.createElement('div'); lay.id = 'afVidrio';
    lay.style.cssText = 'position:fixed;inset:0;z-index:2000000;pointer-events:none;overflow:hidden';
    document.body.appendChild(lay);
    const curSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><g fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"><circle cx="15" cy="15" r="2.5" fill="#ffffff"/><path d="M15 3 L15 9 M15 21 L15 27 M3 15 L9 15 M21 15 L27 15"/><path d="M7 7 L11 11 M23 7 L19 11 M7 23 L11 19 M23 23 L19 19" stroke="#7ab8ff"/></g></svg>';
    const CUR = 'url("data:image/svg+xml,' + encodeURIComponent(curSvg) + '") 15 15, crosshair';
    const st = document.createElement('style'); st.id = 'afVidrioStyle';
    st.textContent = 'html.af-vidrio, html.af-vidrio *{cursor:' + CUR + ' !important}';
    document.head.appendChild(st); document.documentElement.classList.add('af-vidrio');
    const chip = document.createElement('div'); chip.id = 'afVidrioChip';
    chip.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2000003;background:#111827;color:#fff;border-radius:30px;padding:8px 14px;font:600 13px system-ui;display:flex;gap:12px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.45)';
    chip.innerHTML = '<span>🔨 Vidrio Roto' + (mensaje ? ' — <span style="color:#93c5fd">' + mensaje + '</span>' : '') + ' · quedan <b id="afVn">' + left + '</b></span><button id="afVx" style="background:#7f1d1d;border:none;color:#fff;border-radius:20px;padding:4px 10px;cursor:pointer;font-weight:800">✕</button>';
    document.body.appendChild(chip);
    chip.querySelector('#afVx').onclick = () => window.AF_JUEGOS.cerrar();

    function snd() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime, dur = 0.4, buf = actx.createBuffer(1, actx.sampleRate * dur, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = actx.createBufferSource(); src.buffer = buf; const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200;
      const g = actx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(hp).connect(g).connect(actx.destination); src.start(t); src.stop(t + dur);
      for (let i = 0; i < 7; i++) { const o = actx.createOscillator(), gg = actx.createGain(), f = 1600 + Math.random() * 3400, tt = t + Math.random() * 0.16;
        o.type = 'triangle'; o.frequency.setValueAtTime(f, tt); o.frequency.exponentialRampToValueAtTime(f * 0.5, tt + 0.22);
        gg.gain.setValueAtTime(0.11, tt); gg.gain.exponentialRampToValueAtTime(0.001, tt + 0.24);
        o.connect(gg).connect(actx.destination); o.start(tt); o.stop(tt + 0.26); }
    } catch (e) {} }

    function grieta(x, y) {
      const size = 190 + Math.random() * 130, svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', size); svg.setAttribute('height', size);
      svg.style.cssText = 'position:fixed;left:' + (x - size / 2) + 'px;top:' + (y - size / 2) + 'px;pointer-events:none;overflow:visible;opacity:0;transform:scale(.5);transition:opacity .12s,transform .12s';
      const cx = size / 2, cy = size / 2; let d = '';
      const n = 9 + (Math.random() * 6 | 0);
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + Math.random() * 0.4; let r = 8, p = 'M' + cx + ',' + cy; const segs = 3 + (Math.random() * 3 | 0);
        for (let s = 0; s < segs; s++) { r += (size / 2 / segs) * (0.6 + Math.random() * 0.6); const aa = a + (Math.random() - 0.5) * 0.4; p += ' L' + (cx + Math.cos(aa) * r).toFixed(1) + ',' + (cy + Math.sin(aa) * r).toFixed(1); } d += p + ' '; }
      for (let ring = 1; ring <= 2; ring++) { const rr = size / 2 * (ring / 3), m = 11; let p = '';
        for (let k = 0; k <= m; k++) { const a = k / m * Math.PI * 2, r2 = rr * (0.82 + Math.random() * 0.32); p += (k ? 'L' : 'M') + (cx + Math.cos(a) * r2).toFixed(1) + ',' + (cy + Math.sin(a) * r2).toFixed(1); } d += p + 'Z '; }
      svg.innerHTML = '<path d="' + d + '" fill="none" stroke="rgba(140,190,255,.45)" stroke-width="3.5"/><path d="' + d + '" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.3"/><circle cx="' + cx + '" cy="' + cy + '" r="7" fill="rgba(255,255,255,.55)"/>';
      lay.appendChild(svg);
      requestAnimationFrame(() => { svg.style.opacity = '1'; svg.style.transform = 'scale(1)'; });
    }

    function onClick(e) { if (!alive || left <= 0) return;
      if (e.target && e.target.closest && e.target.closest('#afVidrioChip')) return;
      grieta(e.clientX, e.clientY); snd();
      left--; sessionStorage.setItem('af_vidrio_left', left); const el = document.getElementById('afVn'); if (el) el.textContent = left;
      if (left <= 0) { sessionStorage.setItem('af_vidrio_done', '1'); setTimeout(() => window.AF_JUEGOS.cerrar(), 1600); }
    }
    document.addEventListener('click', onClick, true);

    return { esPagina: true, stop() { alive = false; document.removeEventListener('click', onClick, true);
      document.documentElement.classList.remove('af-vidrio'); st.remove(); lay.remove(); chip.remove();
      if (actx) try { actx.close(); } catch (e) {} } };
  }

  /* ════════════ 9 · PANTALLA HACKER — consola C:\ falsa por 15s 🖥️ ════════════ */
  function terminal(mensaje) {
    if (sessionStorage.getItem('af_terminal_done') === '1') return { esPagina: true, stop() {} };
    let alive = true, t = null, end = null, lines = [], i = 0;
    const st = document.createElement('style'); st.id = 'afTermStyle';
    st.textContent = '@keyframes afBlink{50%{opacity:0}} #afTermCur{animation:afBlink 1s steps(1) infinite}';
    document.head.appendChild(st);
    const lay = document.createElement('div'); lay.id = 'afTerm';
    lay.style.cssText = 'position:fixed;inset:0;z-index:2000010;background:#000;color:#39ff7a;font:13px/1.45 Consolas,Menlo,monospace;padding:20px;overflow:hidden;white-space:pre-wrap;word-break:break-word';
    document.body.appendChild(lay);
    const SEED = ['AutoFácil OS [Versión 67.x]', '(c) AutoFácil Crédito Automotriz. Reservados todos los derechos.', '',
      'C:\\AUTOFACIL> chkdsk /f /r', 'El tipo del sistema de archivos es NTFS.',
      'Fase 1: examinando la estructura básica del sistema...', '  142528 registros de archivo procesados.',
      'Fase 2: examinando la vinculación de nombres de archivo...', 'Fase 3: examinando descriptores de seguridad...',
      'Verificando módulo AUTOFACIL.SYS .......... [ OK ]', 'Cargando creditos.dll .......... [ OK ]',
      'Cargando comisiones.dll .......... [ OK ]', 'Reindexando cartera ...', ''];
    function rp() { const A = ['Proceso', 'Servicio', 'Tarea', 'Hilo', 'Kernel'], V = ['ejecutado', 'cargado', 'optimizado', 'sincronizado', 'verificado', 'liberado'];
      return A[Math.random() * A.length | 0] + ' 0x' + (Math.random() * 0xFFFFFF | 0).toString(16).toUpperCase().padStart(6, '0') + ' ' + V[Math.random() * V.length | 0] + ' [' + (Math.random() * 100 | 0).toString().padStart(2, '0') + '%]'; }
    function paint() { lay.textContent = lines.slice(-44).join('\n') + '\n'; const c = document.createElement('span'); c.id = 'afTermCur'; c.textContent = '█'; lay.appendChild(c); }
    function step() { if (!alive) return; lines.push(i < SEED.length ? SEED[i++] : rp()); paint(); t = setTimeout(step, 90 + Math.random() * 160); }
    step();
    end = setTimeout(() => { if (window.AF_JUEGOS) window.AF_JUEGOS.cerrar(); }, 15000);
    const esc = e => { if (e.key === 'Escape' && window.AF_JUEGOS) window.AF_JUEGOS.cerrar(); };
    window.addEventListener('keydown', esc);
    return { esPagina: true, stop() { alive = false; if (t) clearTimeout(t); if (end) clearTimeout(end); window.removeEventListener('keydown', esc); sessionStorage.setItem('af_terminal_done', '1'); st.remove(); lay.remove(); } };
  }

  /* ════════════ 10 · MOUSE LOCO — clic en cards intermitente (15s sí / 15s no) 🖱️ ════════════ */
  function clickloco(mensaje) {
    if (sessionStorage.getItem('af_clickloco_done') === '1') return { esPagina: true, stop() {} };
    const SEL = '.module-card, .ap-card, .report-card';
    let alive = true, blocked = true, phase = 0, timer = null;
    const onClick = e => { if (!alive || !blocked) return; const card = e.target.closest(SEL); if (!card) return;
      e.preventDefault(); e.stopPropagation();
      card.style.transition = 'transform .07s'; card.style.transform = 'translate(4px,0)'; setTimeout(() => { card.style.transform = ''; setTimeout(() => card.style.transition = '', 120); }, 90); };
    document.addEventListener('click', onClick, true);
    const chip = document.createElement('div'); chip.id = 'afClChip';
    chip.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2000003;background:#111827;color:#fff;border-radius:30px;padding:8px 14px;font:600 13px system-ui;display:flex;gap:10px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.45)';
    document.body.appendChild(chip);
    function setChip() { chip.innerHTML = '<span>🖱️ Mouse Loco' + (mensaje ? ' — <span style="color:#93c5fd">' + mensaje + '</span>' : '') + '</span><span style="color:' + (blocked ? '#f87171' : '#34d399') + ';font-weight:800">' + (blocked ? '● clic BLOQUEADO' : '● clic OK') + '</span><button id="afClX" style="background:#7f1d1d;border:none;color:#fff;border-radius:20px;padding:4px 10px;cursor:pointer;font-weight:800">✕</button>';
      chip.querySelector('#afClX').onclick = () => window.AF_JUEGOS.cerrar(); }
    const PHASES = 3;  // bloqueado → ok → bloqueado, y luego vuelve a la normalidad
    function next() { if (!alive) return; if (phase >= PHASES) { sessionStorage.setItem('af_clickloco_done', '1'); cleanup(); return; } blocked = (phase % 2 === 0); setChip(); phase++; timer = setTimeout(next, 15000); }
    next();
    function cleanup() { alive = false; if (timer) clearTimeout(timer); document.removeEventListener('click', onClick, true); chip.remove(); }
    return { esPagina: true, stop() { cleanup(); } };
  }

  const GAMES = {
    terminal:  { nombre: '🖥️ Pantalla Hacker', tip: 'La pantalla se apaga y corre una consola C:\\ "haciendo procesos" por 15s; luego vuelve. (Esc para salir)', page: true, run: terminal },
    clickloco: { nombre: '🖱️ Mouse Loco', tip: 'El clic en las cards no funciona 15s, funciona 15s y no funciona 15s más; después, normal.', page: true, run: clickloco },
    comeletras:{ nombre: '🟡 Come-Letras', tip: 'Pac-Man se come las letras de TU pantalla 😈 (Restaurar = recargar)', page: true, run: comeLetras },
    vidrio:    { nombre: '🪟 Vidrio Roto', tip: 'Cambia el cursor y cada clic quiebra el vidrio (con sonido). 10 veces y vuelve a la normalidad.', page: true, run: vidrio },
    escapistas:{ nombre: '🃏 Módulos Escurridizos', tip: 'El módulo no responde al 1er clic; al 2º se escapa y cambia de lugar. Escala y a 1 min vuelve a la normalidad.', page: true, run: escapistas },
    snake:     { nombre: '🐍 Culebra Cobradora', tip: 'Flechas para mover · come las cuotas 💵', run: snake },
    runner:    { nombre: '🦆 Pato Run',          tip: 'Espacio o clic para saltar los morosos', run: runner },
    breakout:  { nombre: '🧱 Rompe-Mora',        tip: 'Mueve el mouse · rompe toda la mora', run: breakout },
    topo:      { nombre: '🔨 Aplasta al Moroso', tip: 'Clic sobre el moroso antes que se esconda · 30s', run: topo },
    catapulta: { nombre: '🐦 Catapulta de Cobranza', tip: 'Arrastra hacia atrás y suelta · tumba la torre de deudas', run: catapulta },
  };

  function lanzar(id, mensaje) {
    cerrar();
    const g = GAMES[id] || GAMES.snake;
    if (g.page) { current = g.run(mensaje) || {}; return; }   // juego intrusivo (sobre la página real)
    const cv = shell(g.nombre, mensaje || '¡Break sorpresa del jefe! 🎉', g.tip);
    const ctx = cv.getContext('2d');
    current = g.run(cv, ctx, setScore) || {};
  }

  window.AF_JUEGOS = {
    lanzar, cerrar,
    lista: () => Object.keys(GAMES).map(id => ({ id, nombre: GAMES[id].nombre, tip: GAMES[id].tip, page: !!GAMES[id].page })),
  };
})();
