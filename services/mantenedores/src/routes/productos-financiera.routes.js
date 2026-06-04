const router     = require('express').Router();
const verifyToken = require('../../../../shared/middleware/auth');
const ctrl        = require('../controllers/productos-financiera.controller');

router.get('/',     verifyToken, ctrl.getAll);
router.post('/',    verifyToken, ctrl.create);
router.put('/:id',  verifyToken, ctrl.update);
router.delete('/:id', verifyToken, ctrl.remove);

module.exports = router;
