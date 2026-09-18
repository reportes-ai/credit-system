const router = require('express').Router();
const ctrl   = require('../controllers/empresa.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Lectura: cualquier usuario autenticado (liquidaciones, contratos, F29, DJ, cartolas la muestran)
router.get('/', verifyToken, ctrl.get);
router.put('/', verifyToken, requireFunc('mant_empresa'), ctrl.put);

module.exports = router;
