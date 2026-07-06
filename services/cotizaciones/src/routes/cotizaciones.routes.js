const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const { create, getAll, getByRut } = require('../controllers/cotizaciones.controller');

router.use(verifyToken);
// Simulador rápido (motor único shared/cotizador.js) — cualquier usuario autenticado
router.get('/simulador-rapido', async (req, res) => {
  try {
    const { simuladorRapido } = require('../../../../shared/cotizador');
    const data = await simuladorRapido(req.query.monto);
    if (!data) return res.status(400).json({ success: false, data: null, error: 'Monto inválido (entre $1.000.000 y $300.000.000)' });
    res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[cotizaciones] simulador-rapido:', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al simular' });
  }
});
router.post('/',           requireFunc('cotizaciones.crear'), create);
router.get('/',            getAll);
router.get('/rut/:rut',    getByRut);

module.exports = router;
