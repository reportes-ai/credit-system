const router = require('express').Router();
const ctrl   = require('../controllers/operaciones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/next-op', verifyToken, ctrl.nextOp);   // MUST be before /:id
router.get('/',        verifyToken, ctrl.getAll);
router.get('/:id',     verifyToken, ctrl.getOne);
router.post('/',     verifyToken, ctrl.create);
router.put('/:id',   verifyToken, ctrl.update);
router.delete('/:id',verifyToken, ctrl.remove);

module.exports = router;
