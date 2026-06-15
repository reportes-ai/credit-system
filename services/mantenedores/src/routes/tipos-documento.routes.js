const router  = require('express').Router();
const ctrl    = require('../controllers/tipos-documento.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/activos', verifyToken, ctrl.getActivos);
router.get('/',        verifyToken, ctrl.getAll);
router.post('/',       verifyToken, requireFunc('mantenedores_tipos_doc'), ctrl.create);
router.put('/:id',     verifyToken, requireFunc('mantenedores_tipos_doc'), ctrl.update);
router.delete('/:id',  verifyToken, requireFunc('mantenedores_tipos_doc'), ctrl.remove);

module.exports = router;
