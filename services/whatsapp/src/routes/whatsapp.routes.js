'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/whatsapp.controller');

// Webhook Meta — público (Meta lo llama con su verify token, no con nuestro JWT)
router.get('/webhook',  ctrl.webhookVerify);
router.post('/webhook', ctrl.webhookReceive);

// Simulador (probar el bot desde el panel)
router.post('/simular', verifyToken, requireFunc('wsp_config'), ctrl.simular);

// Configuración + respuestas + triggers (mantenedor del bot)
router.get('/config',            verifyToken, requireFunc('wsp_panel'),  ctrl.getConfig);
router.put('/config',            verifyToken, requireFunc('wsp_config'), ctrl.setConfig);
router.get('/respuestas',        verifyToken, requireFunc('wsp_panel'),  ctrl.respuestas);
router.post('/respuestas',       verifyToken, requireFunc('wsp_config'), ctrl.guardarRespuesta);
router.put('/respuestas/:id',    verifyToken, requireFunc('wsp_config'), ctrl.guardarRespuesta);
router.delete('/respuestas/:id', verifyToken, requireFunc('wsp_config'), ctrl.eliminarRespuesta);
router.get('/triggers',          verifyToken, requireFunc('wsp_panel'),  ctrl.triggers);
router.post('/triggers',         verifyToken, requireFunc('wsp_config'), ctrl.guardarTrigger);
router.put('/triggers/:id',      verifyToken, requireFunc('wsp_config'), ctrl.guardarTrigger);
router.delete('/triggers/:id',   verifyToken, requireFunc('wsp_config'), ctrl.eliminarTrigger);

// Bandeja de conversaciones
router.get('/conversaciones',              verifyToken, requireFunc('wsp_panel'),   ctrl.conversaciones);
router.get('/conversaciones/:id',          verifyToken, requireFunc('wsp_panel'),   ctrl.conversacion);
router.get('/conversaciones/:id/ficha',    verifyToken, requireFunc('wsp_panel'),   ctrl.fichaCliente);
router.post('/conversaciones/:id/responder', verifyToken, requireFunc('wsp_atender'), ctrl.responderConv);
router.post('/conversaciones/:id/accion',    verifyToken, requireFunc('wsp_atender'), ctrl.accionConv);

// Plantillas HSM (gestor contra Meta: crear = enviar a aprobación)
router.get('/plantillas',            verifyToken, requireFunc('wsp_config'), ctrl.plantillas);
router.post('/plantillas',           verifyToken, requireFunc('wsp_config'), ctrl.crearPlantilla);
router.delete('/plantillas/:nombre', verifyToken, requireFunc('wsp_config'), ctrl.eliminarPlantilla);

// Campañas de salida
router.get('/campanas',              verifyToken, requireFunc('wsp_campanas'), ctrl.campanas);
router.get('/campanas-audiencia',    verifyToken, requireFunc('wsp_campanas'), ctrl.previewAudiencia);
router.post('/campanas',             verifyToken, requireFunc('wsp_campanas'), ctrl.guardarCampana);
router.put('/campanas/:id',          verifyToken, requireFunc('wsp_campanas'), ctrl.guardarCampana);
router.post('/campanas/:id/enviar',  verifyToken, requireFunc('wsp_campanas'), ctrl.enviarCampana);
router.delete('/campanas/:id',       verifyToken, requireFunc('wsp_campanas'), ctrl.eliminarCampana);

module.exports = router;
