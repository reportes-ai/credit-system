const router = require('express').Router();
const ctrl   = require('../controllers/documentos-af.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Specific routes BEFORE parameterized ones
router.get('/download/:id_doc',        verifyToken, ctrl.download);
router.get('/view/:id_doc',            verifyToken, ctrl.view);
router.patch('/:id_doc/comentario',    verifyToken, requireFunc('creditos_documentos_af','creditos_validar_doc_af'), ctrl.updateComentario);
router.patch('/:id_doc/validar',       verifyToken, requireFunc('creditos_validar_doc_af'), ctrl.validar);
router.patch('/:id_doc/rechazar',      verifyToken, requireFunc('creditos_validar_doc_af'), ctrl.rechazar);
router.delete('/:id_doc',              verifyToken, requireFunc('creditos_documentos_af'), ctrl.remove);
router.get('/:id_credito',             verifyToken, ctrl.getByCredito);
router.post('/',                       verifyToken, requireFunc('creditos_documentos_af'), ctrl.upload);

module.exports = router;
