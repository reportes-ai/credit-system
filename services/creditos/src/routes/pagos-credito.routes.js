const router = require('express').Router();
const ctrl   = require('../controllers/pagos-credito.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

// Específicas antes de la genérica /:id_credito
router.get('/pago/:id_pago',   verifyToken, ctrl.getById);
router.post('/batch',          verifyToken, ctrl.createBatch);
router.delete('/:id_pago',     verifyToken, ctrl.remove);
router.post('/',               verifyToken, ctrl.create);
router.get('/:id_credito',     verifyToken, ctrl.getByCredito);

module.exports = router;
