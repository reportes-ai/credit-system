/* ─────────────────────────────────────────────────────────────────────────
   AF_REP_IA — Reporte IA (Anthropic) reutilizable. UN solo formato para TODAS
   las pantallas (revisión de fichas, Base Dealer, etc.). Lee el análisis de
   ia_informes_dealernet por RUT (GET /api/ia/informe-dealernet/por-rut/:rut).

   Uso:
     AF_REP_IA.abrirRut('76.598.828-4', 'AUTOS OK');            // un RUT
     AF_REP_IA.abrir([{tag:'Empresa', nombre:'X', rut:'...'},   // empresa + socios
                      {tag:'Socio 1', nombre:'Y', rut:'...'}]);
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  const H = () => ({ Authorization: 'Bearer ' + (sessionStorage.getItem('token') || '') });
  const E = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const RIESGO = { BAJO: { c: '#166534', b: '#dcfce7' }, MEDIO: { c: '#92400e', b: '#fef9c3' }, ALTO: { c: '#991b1b', b: '#fee2e2' } };

  // Render de una sección (una entidad). ent: {tag, nombre, rut}; d: fila ia_informes_dealernet o null.
  function seccionHTML(ent, d) {
    const head = `<div style="font-weight:800;color:#0f172a;margin-bottom:8px"><i class="bi bi-${ent.tag === 'Empresa' ? 'building' : 'person'} me-1"></i>${E(ent.tag || '')} · ${E(ent.nombre || '')} <span style="color:#94a3b8;font-weight:600">${E(ent.rut || '')}</span></div>`;
    if (!d) return head + `<div style="color:#94a3b8">Sin reporte IA para este RUT (aún no analizado, o la IA estaba desactivada al enviar).
      <div style="margin-top:8px"><button onclick="AF_REP_IA.analizar('${E(ent.rut)}', this)" style="background:#c2410c;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:.8rem;font-weight:700;cursor:pointer"><i class="bi bi-stars me-1"></i>Analizar ahora con IA</button></div></div>`;
    const rg = RIESGO[String(d.nivel_riesgo || '').toUpperCase()] || { c: '#475569', b: '#f1f5f9' };
    const fecha = d.fecha ? new Date(d.fecha).toLocaleString('es-CL') : '—';
    const lst = (a, vac) => (a && a.length) ? '<ul style="margin:3px 0 0;padding-left:18px">' + a.map(x => `<li>${E(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('') + '</ul>' : `<span style="color:#94a3b8">${vac}</span>`;
    const causas = (d.causas || []).map(c => `<li><b>${E(c.tipo || '')}</b> · ${E(c.materia || c.caratula || '')}${c.fecha ? ' · ' + E(c.fecha) : ''}${c.demandante ? ' · ' + E(c.demandante) : ''}${c.tribunal ? ' · ' + E(c.tribunal) : ''}</li>`).join('');
    return head + `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <span style="font-size:.72rem;font-weight:800;color:${rg.c};background:${rg.b};border-radius:8px;padding:3px 10px">RIESGO ${E(d.nivel_riesgo || '—')}</span>
        <span style="font-size:.78rem;color:#64748b"><i class="bi bi-clock-history"></i> ${E(fecha)}</span></div>
      <div style="margin-bottom:7px;font-size:.85rem"><b>Resumen:</b> ${E(d.resumen || '—')}</div>
      <div style="margin-bottom:7px;font-size:.85rem"><b>Deudas/morosidades:</b> ${E(d.deudas || '—')}</div>
      <div style="margin-bottom:7px;font-size:.85rem"><b>Causas judiciales:</b>${causas ? `<ul style="margin:3px 0 0;padding-left:18px;color:#991b1b">${causas}</ul>` : ' <span style="color:#94a3b8">sin causas</span>'}</div>
      <div style="margin-bottom:7px;font-size:.85rem"><b style="color:#991b1b">Alertas:</b> ${lst(d.alertas, 'sin alertas')}</div>
      <div style="margin-bottom:7px;font-size:.85rem"><b style="color:#166534">Factores positivos:</b> ${lst(d.factores, '—')}</div>
      <div style="font-size:.85rem"><b>Recomendación:</b> ${E(d.recomendacion || '—')}</div>`;
  }

  async function fetchRut(rut) {
    try { const r = await fetch('/api/ia/informe-dealernet/por-rut/' + encodeURIComponent(rut), { headers: H() }); const j = await r.json(); return j.success ? j.data : null; }
    catch (_) { return null; }
  }

  // Abre el modal (<dialog>, top-layer → queda sobre cualquier otro modal) con 1+ entidades.
  // opts: { subtitulo, onClose } — opcional (lo usa el ejecutivo al enviar la ficha).
  async function abrir(entidades, opts) {
    opts = opts || {};
    const ents = Array.isArray(entidades) ? entidades : [entidades];
    let dlg = document.getElementById('dlgRepIA');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dlgRepIA'; dlg.style.cssText = 'border:none;border-radius:14px;max-width:640px;width:92%;padding:0;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.3)'; document.body.appendChild(dlg); }
    const sub = opts.subtitulo ? `<div style="font-size:.8rem;opacity:.92;margin-top:2px">${E(opts.subtitulo)}</div>` : '';
    dlg.innerHTML = `<div style="padding:16px 20px;background:linear-gradient(135deg,#9a3412,#c2410c);color:#fff;display:flex;align-items:center;gap:10px;position:sticky;top:0">
        <i class="bi bi-stars" style="font-size:1.2rem"></i>
        <div style="flex:1"><h3 style="margin:0;font-size:1.02rem">Reporte IA — Anthropic</h3>${sub}</div>
        <button onclick="document.getElementById('dlgRepIA').close()" style="background:rgba(255,255,255,.2);border:none;color:#fff;width:30px;height:30px;border-radius:8px;cursor:pointer">✕</button></div>
      <div id="repIAall" style="padding:16px 20px;max-height:72vh;overflow:auto"><div style="text-align:center;color:#94a3b8;padding:20px">Cargando…</div></div>`;
    if (typeof opts.onClose === 'function') dlg.addEventListener('close', opts.onClose, { once: true });
    if (typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch (_) { dlg.setAttribute('open', ''); } }
    const cont = dlg.querySelector('#repIAall');
    const valid = ents.filter(e => e && e.rut);
    if (!valid.length) { cont.innerHTML = '<div style="color:#94a3b8">Sin entidades con RUT.</div>'; return; }
    const secs = [];
    for (const e of valid) {
      const d = await fetchRut(e.rut);
      secs.push(`<div data-repia-rut="${E(e.rut)}" data-ent='${E(JSON.stringify({ tag: e.tag, nombre: e.nombre, rut: e.rut })).replace(/'/g, "&#39;")}'>${seccionHTML(e, d)}</div>`);
    }
    cont.innerHTML = secs.join('<hr style="border:none;border-top:1px solid #eef2f7;margin:18px 0">');
  }

  // Atajo por RUT único (Base Dealer, etc.).
  function abrirRut(rut, nombre) { return abrir([{ tag: 'Empresa', nombre, rut }]); }

  // Analiza el RUT a demanda (POST /api/ia/informe-dealernet) y refresca la sección.
  // Cubre los casos en que el análisis al enviar la ficha falló (timeout DealerNet, IA off).
  async function analizar(rut, btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Analizando…'; }
    try {
      const r = await fetch('/api/ia/informe-dealernet', { method: 'POST',
        headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify({ rut }) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'No se pudo analizar');
      // Re-render de la sección con el reporte fresco
      const d = await fetchRut(rut);
      const sec = btn && btn.closest('div[data-repia-rut]');
      if (sec && d) sec.innerHTML = seccionHTML(JSON.parse(sec.dataset.ent || '{}'), d);
      else if (d && btn) { btn.parentElement.parentElement.outerHTML = seccionHTML({ tag: '', nombre: '', rut }, d); }
    } catch (e) {
      alert('No se pudo analizar: ' + e.message);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-stars me-1"></i>Analizar ahora con IA'; }
    }
  }

  window.AF_REP_IA = { abrir, abrirRut, seccionHTML, analizar };
})();
