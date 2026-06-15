const router = require('express').Router();
const ctrl = require('../controllers/vehiculos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',          verifyToken, ctrl.getVehiculos);
router.get('/filtros',   verifyToken, ctrl.getFiltros);
router.get('/cascada',   verifyToken, ctrl.getCascada);
router.post('/importar', verifyToken, requireFunc('mantenedores_vehiculos'), ctrl.importar);
router.post('/',         verifyToken, requireFunc('mantenedores_vehiculos'), ctrl.createVehiculo);
router.put('/:id',       verifyToken, requireFunc('mantenedores_vehiculos'), ctrl.updateVehiculo);
router.delete('/:id',    verifyToken, requireFunc('mantenedores_vehiculos'), ctrl.deleteVehiculo);

module.exports = router;
