const router = require('express').Router();
const ctrl   = require('../controllers/comision-dealer.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

// Tabla efectiva de comisión dealer (parque/calle por tramo) desde el motor único.
router.get('/tabla', verifyToken, ctrl.tabla);

module.exports = router;
