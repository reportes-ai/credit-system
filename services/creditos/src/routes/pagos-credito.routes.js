const router = require('express').Router();
const ctrl   = require('../controllers/pagos-credito.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Específicas antes de la genérica /:id_credito
router.get('/pago/:id_pago',          verifyToken, ctrl.getById);
router.post('/batch',                 verifyToken, requireFunc('creditos_pagar_cuotas'), ctrl.createBatch);
router.post('/reversar/:id_pago',     verifyToken, requireFunc('creditos_reversar_pagos'), ctrl.reversar);
router.delete('/:id_pago',            verifyToken, requireFunc('creditos_reversar_pagos'), ctrl.remove);
router.post('/',                      verifyToken, requireFunc('creditos_pagar_cuotas'), ctrl.create);
router.get('/:id_credito',            verifyToken, ctrl.getByCredito);

module.exports = router;
