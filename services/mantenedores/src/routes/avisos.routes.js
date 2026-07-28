const router = require('express').Router();
const ctrl = require('../controllers/avisos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const FUNC = 'mant_avisos';

router.get('/',          verifyToken, requireFunc(FUNC), ctrl.getTodos);
router.put('/:evento',   verifyToken, requireFunc(FUNC), ctrl.guardar);

module.exports = router;
