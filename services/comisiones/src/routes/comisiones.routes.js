const router = require('express').Router();
const ctrl   = require('../controllers/comisiones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Autorización paramétrica: obedece la matriz de Perfiles y Permisos
router.get('/variables',          verifyToken,                                       ctrl.getVariables);
router.put('/variables',          verifyToken, requireFunc('comisiones_variables'), ctrl.putVariables);
// Bitácora de cambios de variables: solo lectura, permiso propio. No hay ruta de
// edición ni de borrado — la bitácora es inmutable por diseño.
router.get('/variables/bitacora',     verifyToken, requireFunc('comisiones_variables_bitacora'), ctrl.getVariablesBitacora);
router.get('/variables/bitacora/:id', verifyToken, requireFunc('comisiones_variables_bitacora'), ctrl.getVariablesBitacoraDetalle);
// Modelos de incentivo (juegos de variables con nombre) y qué modelo rige cada mes.
// Aplicar un modelo = guardar variables con vigencia: mismo permiso que editar.
router.get('/variables/modelos',              verifyToken,                                       ctrl.getModelos);
router.get('/variables/vigencia-meses',       verifyToken,                                       ctrl.getVigenciaMeses);
router.post('/variables/modelos',             verifyToken, requireFunc('comisiones_variables'), ctrl.postModelo);
router.delete('/variables/modelos/:id',       verifyToken, requireFunc('comisiones_variables'), ctrl.deleteModelo);
router.post('/variables/modelos/:id/aplicar', verifyToken, requireFunc('comisiones_variables'), ctrl.aplicarModelo);
// Reportes propios del módulo: exigen Ver Comisión Ejecutivos (auditoría 2026-08-08).
// ajustes-vigentes (más abajo) queda abierto: lo lee reportería de rentabilidad.
router.get('/calculo',            verifyToken, requireFunc('comisión_ejecutivos_ver'), ctrl.getCalculo);
router.get('/ejecutivos',         verifyToken, requireFunc('comisión_ejecutivos_ver'), ctrl.getEjecutivos);
router.post('/aprobar',           verifyToken, requireFunc('comisiones_revision'),  ctrl.aprobar);
router.put('/op-independiente',   verifyToken, requireFunc('comisiones_revision'),  ctrl.marcarIndependiente);
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

// Nómina de comisiones: foto de lo que se paga, se manda a RRHH y congela el libro (08-09-2026)
const nom = require('../controllers/nomina.controller');
router.get ('/nomina',               verifyToken, requireFunc('comisiones_nomina', 'comisiones_revision'), nom.getNomina);
router.post('/nomina/generar',       verifyToken, requireFunc('comisiones_nomina_generar'), nom.generar);
router.post('/nomina/:id/reenviar',  verifyToken, requireFunc('comisiones_nomina_generar'), nom.reenviar);
router.put ('/nomina/destinatarios', verifyToken, requireFunc('comisiones_nomina_generar'), nom.destinatarios);

module.exports = router;
