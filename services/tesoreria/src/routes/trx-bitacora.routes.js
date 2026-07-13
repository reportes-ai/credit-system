const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/trx-bitacora.controller');

router.get('/', verifyToken, requireFunc('trx_bitacora'), ctrl.buscar);

module.exports = router;
