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
router.get('/resumen-config',     verifyToken, requireFunc('comisiones_revision'), ctrl.getResumenConfig);
router.post('/enviar-resumen',    verifyToken, requireFunc('comisiones_revision'), ctrl.enviarResumen);
router.get('/alertas-config',     verifyToken,                                     ctrl.getAlertasConfig);
router.put('/alertas-config',     verifyToken, requireFunc('comisiones_revision'), ctrl.setAlertasConfig);

// Ajustes de comisión por operación (solicita Analista Ops, aprueba Gerente Ops)
const aj = require('../controllers/ajustes.controller');
router.get ('/ajustes',              verifyToken, requireFunc('com_ejec_mod'),           aj.listar);
router.get ('/ajustes-vigentes',     verifyToken,                                        aj.vigentes);
router.get ('/ajustes/historia',     verifyToken, requireFunc('com_ejec_mod'),           aj.historia);
router.post('/ajustes',              verifyToken, requireFunc('com_ejec_mod_solicitar'), aj.solicitar);
router.post('/ajustes/:id/resolver', verifyToken, requireFunc('com_ejec_mod_aprobar'),   aj.resolver);

module.exports = router;
