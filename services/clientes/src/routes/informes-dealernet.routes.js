const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/informes-dealernet.controller');

// GET  /api/informes-dealernet?rut=xxx         → listar (con filtro opcional)
router.get('/',           verifyToken, ctrl.getAll);

// GET  /api/informes-dealernet/rut/:rut        → todos los informes de un RUT
router.get('/rut/:rut',   verifyToken, ctrl.getByRut);

// GET  /api/informes-dealernet/:id             → detalle de un informe
router.get('/:id(\\d+)', verifyToken, ctrl.getById);

// GET  /api/informes-dealernet/:id/pdf         → servir el PDF
router.get('/:id/pdf',    verifyToken, ctrl.getPDF);

// POST /api/informes-dealernet/upload          → subir y parsear PDF
router.post('/upload',    verifyToken, ...ctrl.uploadInforme);

// DELETE /api/informes-dealernet/:id
router.delete('/:id',     verifyToken, ctrl.deleteInforme);

module.exports = router;
