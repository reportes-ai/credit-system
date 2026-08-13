const router = require('express').Router();
const ctrl = require('../controllers/correos-plantillas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

/* Los correos se administran DENTRO de Post Venta → Mantenedores (decisión de
   Pato 13-08: todos los correos en un solo lugar, donde ya se trabaja), así que
   basta con el permiso de esa pantalla; `mant_correos` se mantiene por si la
   sección se abre a otras áreas. */
const puedeGestionar = requireFunc('postventa_mantenedores', 'mant_correos');

router.get('/',                    verifyToken, puedeGestionar, ctrl.listar);
router.put('/:codigo',             verifyToken, puedeGestionar, ctrl.guardar);
router.post('/:codigo/prueba',     verifyToken, puedeGestionar, ctrl.prueba);

module.exports = router;
