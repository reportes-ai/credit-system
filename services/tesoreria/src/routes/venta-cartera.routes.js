'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/venta-cartera.controller');

router.get('/elegibles',  verifyToken, requireFunc('venta_cartera'), ctrl.elegibles);
router.post('/vender',    verifyToken, requireFunc('venta_cartera'), ctrl.vender);
router.delete('/:id',     verifyToken, requireFunc('venta_cartera'), ctrl.deshacer);
router.get('/stock',      verifyToken, requireFunc('venta_cartera'), ctrl.stock);
router.get('/cuotas-mes', verifyToken, requireFunc('venta_cartera'), ctrl.cuotasMes);

module.exports = router;
