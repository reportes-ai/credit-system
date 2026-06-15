const router = require('express').Router();
const ctrl = require('../controllers/tasas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/vigente', verifyToken, ctrl.getVigente);
router.get('/en/:fecha', verifyToken, ctrl.getEnFecha);
router.get('/', verifyToken, ctrl.getAll);
router.get('/:id', verifyToken, ctrl.getById);
router.post('/', verifyToken, requireFunc('mantenedores_tasas'), ctrl.create);
router.put('/:id', verifyToken, requireFunc('mantenedores_tasas'), ctrl.update);
router.delete('/:id', verifyToken, requireFunc('mantenedores_tasas'), ctrl.remove);

module.exports = router;
