const router = require('express').Router();
const ctrl = require('../controllers/certificados.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const puede = requireFunc('certificados_emitir');

router.get('/buscar',     verifyToken, puede, ctrl.buscar);
router.post('/preview',   verifyToken, puede, ctrl.preview);
router.post('/generar',   verifyToken, puede, ctrl.generar);
router.get('/historial',  verifyToken, puede, ctrl.historial);
router.post('/:codigo/anular', verifyToken, requireFunc('certificados_anular'), ctrl.anular);

module.exports = router;
