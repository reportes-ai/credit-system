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
// Aviso de vencimiento — también administrable desde el mantenedor de Cobranza
router.get('/aviso-vencimiento',            verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.avisoVencEstado);
router.put('/aviso-vencimiento/config',     verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.avisoVencConfig);
router.post('/aviso-vencimiento/probar',    verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.avisoVencProbar);
router.post('/aviso-vencimiento/correr',    verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.avisoVencCorrer);
router.post('/aviso-vencimiento/plantillas',verifyToken, requireFunc('wsp_config'), ctrl.avisoVencCrearPlantillas);
router.get('/plantillas',            verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.plantillas);
router.post('/plantillas',           verifyToken, requireFunc('wsp_config'), ctrl.crearPlantilla);
router.post('/plantillas/revisar',   verifyToken, requireFunc('wsp_config'), ctrl.revisarPlantilla);
router.put('/plantillas/:nombre/tipo', verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.setTipoPlantilla);
router.delete('/plantillas/:nombre', verifyToken, requireFunc('wsp_config'), ctrl.eliminarPlantilla);

// Automatizaciones de Cobranza (secuencia numerada de plantillas tipo=COBRANZA).
// Se administran desde el mantenedor de Cobranza → también acepta mant_cobranza_mora.
router.get('/automatizacion-cobranza',         verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.autoCobranzaEstado);
router.put('/automatizacion-cobranza/config',  verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.autoCobranzaConfig);
router.post('/automatizacion-cobranza/probar', verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.autoCobranzaProbar);
router.post('/automatizacion-cobranza/correr', verifyToken, requireFunc('wsp_config', 'mant_cobranza_mora'), ctrl.autoCobranzaCorrer);

// Campañas de salida
router.get('/campanas',              verifyToken, requireFunc('wsp_campanas'), ctrl.campanas);
router.get('/campanas-audiencia',    verifyToken, requireFunc('wsp_campanas'), ctrl.previewAudiencia);
router.post('/campanas',             verifyToken, requireFunc('wsp_campanas'), ctrl.guardarCampana);
router.put('/campanas/:id',          verifyToken, requireFunc('wsp_campanas'), ctrl.guardarCampana);
router.post('/campanas/:id/enviar',  verifyToken, requireFunc('wsp_campanas'), ctrl.enviarCampana);
router.delete('/campanas/:id',       verifyToken, requireFunc('wsp_campanas'), ctrl.eliminarCampana);

module.exports = router;
