/* ── MOTOR ÚNICO: bancos de Chile (lista oficial definida por Pato 27-08-2026) ──
   Una sola fuente para todo selector/datalist de bancos (fichas de dealer, etc.)
   y para normalizar lo escrito o lo legado ("CHILE" → "BANCO DE CHILE").
   Isomorfo: window.AF_BANCOS / AF_BANCO_CANON en el navegador, module.exports en Node.
   BANCO SECURITY y MERCADO PAGO se mantienen porque hay dealers con cuentas ahí. */
(function () {
  const BANCOS = [
    'BANCO DE CHILE',
    'BANCO EDWARDS',
    'BANCO INTERNACIONAL',
    'SCOTIABANK',
    'BANCO DESARROLLO',
    'BANCO DE CREDITO E INVERSIONES',
    'BANCO BICE',
    'HSBC BANK',
    'BANCO SANTANDER',
    'BANCO ITAÚ',
    'BANCO FALABELLA',
    'BANCO RIPLEY',
    'BANCO CONSORCIO',
    'TENPO BANK CHILE',
    'BANCO ESTADO',
    'BANCO SECURITY',
    'MERCADO PAGO',
  ];
  // Sinónimos y nombres legados → nombre oficial (BBVA y Corpbanca por fusión)
  const ALIAS = {
    'chile': 'BANCO DE CHILE', 'de chile': 'BANCO DE CHILE', 'banco de chile': 'BANCO DE CHILE',
    'edwards': 'BANCO EDWARDS',
    'internacional': 'BANCO INTERNACIONAL',
    'scotiabank': 'SCOTIABANK', 'bbva': 'SCOTIABANK',
    'desarrollo': 'BANCO DESARROLLO', 'banco del desarrollo': 'BANCO DESARROLLO',
    'bci': 'BANCO DE CREDITO E INVERSIONES', 'banco bci': 'BANCO DE CREDITO E INVERSIONES',
    'bice': 'BANCO BICE',
    'hsbc': 'HSBC BANK',
    'santander': 'BANCO SANTANDER',
    'itau': 'BANCO ITAÚ', 'corpbanca': 'BANCO ITAÚ',
    'falabella': 'BANCO FALABELLA',
    'ripley': 'BANCO RIPLEY',
    'consorcio': 'BANCO CONSORCIO',
    'tenpo': 'TENPO BANK CHILE',
    'estado': 'BANCO ESTADO', 'bancoestado': 'BANCO ESTADO', 'estado-vista': 'BANCO ESTADO',
    'security': 'BANCO SECURITY',
    'mercadopago': 'MERCADO PAGO',
  };
  const norm = v => String(v || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Devuelve el nombre oficial, o null si lo escrito no calza con ningún banco.
  function canon(v) {
    const n = norm(v);
    if (!n) return null;
    const ex = BANCOS.find(b => norm(b) === n);
    if (ex) return ex;
    if (ALIAS[n]) return ALIAS[n];
    const sub = BANCOS.filter(b => norm(b).includes(n));
    return sub.length === 1 ? sub[0] : null;
  }
  const api = { BANCOS, ALIAS, canon };
  if (typeof window !== 'undefined') { window.AF_BANCOS = BANCOS; window.AF_BANCO_CANON = canon; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
