const router = require('express').Router();
const ctrl   = require('../controllers/credito-documentos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/download/:id_doc',       verifyToken, ctrl.download);
router.get('/view/:id_doc',           verifyToken, ctrl.view);
router.patch('/:id_doc/comentario',   verifyToken, requireFunc('creditos_documentos'), ctrl.updateComentario);
router.patch('/:id_doc/aprobar',      verifyToken, requireFunc('creditos_documentos'), ctrl.updateAprobacion);
router.get('/:id_credito',            verifyToken, ctrl.getByCredito);
router.post('/',                      verifyToken, requireFunc('creditos_documentos'), ctrl.upload);
router.delete('/all/:id_credito',     verifyToken, requireFunc('creditos_documentos'), ctrl.removeAll);
router.delete('/:id_doc',             verifyToken, requireFunc('creditos_documentos'), ctrl.remove);

module.exports = router;
