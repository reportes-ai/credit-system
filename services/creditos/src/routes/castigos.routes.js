const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/castigos.controller');

// Lectura (cualquier usuario autenticado que llegue a la ficha / historial gateado por página)
router.get('/operacion/:numop', verifyToken, ctrl.porOperacion);
router.get('/resolver/:numop',  verifyToken, ctrl.resolver);
router.get('/',                 verifyToken, ctrl.historial);
router.get('/contable',         verifyToken, ctrl.contable);
router.post('/contable/cierre', verifyToken, requireFunc('castigos_historial'), ctrl.cerrarMesContable);
router.get('/contable/detalle', verifyToken, ctrl.detalleProvision);

// Escritura
router.post('/',            verifyToken, requireFunc('castigo_solicitar'), ctrl.solicitar);
router.post('/:id/anular',  verifyToken, requireFunc('castigo_solicitar'), ctrl.anular);
// La atribución fina del rol (FINANZAS/OPERACIONES) se valida dentro del controller con tieneFunc;
// aquí basta con exigir que tenga ALGUNA de las dos firmas.
router.post('/:id/aprobar', verifyToken, requireFunc('castigo_aprobar_finanzas', 'castigo_aprobar_operaciones'), ctrl.aprobar);

module.exports = router;
