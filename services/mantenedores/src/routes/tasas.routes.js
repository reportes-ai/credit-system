const router = require('express').Router();
const ctrl = require('../controllers/tasas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/vigente', verifyToken, ctrl.getVigente);
router.get('/', verifyToken, ctrl.getAll);
router.get('/:id', verifyToken, ctrl.getById);
router.post('/', verifyToken, ctrl.create);
router.put('/:id', verifyToken, ctrl.update);
router.delete('/:id', verifyToken, ctrl.remove);

module.exports = router;
