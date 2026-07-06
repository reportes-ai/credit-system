const router = require('express').Router();
const ctrl = require('../controllers/comisiones-seguro.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const FUNC = 'mantenedores_comisiones_seguro';

router.get('/pct-mes',         verifyToken,                    ctrl.getPctMes);
router.post('/pct-mes',        verifyToken, requireFunc(FUNC), ctrl.setPctMes);
router.get('/',                verifyToken,                    ctrl.getAll);
router.put('/:id',             verifyToken, requireFunc(FUNC), ctrl.update);
router.get('/penetracion',     verifyToken,                    ctrl.getAllPen);
router.put('/penetracion/:id', verifyToken, requireFunc(FUNC), ctrl.updatePen);

module.exports = router;
