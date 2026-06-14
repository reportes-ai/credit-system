const router = require('express').Router();
const ctrl   = require('../controllers/comisiones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Autorización paramétrica: obedece la matriz de Perfiles y Permisos
router.get('/variables',          verifyToken,                                       ctrl.getVariables);
router.put('/variables',          verifyToken, requireFunc('comisiones_variables'), ctrl.putVariables);
router.get('/calculo',            verifyToken,                                       ctrl.getCalculo);
router.get('/ejecutivos',         verifyToken,                                       ctrl.getEjecutivos);
router.post('/aprobar',           verifyToken, requireFunc('comisiones_revision'),  ctrl.aprobar);
router.post('/ejecutivo-responder', verifyToken,                                   ctrl.ejecutivoResponder);

module.exports = router;
