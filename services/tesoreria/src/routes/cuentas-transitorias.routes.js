const router = require('express').Router();
const ctrl   = require('../controllers/cuentas-transitorias.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/',                         verifyToken, ctrl.list);
router.get('/por-credito/:id_credito',  verifyToken, ctrl.porCredito);

module.exports = router;
