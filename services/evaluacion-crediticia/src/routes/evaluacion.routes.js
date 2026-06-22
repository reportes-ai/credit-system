const router = require('express').Router();
const ctrl = require('../controllers/evaluacion.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/ficha/:rut', verifyToken, ctrl.ficha);

// Documentos de evaluación (carga por RUT + documento requerido)
router.get('/documentos/:rut',     verifyToken, ctrl.getDocumentos);
router.post('/documento',          verifyToken, ctrl.subirDocumento);
router.get('/documento/:id/view',  verifyToken, ctrl.verDocumento);
router.delete('/documento/:id',    verifyToken, ctrl.removeDocumento);

module.exports = router;
