const router = require('express').Router();
const ctrl = require('../controllers/parques.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const puedeGestionar = requireFunc('mantenedores_parques');

router.get('/',       verifyToken, ctrl.getAll);
router.post('/',      verifyToken, puedeGestionar, ctrl.create);
router.put('/:id',    verifyToken, puedeGestionar, ctrl.update);
router.delete('/:id', verifyToken, puedeGestionar, ctrl.remove);

module.exports = router;
