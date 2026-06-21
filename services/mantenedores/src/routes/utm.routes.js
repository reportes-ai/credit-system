const router = require('express').Router();
const ctrl = require('../controllers/utm.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/', verifyToken, ctrl.getAll);
router.get('/vigente', verifyToken, ctrl.getVigente);
router.get('/en/:fecha', verifyToken, ctrl.getEnFecha);
router.post('/', verifyToken, requireFunc('mantenedores_uf'), ctrl.create);
router.put('/:id', verifyToken, requireFunc('mantenedores_uf'), ctrl.update);
router.delete('/:id', verifyToken, requireFunc('mantenedores_uf'), ctrl.remove);

module.exports = router;
