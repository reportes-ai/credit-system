const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/parametros.controller');

router.get('/',  verifyToken, ctrl.getAll);
router.put('/',  verifyToken, ctrl.updateAll);

module.exports = router;
