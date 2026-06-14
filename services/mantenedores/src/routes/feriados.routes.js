const router = require('express').Router();
const ctrl = require('../controllers/feriados.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',          verifyToken, ctrl.getAll);
router.post('/cargar',   verifyToken, requireFunc('mantenedores_feriados'), ctrl.cargarAuto);
router.post('/',         verifyToken, requireFunc('mantenedores_feriados'), ctrl.crear);
router.delete('/:fecha', verifyToken, requireFunc('mantenedores_feriados'), ctrl.eliminar);

module.exports = router;
