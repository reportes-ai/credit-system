const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/parametros.controller');

router.get('/',  verifyToken, ctrl.getAll);
router.put('/',  verifyToken, requireFunc('mantenedores_parametros'), ctrl.updateAll);

module.exports = router;
