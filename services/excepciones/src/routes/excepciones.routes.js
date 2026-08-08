const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/excepciones.controller');

router.get('/estado',       verifyToken, requireFunc('excepciones_simulador'), ctrl.getEstado);
router.get('/mis-codigos',  verifyToken, requireFunc('excepciones_simulador'), ctrl.misCodigos);
router.get('/registro',     verifyToken, requireFunc('excepciones_gerencia'), ctrl.registro);
router.get('/informe',      verifyToken, requireFunc('excepciones_gerencia'), ctrl.informe);
router.get('/validar/:codigo', verifyToken, ctrl.validar);
router.post('/generar',     verifyToken, requireFunc('excepciones_generar'), ctrl.generar);
router.post('/generar-gerencia', verifyToken, requireFunc('excepciones_gerencia'), ctrl.generarGerencia);
router.post('/usar',        verifyToken, ctrl.usar);

module.exports = router;
