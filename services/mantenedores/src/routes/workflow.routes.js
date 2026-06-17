const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/workflow.controller');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
// Funcionalidad propia (Admin-only por defecto) para preservar el comportamiento previo.
router.get('/',   verifyToken, ctrl.get);
router.put('/',   verifyToken, requireFunc('mantenedores_workflow'), ctrl.put);

module.exports = router;
