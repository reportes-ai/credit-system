const router = require('express').Router();
const ctrl = require('../controllers/vehiculos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/',          verifyToken, ctrl.getVehiculos);
router.get('/filtros',   verifyToken, ctrl.getFiltros);
router.post('/importar', verifyToken, ctrl.importar);
router.post('/',         verifyToken, ctrl.createVehiculo);
router.put('/:id',       verifyToken, ctrl.updateVehiculo);
router.delete('/:id',    verifyToken, ctrl.deleteVehiculo);

module.exports = router;
