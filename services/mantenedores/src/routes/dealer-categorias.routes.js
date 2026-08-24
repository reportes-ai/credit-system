'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/dealer-categorias.controller');

// '/' es el catálogo de categorías (lo consultan otras pantallas) → sin permiso de pestaña.
router.get('/',                verifyToken, ctrl.listar);
// Estos dos son exclusivos de la pestaña Categoría Dealers.
router.get('/movimientos',     verifyToken, requireFunc('dealers_cat_ver', 'dealers_cat_editar'), ctrl.movimientos);
router.get('/por-inactivar',   verifyToken, requireFunc('dealers_cat_ver', 'dealers_cat_editar'), ctrl.porInactivar);
router.put('/asignar/:idDealer', verifyToken, requireFunc('dealers_cat_editar'), ctrl.asignar);
router.put('/activo/:idDealer',  verifyToken, requireFunc('dealers_cat_editar'), ctrl.setActivo);
router.post('/recalcular',     verifyToken, requireFunc('dealers_cat_editar'), ctrl.recalcular);
router.put('/corte-hora',      verifyToken, requireFunc('mant_dealer_categorias'), ctrl.setCorteHora);
router.put('/:id',             verifyToken, requireFunc('mant_dealer_categorias'), ctrl.actualizar);

module.exports = router;
