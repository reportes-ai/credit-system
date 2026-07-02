'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/meses-cerrados.controller');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const gestionar = requireFunc('mant_meses_cerrados');

router.get('/',                    verifyToken, c.getAll);
router.get('/check/:mes',          verifyToken, c.checkMes);
router.get('/checklist/:mes',      verifyToken, gestionar, c.checklist);
router.put('/config/dias-cierre',  verifyToken, gestionar, c.setDiasCierre);
router.put('/:mes',                verifyToken, gestionar, c.toggle);

module.exports = router;
