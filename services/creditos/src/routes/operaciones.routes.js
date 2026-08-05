const router = require('express').Router();
const ctrl   = require('../controllers/operaciones.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/next-op',                    verifyToken, ctrl.nextOp);
router.post('/recalcular-comisiones',     verifyToken, requireFunc('creditos_recalcular_comisiones'), ctrl.recalcularComisiones);
router.get('/',                 verifyToken, ctrl.getAll);
router.get('/:id',              verifyToken, ctrl.getOne);
/* Auditoría 05-08-2026 (C-2): crear, editar y BORRAR estaban solo con
   verifyToken mientras las dos mutaciones de estado de más abajo sí pedían
   permiso. Se había protegido lo sensible y quedó abierto lo destructivo:
   `creditos` es la tabla de la que cuelgan comisiones, cartolas, contabilidad
   y cobranza. */
router.post('/',                verifyToken, requireFunc('creditos_crear'),  ctrl.create);
router.put('/:id',              verifyToken, requireFunc('creditos_editar'), ctrl.update);
// Mutaciones sensibles con permiso dedicado (ver matriz de Perfiles).
router.put('/:id/liberar-pago', verifyToken, requireFunc('creditos_liberar_pago'), ctrl.liberarPago);
router.put('/:id/no-otorgado',  verifyToken, requireFunc('creditos_no_otorgado'), ctrl.marcarNoOtorgado);
router.delete('/:id',           verifyToken, requireFunc('creditos_eliminar'), ctrl.remove);

module.exports = router;
