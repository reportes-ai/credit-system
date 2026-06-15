const router = require('express').Router();
const ctrl   = require('../controllers/brokerage.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Operaciones (vista tesorería)
router.get('/operaciones',          verifyToken, requireFunc('tesoreria_brokerage_ver'), ctrl.getOperaciones);
router.get('/operaciones/:id',      verifyToken, requireFunc('tesoreria_brokerage_ver'), ctrl.getOperacion);

// Facturas
router.post('/facturas',            verifyToken, requireFunc('tesoreria_brokerage_facturas'), ctrl.createFactura);
router.get('/facturas/:id/download',verifyToken, requireFunc('tesoreria_brokerage_ver'), ctrl.downloadFactura);
router.delete('/facturas/:id',      verifyToken, requireFunc('tesoreria_brokerage_facturas'), ctrl.deleteFactura);

// Pagos
router.post('/pagos',               verifyToken, requireFunc('tesoreria_brokerage_pagos'), ctrl.createPago);
router.put('/pagos/:id/transferencia', verifyToken, requireFunc('tesoreria_brokerage_pagos'), ctrl.registrarTransferencia);
router.delete('/pagos/:id',         verifyToken, requireFunc('tesoreria_brokerage_pagos'), ctrl.deletePago);

module.exports = router;
