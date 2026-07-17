'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/visitas.controller');

const verVisitas = requireFunc('visitas_dealers', 'visitas_supervisar');
const gestionar  = requireFunc('visitas_dealers', 'visitas_supervisar');

const supervisar = requireFunc('visitas_supervisar');

router.get('/config',          verifyToken, verVisitas, c.getConfig);
router.get('/ejecutivos',      verifyToken, supervisar, c.ejecutivos);
router.get('/zonas',           verifyToken, supervisar, c.zonasCartera);
router.get('/zonas-mapa',      verifyToken, supervisar, c.zonasMapa);
router.post('/asignacion-masiva', verifyToken, supervisar, c.asignacionMasiva);
router.get('/asignaciones',    verifyToken, verVisitas, c.listarAsignaciones);
router.post('/asignaciones',   verifyToken, supervisar, c.crearAsignacion);
router.delete('/asignaciones/:id', verifyToken, supervisar, c.cerrarAsignacion);
router.get('/planes',          verifyToken, supervisar, c.listarPlanes);
router.put('/planes/:id/cerrar', verifyToken, supervisar, c.cerrarPlan);
router.get('/ficha-dia',       verifyToken, verVisitas, c.fichaDia);
router.get('/ficha-rango',     verifyToken, verVisitas, c.fichaRango);
router.get('/stats',           verifyToken, verVisitas, c.stats);
router.get('/informes',        verifyToken, requireFunc('visitas_informes'), c.informes);
router.get('/asignados',       verifyToken, supervisar, c.asignados);
router.delete('/dia',          verifyToken, gestionar,  c.borrarDia);
router.put('/config',          verifyToken, requireFunc('visitas_supervisar'), c.putConfig);
router.get('/dealers',         verifyToken, verVisitas, c.getDealers);
router.get('/planificador',    verifyToken, verVisitas, c.planificador);
router.get('/',                verifyToken, verVisitas, c.listar);
router.post('/',               verifyToken, gestionar,  c.crear);
router.put('/:id/gestion',     verifyToken, gestionar,  c.gestionar);
router.delete('/:id',          verifyToken, gestionar,  c.eliminar);

module.exports = router;
