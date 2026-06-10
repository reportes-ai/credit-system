const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/creditos.controller');

router.get('/reporteria',            verifyToken, ctrl.getReporteria);
router.get('/otorgados-incompletos', verifyToken, ctrl.getOtorgadosIncompletos);
router.get('/',                      verifyToken, ctrl.getAll);
router.get('/:id', verifyToken, ctrl.getById);
router.post('/',   verifyToken, requireFunc('creditos.crear'),  ctrl.create);
router.put('/:id',                  verifyToken, requireFunc('creditos.editar'), ctrl.update);
router.patch('/:id/datos-ingresos', verifyToken, requireFunc('creditos.editar'), ctrl.patchDatosIngresos);

module.exports = router;
