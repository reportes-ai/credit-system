'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/dealer-categorias.controller');

router.get('/',                verifyToken, ctrl.listar);
router.get('/movimientos',     verifyToken, ctrl.movimientos);
router.get('/por-inactivar',   verifyToken, ctrl.porInactivar);
router.put('/asignar/:idDealer', verifyToken, requireFunc('mantenedores_dealers', 'dealer_mantener'), ctrl.asignar);
router.put('/activo/:idDealer',  verifyToken, requireFunc('mantenedores_dealers', 'dealer_mantener'), ctrl.setActivo);
router.post('/recalcular',     verifyToken, requireFunc('mantenedores_dealers', 'dealer_mantener'), ctrl.recalcular);
router.put('/:id',             verifyToken, requireFunc('mant_dealer_categorias'), ctrl.actualizar);

module.exports = router;
