const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/excepciones.controller');

router.get('/estado',       verifyToken, requireFunc('excepciones_simulador'), ctrl.getEstado);
router.get('/mis-codigos',  verifyToken, requireFunc('excepciones_simulador'), ctrl.misCodigos);
router.get('/registro',     verifyToken, requireFunc('excepciones_gerencia'), ctrl.registro);
router.get('/informe',      verifyToken, requireFunc('excepciones_gerencia'), ctrl.informe);
// validar/usar los ocupan el simulador y el formulario de cartas — nunca un token cualquiera
router.get('/validar/:codigo', verifyToken, requireFunc('excepciones_simulador', 'aprob_crear', 'aprob_revisar'), ctrl.validar);
router.post('/generar',     verifyToken, requireFunc('excepciones_generar'), ctrl.generar);
router.post('/generar-gerencia', verifyToken, requireFunc('excepciones_gerencia'), ctrl.generarGerencia);
router.post('/usar',        verifyToken, requireFunc('excepciones_simulador', 'aprob_crear', 'aprob_revisar'), ctrl.usar);

module.exports = router;
