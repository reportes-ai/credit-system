const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const { create, getAll, getByRut, getHtml, enviar } = require('../controllers/cotizaciones.controller');

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
// Listado del módulo: exige la casilla Ver Cotizaciones (auditoría 2026-08-08).
// La búsqueda por RUT y el HTML quedan abiertos: los usa la ficha de Clientes.
router.get('/',            requireFunc('cotizaciones.ver'), getAll);
router.get('/rut/:rut',    getByRut);
router.get('/:id/html',    getHtml);
// Enviar por correo = parte del flujo de cotizar: misma casilla que crear
// (auditoría requireFunc 2026-08-16: antes cualquier autenticado la disparaba).
router.post('/:id/enviar', requireFunc('cotizaciones.crear'), enviar);

module.exports = router;
