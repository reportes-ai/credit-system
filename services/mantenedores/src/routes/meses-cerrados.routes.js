'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c = require('../controllers/meses-cerrados.controller');

router.get('/',                    verifyToken, c.getAll);
router.get('/check/:mes',          verifyToken, c.checkMes);
router.put('/config/dias-cierre',  verifyToken, c.setDiasCierre);
router.put('/:mes',                verifyToken, c.toggle);

module.exports = router;
