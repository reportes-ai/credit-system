const router = require('express').Router();
const ctrl   = require('../controllers/bd-operaciones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const F = 'mantenedores_bd_operaciones', GOD = 'mantenedores_solo_dios';

router.get('/columns',  verifyToken, requireFunc(F, GOD), ctrl.getColumns);
router.get('/',         verifyToken, requireFunc(F, GOD), ctrl.getAll);
router.put('/:id',      verifyToken, requireFunc(F, GOD), ctrl.update);     // analista: modificar (solo meses abiertos)
router.delete('/',      verifyToken, requireFunc(GOD), ctrl.deleteMany);    // eliminar: solo nivel Dios

module.exports = router;
