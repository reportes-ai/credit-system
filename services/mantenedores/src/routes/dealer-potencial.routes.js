const router = require('express').Router();
const ctrl = require('../controllers/dealer-potencial.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Pestaña Potencial Parque/Dealer: ver y editar se gobiernan por separado.
const VER    = ['dealers_potencial_ver', 'dealers_potencial_editar'];
const EDITAR = ['dealers_potencial_editar'];

router.get('/',        verifyToken, requireFunc(...VER), ctrl.getPotencial);
router.get('/config',  verifyToken, requireFunc(...VER), ctrl.getConfigEndpoint);
router.put('/config',  verifyToken, requireFunc(...EDITAR), ctrl.setConfig);
router.put('/:id',     verifyToken, requireFunc(...EDITAR), ctrl.savePotencialDealer);

module.exports = router;
