'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const { rateLimit } = require('../../../../shared/middleware/rate-limit');
const C = require('../controllers/atencion.controller');

/* ── Portal Dealer (endpoints públicos: con rate limit anti fuerza-bruta/spam) ── */
const rlLogin     = rateLimit({ key: 'dealer_login',     windowMs: 15 * 60 * 1000, max: 8 });
const rlAcceso    = rateLimit({ key: 'dealer_acceso',    windowMs: 60 * 60 * 1000, max: 15 });
const rlSolicitar = rateLimit({ key: 'dealer_solicitar', windowMs: 24 * 60 * 60 * 1000, max: 5 });
const rlRecuperar = rateLimit({ key: 'dealer_recuperar', windowMs: 60 * 60 * 1000, max: 5 });
const rlReset     = rateLimit({ key: 'dealer_reset',     windowMs: 60 * 60 * 1000, max: 10 });
router.post('/dealer/login',     rlLogin,     C.dealerLogin);
router.post('/dealer/solicitar', rlSolicitar, C.solicitarCuenta);   // autoregistro (público)
router.post('/dealer/acceso',    rlAcceso,    C.dealerAcceso);       // acceso por link (público, ?k=token)
router.post('/dealer/recuperar', rlRecuperar, C.recuperarClave);    // pedir enlace de reset (público)
router.post('/dealer/reset',     rlReset,     C.resetClave);        // fijar nueva clave (público, ?reset=token)
const rlIniciar    = rateLimit({ key: 'dealer_iniciar',    windowMs: 15 * 60 * 1000, max: 30 });
const rlOnboarding = rateLimit({ key: 'dealer_onboarding', windowMs: 60 * 60 * 1000, max: 6 });
router.post('/dealer/iniciar',    rlIniciar,    C.iniciarAcceso);   // ¿el email ya tiene cuenta? (público)
router.post('/dealer/onboarding', rlOnboarding, C.onboarding);      // auto-alta self-service (público)
router.post('/dealer/tour-visto', C.verifyDealer, C.tourVisto);    // marca tour de bienvenida visto

/* ── Compartido (ejecutivo o dealer) ─────────────────────────────────────── */
router.get('/ice', C.verifyAny, C.getIce);
router.get('/conversaciones/:id/mensajes', C.verifyAny, C.getMensajes);
router.post('/conversaciones/:id/adjuntos', C.verifyAny, C.subirAdjunto);
router.get('/adjuntos/:id', C.verifyAny, C.descargarAdjunto);

/* ── Ejecutivo (usuario interno) ─────────────────────────────────────────── */
router.get('/cola', verifyToken, requireFunc('atencion_remota'), C.getCola);

router.get('/cuentas',     verifyToken, requireFunc('atencion_remota'), C.listarCuentas);
router.post('/cuentas',    verifyToken, requireFunc('atencion_remota'), C.crearCuenta);
router.put('/cuentas/:id', verifyToken, requireFunc('atencion_remota'), C.actualizarCuenta);
router.post('/cuentas/:id/regenerar-link', verifyToken, requireFunc('atencion_remota'), C.regenerarLink);

router.get('/solicitudes',              verifyToken, requireFunc('atencion_remota'), C.listarSolicitudes);
router.post('/solicitudes/:id/aprobar', verifyToken, requireFunc('atencion_remota'), C.aprobarSolicitud);
router.post('/solicitudes/:id/rechazar',verifyToken, requireFunc('atencion_remota'), C.rechazarSolicitud);

router.put('/conversaciones/:id/interlocutor',  verifyToken, requireFunc('atencion_remota'), C.setInterlocutor);
router.get('/cuentas/:idCuenta/interlocutores', verifyToken, requireFunc('atencion_remota'), C.interlocutoresDe);

router.get('/config', verifyToken, requireFunc('atencion_remota', 'atencion_remota_config'), C.getConfig);
router.put('/config', verifyToken, requireFunc('atencion_remota_config'), C.putConfig);

/* ── Respuestas rápidas del chat ─────────────────────────────────────────── */
router.get('/respuestas', verifyToken, requireFunc('atencion_remota'), C.listarRespuestas);
router.get('/respuestas-admin', verifyToken, requireFunc('mant_respuestas_rapidas', 'atencion_remota_config'), C.listarRespuestasAdmin);
router.post('/respuestas', verifyToken, requireFunc('mant_respuestas_rapidas', 'atencion_remota_config'), C.crearRespuesta);
router.put('/respuestas/:id', verifyToken, requireFunc('mant_respuestas_rapidas', 'atencion_remota_config'), C.actualizarRespuesta);
router.delete('/respuestas/:id', verifyToken, requireFunc('mant_respuestas_rapidas', 'atencion_remota_config'), C.eliminarRespuesta);

module.exports = router;
