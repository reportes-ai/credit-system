/* Datos de la Empresa en el frontend — fuente única (Mantenedores → Datos de la Empresa).
   Uso: AF_EMPRESA.then(e => ...)  →  { razon_social, nombre, rut, rut_formateado, domicilio, ciudad, representante, ... }
   Caché por sesión (sessionStorage) para no golpear la API en cada impresión. v1.0 */
(function () {
  const K = 'af_empresa_v1';
  let p = null;
  window.AF_EMPRESA = new Promise(res => {
    try { const c = sessionStorage.getItem(K); if (c) { const o = JSON.parse(c); if (o && o.rut && Date.now() - (o._t || 0) < 10 * 60000) return res(o); } } catch (_) {}
    const token = sessionStorage.getItem('token');
    fetch('/api/empresa', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json()).then(j => {
      const d = j && j.success && j.data ? j.data : {};
      d._t = Date.now();
      try { sessionStorage.setItem(K, JSON.stringify(d)); } catch (_) {}
      res(d);
    }).catch(() => res({}));
  });
})();
