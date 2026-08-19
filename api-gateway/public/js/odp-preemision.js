/* ─────────────────────────────────────────────────────────────────────────────
   PRE-EMISIÓN DE ÓRDENES DE PAGO — motor único del recuadro de avisos.

   Regla (Pato, 19-08-2026): antes de emitir CUALQUIER ODP debe mostrarse un
   popup con la orden y hacer notar los datos que faltan. Cada punto de emisión
   arma su lista de faltas con `check()` y pinta el recuadro con `render()`.
   Las faltas NO bloquean (salvo que el punto de emisión decida bloquear):
   avisan, y el usuario confirma con conocimiento.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* check(campos) → lista de faltas. `campos` = [{ etiqueta, valor, critico }]
     Un valor se considera faltante si es null/undefined/''/0 inválido. */
  function check(campos) {
    const faltas = [];
    for (const c of campos || []) {
      const v = c.valor;
      const vacio = v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '—';
      if (vacio) faltas.push({ etiqueta: c.etiqueta, critico: !!c.critico });
    }
    return faltas;
  }

  /* render(faltas) → HTML del recuadro (verde si no falta nada). */
  function render(faltas) {
    if (!faltas || !faltas.length)
      return '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:9px 14px;font-size:.83rem;color:#166534;margin-bottom:12px"><b>✓ Datos completos</b> — la orden está lista para emitirse.</div>';
    const items = faltas.map(f =>
      `<li${f.critico ? ' style="font-weight:800"' : ''}>${f.etiqueta}${f.critico ? ' <span style="font-size:.7rem;background:#dc2626;color:#fff;border-radius:6px;padding:1px 6px">CRÍTICO</span>' : ''}</li>`).join('');
    return `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:9px;padding:9px 14px;font-size:.83rem;color:#92400e;margin-bottom:12px">
      <b>⚠ Antes de emitir, revisa — falta${faltas.length === 1 ? '' : 'n'}:</b>
      <ul style="margin:4px 0 0;padding-left:20px">${items}</ul>
    </div>`;
  }

  window.AF_ODP_PRE = { check, render };
})();
