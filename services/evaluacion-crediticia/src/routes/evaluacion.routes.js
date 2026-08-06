const router = require('express').Router();
const ctrl = require('../controllers/evaluacion.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const evaluar = requireFunc('evaluacion_crediticia');

router.get('/ficha/:rut', verifyToken, ctrl.ficha);

// Documentos de evaluación (carga por RUT + documento requerido)
router.get('/documentos/:rut',     verifyToken, ctrl.getDocumentos);
router.post('/documento',          verifyToken, evaluar, ctrl.subirDocumento);
router.get('/documento/:id/view',  verifyToken, ctrl.verDocumento);
router.post('/documento/:id/validar-afp', verifyToken, evaluar, ctrl.validarAfp);
router.delete('/documento/:id',    verifyToken, evaluar, ctrl.removeDocumento);

module.exports = router;
