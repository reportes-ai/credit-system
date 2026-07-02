'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/mi-dia.controller');

// Panel del usuario (cualquiera autenticado)
router.get('/', verifyToken, c.panel);
// Config del disparador del popup (la lee el loader global de cualquier usuario)
router.get('/popup-cfg', verifyToken, c.getPopupCfg);
router.put('/popup-cfg', verifyToken, requireFunc('mant_mi_dia'), c.setPopupCfg);

// Google Calendar — connect/status/disconnect requieren sesión; callback NO
// (viene redirigido por Google, sin token; valida el state firmado).
router.get('/google/connect',     verifyToken, c.googleConnect);
router.post('/google/disconnect', verifyToken, c.googleDisconnect);
router.get('/google/callback',    c.googleCallback);

// Mantenedor (config por perfil)
router.get('/config', verifyToken, requireFunc('mant_mi_dia'), c.catalogo);
router.put('/config', verifyToken, requireFunc('mant_mi_dia'), c.guardarConfig);

module.exports = router;
