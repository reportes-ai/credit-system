const router = require('express').Router();
const ctrl   = require('../controllers/operaciones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/next-op',                    verifyToken, ctrl.nextOp);
router.post('/recalcular-comisiones',     verifyToken, requireFunc('creditos_recalcular_comisiones'), ctrl.recalcularComisiones);
router.get('/',                 verifyToken, ctrl.getAll);
router.get('/:id',              verifyToken, ctrl.getOne);
router.post('/',                verifyToken, ctrl.create);
router.put('/:id',              verifyToken, ctrl.update);
// Mutaciones sensibles con permiso dedicado (ver matriz de Perfiles).
router.put('/:id/liberar-pago', verifyToken, requireFunc('creditos_liberar_pago'), ctrl.liberarPago);
router.put('/:id/no-otorgado',  verifyToken, requireFunc('creditos_no_otorgado'), ctrl.marcarNoOtorgado);
router.delete('/:id',           verifyToken, ctrl.remove);

module.exports = router;
