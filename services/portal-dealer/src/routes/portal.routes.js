'use strict';
const router = require('express').Router();
// Reusa el middleware de dealer de Atención Remota (única fuente de verdad del
// JWT tipo='dealer'). No usa requireFunc: los dealers no tienen perfil interno,
// el acceso se acota por pertenencia (id_dealer/rut de la sesión) en cada handler.
const { verifyDealer } = require('../../../atencion-remota/src/controllers/atencion.controller');
const c = require('../controllers/portal.controller');

router.get('/resumen',     verifyDealer, c.resumen);
router.get('/operaciones', verifyDealer, c.operaciones);
router.get('/cartolas',    verifyDealer, c.cartolas);
router.get('/simulador',   verifyDealer, c.simulador);
router.post('/preaprobacion',               verifyDealer, c.preaprobar);
router.post('/preaprobacion/:id/contactar', verifyDealer, c.preaprobacionContactar);
router.get('/operaciones/:id',           verifyDealer, c.detalle);
router.get('/operaciones/:id/fundantes', verifyDealer, c.fundantes);
router.get('/operaciones/:id/pago',      verifyDealer, c.pago);
router.post('/ia',                       verifyDealer, c.ia);

// Repositorio de preaprobaciones (uso INTERNO del suite, no del dealer):
// búsqueda por correlativo PREaammxxx, RUT o dealer.
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
router.get('/preaprobaciones', verifyToken, requireFunc('preaprob_repo'), c.listarPreaprobaciones);

module.exports = router;
