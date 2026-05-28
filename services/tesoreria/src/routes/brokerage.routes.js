const router = require('express').Router();
const ctrl   = require('../controllers/brokerage.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

// Operaciones (vista tesorería)
router.get('/operaciones',          verifyToken, ctrl.getOperaciones);
router.get('/operaciones/:id',      verifyToken, ctrl.getOperacion);

// Facturas
router.post('/facturas',            verifyToken, ctrl.createFactura);
router.get('/facturas/:id/download',verifyToken, ctrl.downloadFactura);
router.delete('/facturas/:id',      verifyToken, ctrl.deleteFactura);

// Pagos
router.post('/pagos',               verifyToken, ctrl.createPago);
router.put('/pagos/:id/transferencia', verifyToken, ctrl.registrarTransferencia);
router.delete('/pagos/:id',         verifyToken, ctrl.deletePago);

module.exports = router;
