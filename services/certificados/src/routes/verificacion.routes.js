const router = require('express').Router();
const ctrl = require('../controllers/verificacion.controller');

// PÚBLICO a propósito: el QR se escanea desde un teléfono externo (un banco, etc.).
// Sin verifyToken. Solo expone datos mínimos (RUT enmascarado).
router.get('/:codigo', ctrl.verificar);

module.exports = router;
