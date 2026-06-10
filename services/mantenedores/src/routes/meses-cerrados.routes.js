'use strict';
const router = require('express').Router();
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');
const c = require('../controllers/meses-cerrados.controller');
const soloAdmin = requirePerfil('Administrador', 'Gerente');

router.get('/',                    verifyToken, c.getAll);
router.get('/check/:mes',          verifyToken, c.checkMes);
router.put('/config/dias-cierre',  verifyToken, soloAdmin, c.setDiasCierre);
router.put('/:mes',                verifyToken, soloAdmin, c.toggle);

module.exports = router;
