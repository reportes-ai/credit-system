const router = require('express').Router();
const ctrl   = require('../controllers/credito-documentos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/download/:id_doc',       verifyToken, ctrl.download);
router.get('/view/:id_doc',           verifyToken, ctrl.view);
router.patch('/:id_doc/comentario',   verifyToken, ctrl.updateComentario);
router.get('/:id_credito',            verifyToken, ctrl.getByCredito);
router.post('/',                      verifyToken, ctrl.upload);
router.delete('/all/:id_credito',     verifyToken, ctrl.removeAll);
router.delete('/:id_doc',             verifyToken, ctrl.remove);

module.exports = router;
