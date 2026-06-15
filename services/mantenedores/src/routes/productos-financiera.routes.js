const router     = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl        = require('../controllers/productos-financiera.controller');

router.get('/',     verifyToken, ctrl.getAll);
router.post('/',    verifyToken, requireFunc('mant_productos_financiera'), ctrl.create);
router.put('/:id',  verifyToken, requireFunc('mant_productos_financiera'), ctrl.update);
router.delete('/:id', verifyToken, requireFunc('mant_productos_financiera'), ctrl.remove);

module.exports = router;
