'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/campanas-ventas.controller');

const puede = requireFunc('campanas_ventas');        // operar (discador, ver stats)
const admin = requireFunc('campanas_ventas_admin');  // crear/configurar campañas

router.get('/catalogo',            verifyToken, puede, c.catalogo);
router.get('/',                    verifyToken, puede, c.listar);
router.post('/',                   verifyToken, admin, c.crear);
router.get('/:id',                 verifyToken, puede, c.obtener);
router.put('/:id',                 verifyToken, admin, c.actualizar);
router.put('/:id/estado',          verifyToken, admin, c.cambiarEstado);
router.delete('/:id',              verifyToken, admin, c.eliminar);
router.put('/:id/terminos',        verifyToken, admin, c.guardarTerminos);
router.post('/:id/registros',      verifyToken, admin, c.cargarRegistros);
router.get('/:id/registros',       verifyToken, puede, c.registros);
router.get('/:id/siguiente',       verifyToken, puede, c.siguiente);
router.post('/:id/liberar',        verifyToken, puede, c.liberar);
router.post('/:id/gestion',        verifyToken, puede, c.gestionar);
router.get('/:id/stats',           verifyToken, puede, c.stats);
router.post('/:id/recalcular',     verifyToken, puede, c.recalcularConversion);

module.exports = router;
