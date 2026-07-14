'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/contabilidad.controller');

// Plan de cuentas
router.get('/cuentas',            verifyToken, requireFunc('ctb_ver', 'ctb_plan', 'ctb_comprobantes', 'ctb_libros', 'ctb_balance'), ctrl.getCuentas);
router.post('/cuentas',           verifyToken, requireFunc('ctb_plan'), ctrl.crearCuenta);
router.put('/cuentas/:codigo',    verifyToken, requireFunc('ctb_plan'), ctrl.editarCuenta);
router.delete('/cuentas/:codigo', verifyToken, requireFunc('ctb_plan'), ctrl.eliminarCuenta);

// Comprobantes
router.get('/comprobantes',            verifyToken, requireFunc('ctb_comprobantes', 'ctb_libros'), ctrl.listarComprobantes);
router.post('/comprobantes',           verifyToken, requireFunc('ctb_comprobantes'), ctrl.crearComprobante);
router.get('/comprobantes/:id',        verifyToken, requireFunc('ctb_comprobantes', 'ctb_libros'), ctrl.getComprobante);
router.post('/comprobantes/:id/anular', verifyToken, requireFunc('ctb_comprobantes'), ctrl.anularComprobante);

// Punto de Restauración (nivel Dios: borra asientos posteriores a la marca)
router.get('/punto-restauracion',            verifyToken, requireFunc('mantenedores_solo_dios'), ctrl.prEstado);
router.post('/punto-restauracion/crear',     verifyToken, requireFunc('mantenedores_solo_dios'), ctrl.prCrear);
router.post('/punto-restauracion/restaurar', verifyToken, requireFunc('mantenedores_solo_dios'), ctrl.prRestaurar);

// Buscador global de movimientos
router.get('/movimientos', verifyToken, requireFunc('ctb_libros', 'ctb_balance', 'ctb_comprobantes'), ctrl.buscarMovimientos);

// Adjuntos de respaldo
router.get('/comprobantes/:id/adjuntos',  verifyToken, requireFunc('ctb_comprobantes', 'ctb_libros'), ctrl.listarAdjuntos);
router.post('/comprobantes/:id/adjuntos', verifyToken, requireFunc('ctb_comprobantes'), ctrl.subirAdjunto);
router.get('/adjuntos/:id',               verifyToken, requireFunc('ctb_comprobantes', 'ctb_libros'), ctrl.descargarAdjunto);
router.delete('/adjuntos/:id',            verifyToken, requireFunc('ctb_comprobantes'), ctrl.eliminarAdjunto);

// Asistente IA de asientos
router.post('/asistente-asiento', verifyToken, requireFunc('ctb_comprobantes'), ctrl.asistenteAsiento);

// Guardián contable
router.get('/guardian',        verifyToken, requireFunc('ctb_guardian', 'ctb_comprobantes'), ctrl.getGuardianReglas);
router.post('/guardian',       verifyToken, requireFunc('ctb_guardian'), ctrl.crearGuardianRegla);
router.put('/guardian/:id',    verifyToken, requireFunc('ctb_guardian'), ctrl.editarGuardianRegla);
router.delete('/guardian/:id', verifyToken, requireFunc('ctb_guardian'), ctrl.eliminarGuardianRegla);

// Plantillas de asientos
router.get('/plantillas',        verifyToken, requireFunc('ctb_comprobantes'), ctrl.getPlantillas);
router.post('/plantillas',       verifyToken, requireFunc('ctb_comprobantes'), ctrl.crearPlantilla);
router.delete('/plantillas/:id', verifyToken, requireFunc('ctb_comprobantes'), ctrl.eliminarPlantilla);

// Reglas de centralización (Fase 2)
router.get('/reglas',            verifyToken, requireFunc('ctb_reglas'), ctrl.getReglas);
router.put('/reglas/:evento',    verifyToken, requireFunc('ctb_reglas'), ctrl.putRegla);
router.get('/eventos-log',       verifyToken, requireFunc('ctb_reglas', 'ctb_libros'), ctrl.getEventosLog);

// Libros y balance
router.get('/libro-diario', verifyToken, requireFunc('ctb_libros', 'ctb_balance'), ctrl.libroDiario);
router.get('/libro-mayor',  verifyToken, requireFunc('ctb_libros', 'ctb_balance'), ctrl.libroMayor);
router.get('/balance',      verifyToken, requireFunc('ctb_balance', 'ctb_libros'), ctrl.balance);
router.get('/balance-general',   verifyToken, requireFunc('ctb_estados', 'ctb_balance', 'ctb_libros'), ctrl.balanceGeneral);
router.get('/estado-resultados', verifyToken, requireFunc('ctb_estados', 'ctb_balance', 'ctb_libros'), ctrl.estadoResultados);
router.post('/cierre-ejercicio', verifyToken, requireFunc('ctb_estados'), ctrl.cerrarEjercicio);
router.get('/cierre-mes',        verifyToken, requireFunc('ctb_cierre_mes', 'ctb_estados', 'ctb_balance', 'ctb_libros'), ctrl.cierreMes);
router.put('/cierre-mes/comentario',  verifyToken, requireFunc('ctb_cierre_mes', 'ctb_estados'), ctrl.guardarComentario);
router.post('/cierre-mes/comentario-ia', verifyToken, requireFunc('ctb_cierre_mes', 'ctb_estados'), ctrl.comentarioIA);

// Candado de mes cerrado
router.get('/meses-cerrados',        verifyToken, requireFunc('ctb_cierre_mes', 'ctb_comprobantes', 'ctb_estados'), ctrl.getMesesCerrados);
router.post('/meses-cerrados',       verifyToken, requireFunc('ctb_cierre_mes'), ctrl.cerrarMesCandado);
router.delete('/meses-cerrados/:mes', verifyToken, requireFunc('ctb_cierre_mes'), ctrl.reabrirMes);

// Bitácora de Cierres
router.get('/bitacora-cierres',              verifyToken, requireFunc('ctb_bitacora', 'ctb_cierre_mes', 'ctb_estados', 'ctb_libros'), ctrl.bitacoraCierres);
router.post('/bitacora-cierres/:mes/analizar', verifyToken, requireFunc('ctb_bitacora', 'ctb_cierre_mes', 'ctb_estados'), ctrl.analizarCierre);

module.exports = router;
