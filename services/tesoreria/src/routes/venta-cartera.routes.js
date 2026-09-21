'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/venta-cartera.controller');

// Compradores y contratos de cesión (mismo permiso, misma card)
const ces = require('../controllers/cesion-cartera.controller');
router.get('/compradores',        verifyToken, requireFunc('venta_cartera'), ces.compradores);
router.post('/compradores',       verifyToken, requireFunc('venta_cartera'), ces.guardarComprador);
router.get('/contratos/textos',   verifyToken, requireFunc('venta_cartera'), ces.textos);
router.put('/contratos/textos/:tipo', verifyToken, requireFunc('venta_cartera'), ces.guardarTexto);
router.get('/contratos/grupos',   verifyToken, requireFunc('venta_cartera'), ces.grupos);
router.get('/contratos/generar',  verifyToken, requireFunc('venta_cartera'), ces.contrato);
router.get('/parametros', verifyToken, requireFunc('venta_cartera'), ctrl.getParametros);
router.put('/parametros', verifyToken, requireFunc('venta_cartera'), ctrl.putParametros);
router.get('/elegibles',  verifyToken, requireFunc('venta_cartera'), ctrl.elegibles);
router.post('/vender',    verifyToken, requireFunc('venta_cartera'), ctrl.vender);
router.post('/:id/cobrar', verifyToken, requireFunc('venta_cartera'), ctrl.cobrar);   // ingreso de fondos del comprador
router.delete('/:id',     verifyToken, requireFunc('venta_cartera'), ctrl.deshacer);
router.get('/stock',      verifyToken, requireFunc('venta_cartera'), ctrl.stock);
router.get('/cuotas-mes', verifyToken, requireFunc('venta_cartera'), ctrl.cuotasMes);

module.exports = router;
