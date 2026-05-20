const router = require('express').Router();
const ctrl   = require('../controllers/credito-documentos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/:id_credito',        verifyToken, ctrl.getByCredito);
router.post('/',                   verifyToken, ctrl.upload);
router.get('/download/:id_doc',    verifyToken, ctrl.download);
router.delete('/:id_doc',          verifyToken, ctrl.remove);

module.exports = router;
