'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/mi-dia.controller');

// Panel del usuario (cualquiera autenticado)
router.get('/', verifyToken, c.panel);

// Google Calendar — connect/status/disconnect requieren sesión; callback NO
// (viene redirigido por Google, sin token; valida el state firmado).
router.get('/google/connect',     verifyToken, c.googleConnect);
router.post('/google/disconnect', verifyToken, c.googleDisconnect);
router.get('/google/callback',    c.googleCallback);

// Mantenedor (config por perfil)
router.get('/config', verifyToken, requireFunc('mant_mi_dia'), c.catalogo);
router.put('/config', verifyToken, requireFunc('mant_mi_dia'), c.guardarConfig);

module.exports = router;
