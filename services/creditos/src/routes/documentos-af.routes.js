const router = require('express').Router();
const ctrl   = require('../controllers/documentos-af.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

// Specific routes BEFORE parameterized ones
router.get('/download/:id_doc',        verifyToken, ctrl.download);
router.get('/view/:id_doc',            verifyToken, ctrl.view);
router.patch('/:id_doc/comentario',    verifyToken, ctrl.updateComentario);
router.patch('/:id_doc/validar',       verifyToken, ctrl.validar);
router.patch('/:id_doc/rechazar',      verifyToken, ctrl.rechazar);
router.delete('/:id_doc',              verifyToken, ctrl.remove);
router.get('/:id_credito',             verifyToken, ctrl.getByCredito);
router.post('/',                       verifyToken, ctrl.upload);

module.exports = router;
