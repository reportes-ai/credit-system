const express = require('express');
const router  = express.Router();
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/workflow.controller');

router.get('/',   verifyToken, ctrl.get);
router.put('/',   verifyToken, requirePerfil(['Administrador']), ctrl.put);

module.exports = router;
