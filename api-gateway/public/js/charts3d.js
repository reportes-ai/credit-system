/* ─────────────────────────────────────────────────────────────────────────
   AF3D — gráficos 3D en SVG puro (sin librerías externas). v1.0
   Motor ÚNICO de gráficos 3D del Suite: lo usan los reportes de Reportería
   (Cartera de Créditos, Cobranza y Mora). Reusar, no duplicar.

   API:
     AF3D.pie(el, data, opts)    → torta 3D   data: [{label, value, color}]
     AF3D.bars(el, data, opts)   → barras 3D  data: [{label, value, color?, value2?}]
     AF3D.hbars(el, data, opts)  → barras 3D horizontales (rankings)
   opts.fmt: función para formatear el valor en etiquetas/tooltip.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const $s = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const nfmt = v => Number(v || 0).toLocaleString('es-CL');

  // Oscurecer/aclarar un color hex
  function shade(hex, f) {
    const m = hex.replace('#', '');
    const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
    const ch = s => Math.max(0, Math.min(255, Math.round(s * f)));
    return '#' + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  const PALETTE = ['#0141A2', '#009AFE', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b', '#a3e635', '#f97316', '#06b6d4'];

  /* ── Torta 3D ─────────────────────────────────────────────────────── */
  function pie(el, data, opts = {}) {
    el.innerHTML = '';
    data = data.filter(d => Number(d.value) > 0);
    if (!data.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:.85rem;text-align:center;padding:30px">Sin datos</div>'; return; }
    const fmt = opts.fmt || nfmt;
    const W = opts.width || 460, H = opts.height || 300;
    const depth = opts.depth || 26;
    const rx = opts.rx || Math.min(W * 0.30, 150), ry = rx * 0.5;
    const cx = W * 0.36, cy = (H - depth) / 2 + 8;
    const total = data.reduce((s, d) => s + Number(d.value), 0);

    const svg = $s('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto;display:block' });
    const pt = t => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];

    // ángulos por segmento (empezando arriba-atrás para que el mayor quede al frente)
    let a = -Math.PI / 2;
    const segs = data.map((d, i) => {
      const ang = (Number(d.value) / total) * Math.PI * 2;
      const s = { ...d, color: d.color || PALETTE[i % PALETTE.length], a0: a, a1: a + ang, pct: (Number(d.value) / total * 100) };
      a += ang;
      return s;
    });

    // paredes laterales: solo los tramos del arco con sin(t)>0 (mitad frontal)
    const walls = [];
    for (const s of segs) {
      // dividir el arco en tramos dentro de [0, π] módulo 2π
      const steps = 64;
      let t0 = null;
      for (let i = 0; i <= steps; i++) {
        const t = s.a0 + (s.a1 - s.a0) * (i / steps);
        const front = Math.sin(t) > 0.0001;
        if (front && t0 === null) t0 = t;
        if ((!front || i === steps) && t0 !== null) {
          const t1 = front ? t : s.a0 + (s.a1 - s.a0) * ((i - 1) / steps);
          if (t1 > t0 + 0.001) walls.push({ t0, t1, color: s.color });
          t0 = null;
        }
      }
    }
    for (const w of walls) {
      const [x0, y0] = pt(w.t0), [x1, y1] = pt(w.t1);
      const large = (w.t1 - w.t0) > Math.PI ? 1 : 0;
      const d = `M ${x0} ${y0} A ${rx} ${ry} 0 ${large} 1 ${x1} ${y1} L ${x1} ${y1 + depth} A ${rx} ${ry} 0 ${large} 0 ${x0} ${y0 + depth} Z`;
      svg.appendChild($s('path', { d, fill: shade(w.color, 0.62) }));
    }

    // tapas (slices)
    for (const s of segs) {
      const [x0, y0] = pt(s.a0), [x1, y1] = pt(s.a1);
      const large = (s.a1 - s.a0) > Math.PI ? 1 : 0;
      const d = (s.a1 - s.a0) >= Math.PI * 2 - 0.001
        ? `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`
        : `M ${cx} ${cy} L ${x0} ${y0} A ${rx} ${ry} 0 ${large} 1 ${x1} ${y1} Z`;
      const p = $s('path', { d, fill: s.color, stroke: '#fff', 'stroke-width': 1 });
      const ti = document.createElementNS(NS, 'title');
      ti.textContent = `${s.label}: ${fmt(s.value)} (${s.pct.toFixed(1)}%)`;
      p.appendChild(ti);
      svg.appendChild(p);
      // % sobre la tapa si el segmento es grande
      if (s.pct >= 6) {
        const tm = (s.a0 + s.a1) / 2;
        const lx = cx + rx * 0.62 * Math.cos(tm), ly = cy + ry * 0.62 * Math.sin(tm);
        const tx = $s('text', { x: lx, y: ly, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#fff', style: 'pointer-events:none' });
        tx.textContent = s.pct.toFixed(0) + '%';
        svg.appendChild(tx);
      }
    }

    // leyenda a la derecha
    const lx = W * 0.68;
    segs.forEach((s, i) => {
      const y = 26 + i * 22;
      if (y > H - 8) return;
      svg.appendChild($s('rect', { x: lx, y: y - 10, width: 12, height: 12, rx: 3, fill: s.color }));
      const t1 = $s('text', { x: lx + 18, y, 'font-size': 11.5, fill: '#334155', 'font-weight': 600 });
      t1.textContent = s.label.length > 20 ? s.label.slice(0, 19) + '…' : s.label;
      const t2 = $s('text', { x: lx + 18, y: y + 11, 'font-size': 10, fill: '#94a3b8' });
      t2.textContent = `${fmt(s.value)} · ${s.pct.toFixed(1)}%`;
      svg.appendChild(t1); svg.appendChild(t2);
    });

    el.appendChild(svg);
  }

  /* ── Barras 3D verticales ─────────────────────────────────────────── */
  function bars(el, data, opts = {}) {
    el.innerHTML = '';
    if (!data.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:.85rem;text-align:center;padding:30px">Sin datos</div>'; return; }
    const fmt = opts.fmt || nfmt;
    const W = opts.width || 560, H = opts.height || 300;
    const dx = 12, dy = 7;                       // profundidad 3D
    const padL = 14, padR = 20, padT = 30, padB = 44;
    const max = Math.max(...data.map(d => Number(d.value))) || 1;
    const cw = (W - padL - padR - dx) / data.length;
    const bw = Math.min(cw * 0.62, 64);
    const baseY = H - padB;

    const svg = $s('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto;display:block' });

    // líneas guía
    for (let g = 1; g <= 4; g++) {
      const y = baseY - (baseY - padT) * (g / 4);
      svg.appendChild($s('line', { x1: padL, y1: y, x2: W - padR, y2: y, stroke: '#eef2f7', 'stroke-width': 1 }));
    }
    svg.appendChild($s('line', { x1: padL, y1: baseY, x2: W - padR, y2: baseY, stroke: '#cbd5e1', 'stroke-width': 1.5 }));

    data.forEach((d, i) => {
      const color = d.color || PALETTE[i % PALETTE.length];
      const h = Math.max(2, (Number(d.value) / max) * (baseY - padT));
      const x = padL + i * cw + (cw - bw) / 2;
      const y = baseY - h;
      const g = $s('g', {});
      // cara lateral derecha
      g.appendChild($s('path', { d: `M ${x + bw} ${y} L ${x + bw + dx} ${y - dy} L ${x + bw + dx} ${baseY - dy} L ${x + bw} ${baseY} Z`, fill: shade(color, 0.66) }));
      // tapa superior
      g.appendChild($s('path', { d: `M ${x} ${y} L ${x + dx} ${y - dy} L ${x + bw + dx} ${y - dy} L ${x + bw} ${y} Z`, fill: shade(color, 1.28) }));
      // cara frontal
      g.appendChild($s('rect', { x, y, width: bw, height: h, fill: color, rx: 1.5 }));
      const ti = document.createElementNS(NS, 'title');
      ti.textContent = `${d.label}: ${fmt(d.value)}`;
      g.appendChild(ti);
      svg.appendChild(g);
      // valor arriba
      const tv = $s('text', { x: x + bw / 2 + dx / 2, y: y - dy - 5, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: '#334155' });
      tv.textContent = opts.short ? shortNum(d.value) : fmt(d.value);
      svg.appendChild(tv);
      // etiqueta abajo
      const tl = $s('text', { x: x + bw / 2, y: baseY + 15, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#64748b', 'font-weight': 600 });
      tl.textContent = d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label;
      svg.appendChild(tl);
      if (d.sub) {
        const ts = $s('text', { x: x + bw / 2, y: baseY + 28, 'text-anchor': 'middle', 'font-size': 9.5, fill: '#94a3b8' });
        ts.textContent = d.sub;
        svg.appendChild(ts);
      }
    });
    el.appendChild(svg);
  }

  /* ── Barras 3D horizontales (rankings) ────────────────────────────── */
  function hbars(el, data, opts = {}) {
    el.innerHTML = '';
    if (!data.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:.85rem;text-align:center;padding:30px">Sin datos</div>'; return; }
    const fmt = opts.fmt || nfmt;
    const rowH = 34, dx = 9, dy = 5;
    const W = opts.width || 560, labelW = opts.labelW || 150;
    const H = data.length * rowH + 24;
    const max = Math.max(...data.map(d => Number(d.value))) || 1;
    const bx = labelW + 6, bmaxw = W - bx - 92;

    const svg = $s('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto;display:block' });
    data.forEach((d, i) => {
      const color = d.color || PALETTE[i % PALETTE.length];
      const y = 12 + i * rowH;
      const w = Math.max(3, (Number(d.value) / max) * bmaxw);
      const bh = 18;
      const tl = $s('text', { x: labelW, y: y + bh / 2 + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#334155', 'font-weight': 600 });
      tl.textContent = d.label.length > 22 ? d.label.slice(0, 21) + '…' : d.label;
      svg.appendChild(tl);
      const g = $s('g', {});
      g.appendChild($s('path', { d: `M ${bx} ${y} L ${bx + dx} ${y - dy} L ${bx + w + dx} ${y - dy} L ${bx + w} ${y} Z`, fill: shade(color, 1.28) }));
      g.appendChild($s('path', { d: `M ${bx + w} ${y} L ${bx + w + dx} ${y - dy} L ${bx + w + dx} ${y + bh - dy} L ${bx + w} ${y + bh} Z`, fill: shade(color, 0.66) }));
      g.appendChild($s('rect', { x: bx, y, width: w, height: bh, fill: color, rx: 2 }));
      const ti = document.createElementNS(NS, 'title');
      ti.textContent = `${d.label}: ${fmt(d.value)}${d.sub ? ' · ' + d.sub : ''}`;
      g.appendChild(ti);
      svg.appendChild(g);
      const tv = $s('text', { x: bx + w + dx + 6, y: y + bh / 2 + 4, 'font-size': 10.5, 'font-weight': 700, fill: '#334155' });
      tv.textContent = opts.short ? shortNum(d.value) : fmt(d.value);
      svg.appendChild(tv);
    });
    el.appendChild(svg);
  }

  /* ── Líneas (conversión por día, comparación de series) ───────────── */
  function line(el, series, opts = {}) {
    el.innerHTML = '';
    series = (series || []).filter(s => s.points && s.points.length);
    if (!series.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:.85rem;text-align:center;padding:30px">Sin datos</div>'; return; }
    const fmt = opts.fmt || (v => String(v));
    const W = opts.width || 720, H = opts.height || 280;
    const padL = 46, padR = 16, padT = 18, padB = 34;
    const xs = series.flatMap(s => s.points.map(p => p.x));
    const ys = series.flatMap(s => s.points.map(p => p.y));
    const xMin = Math.min(...xs), xMax = Math.max(...xs, xMin + 1);
    const yMax = Math.max(...ys, 1) * 1.12;
    const X = x => padL + (x - xMin) / (xMax - xMin) * (W - padL - padR);
    const Y = y => H - padB - (y / yMax) * (H - padT - padB);
    const svg = $s('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto;display:block' });
    for (let g = 0; g <= 4; g++) {
      const yv = yMax * g / 4, y = Y(yv);
      svg.appendChild($s('line', { x1: padL, y1: y, x2: W - padR, y2: y, stroke: g ? '#eef2f7' : '#cbd5e1', 'stroke-width': g ? 1 : 1.5 }));
      const t = $s('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 9.5, fill: '#94a3b8' });
      t.textContent = fmt(Math.round(yv * 10) / 10);
      svg.appendChild(t);
    }
    for (let x = Math.ceil(xMin); x <= xMax; x += Math.max(1, Math.ceil((xMax - xMin) / 12))) {
      const t = $s('text', { x: X(x), y: H - padB + 16, 'text-anchor': 'middle', 'font-size': 9.5, fill: '#94a3b8' });
      t.textContent = (opts.xPrefix || '') + x;
      svg.appendChild(t);
    }
    series.forEach((s, i) => {
      const color = s.color || PALETTE[i % PALETTE.length];
      const pts = [...s.points].sort((a, b) => a.x - b.x);
      const d = pts.map((p, j) => `${j ? 'L' : 'M'} ${X(p.x)} ${Y(p.y)}`).join(' ');
      if (opts.area !== false) {
        svg.appendChild($s('path', { d: `${d} L ${X(pts[pts.length - 1].x)} ${Y(0)} L ${X(pts[0].x)} ${Y(0)} Z`, fill: color, opacity: 0.08 }));
      }
      svg.appendChild($s('path', { d, fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      for (const p of pts) {
        const c = $s('circle', { cx: X(p.x), cy: Y(p.y), r: 3.6, fill: '#fff', stroke: color, 'stroke-width': 2.5 });
        const ti = document.createElementNS(NS, 'title');
        ti.textContent = `${s.label} · ${(opts.xPrefix || 'día ')}${p.x}: ${fmt(p.y)}`;
        c.appendChild(ti);
        svg.appendChild(c);
      }
      // leyenda
      const ly = padT + i * 16;
      svg.appendChild($s('rect', { x: W - padR - 130, y: ly - 8, width: 10, height: 10, rx: 2, fill: color }));
      const tl = $s('text', { x: W - padR - 116, y: ly + 1, 'font-size': 10.5, fill: '#334155', 'font-weight': 600 });
      tl.textContent = s.label;
      svg.appendChild(tl);
    });
    el.appendChild(svg);
  }

  function shortNum(v) {
    v = Number(v || 0);
    if (Math.abs(v) >= 1e9) return (v / 1e9).toLocaleString('es-CL', { maximumFractionDigits: 1 }) + 'MM';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString('es-CL', { maximumFractionDigits: 1 }) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toLocaleString('es-CL', { maximumFractionDigits: 0 }) + 'k';
    return nfmt(v);
  }

  window.AF3D = { pie, bars, hbars, line, shortNum, PALETTE };
})();
