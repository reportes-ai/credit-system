'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const C = require('../controllers/atencion.controller');

/* ── Portal Dealer ───────────────────────────────────────────────────────── */
router.post('/dealer/login', C.dealerLogin);

/* ── Compartido (ejecutivo o dealer) ─────────────────────────────────────── */
router.get('/ice', C.verifyAny, C.getIce);
router.get('/conversaciones/:id/mensajes', C.verifyAny, C.getMensajes);
router.post('/conversaciones/:id/adjuntos', C.verifyAny, C.subirAdjunto);
router.get('/adjuntos/:id', C.verifyAny, C.descargarAdjunto);

/* ── Ejecutivo (usuario interno) ─────────────────────────────────────────── */
router.get('/cola', verifyToken, C.getCola);

router.get('/cuentas',     verifyToken, requireFunc('atencion_remota'), C.listarCuentas);
router.post('/cuentas',    verifyToken, requireFunc('atencion_remota'), C.crearCuenta);
router.put('/cuentas/:id', verifyToken, requireFunc('atencion_remota'), C.actualizarCuenta);

router.get('/config', verifyToken, requireFunc('atencion_remota', 'atencion_remota_config'), C.getConfig);
router.put('/config', verifyToken, requireFunc('atencion_remota_config'), C.putConfig);

module.exports = router;
