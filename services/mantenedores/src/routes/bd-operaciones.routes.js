const router = require('express').Router();
const ctrl   = require('../controllers/bd-operaciones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/columns',  verifyToken, ctrl.getColumns);
router.get('/',         verifyToken, ctrl.getAll);
router.put('/:id',      verifyToken, ctrl.update);

module.exports = router;
