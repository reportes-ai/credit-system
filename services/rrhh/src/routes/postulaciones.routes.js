'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const rateLimit = require('../../../../shared/rate-limit');
const c = require('../controllers/postulaciones.controller');

/* ── PÚBLICO (el candidato, sin login) — con techo propio por IP ── */
const techo = rateLimit({ ventanaMs: 60000, max: 20, mensaje: 'Demasiadas solicitudes — espera un minuto.' });
router.get('/aviso/:slug',              techo, c.avisoPublico);
router.post('/aviso/:slug/extraer-cv',  rateLimit({ ventanaMs: 60000, max: 6, mensaje: 'Espera un momento antes de volver a intentar.' }), c.extraerCV);
router.post('/aviso/:slug/postular',    techo, c.postular);

/* ── RRHH (token + permiso rh_postulaciones) ── */
const rrhh = [verifyToken, requireFunc('rh_postulaciones')];
router.get('/avisos',                  ...rrhh, c.avisosListar);
router.get('/jefes',                   ...rrhh, c.jefesLista);
router.post('/avisos',                 ...rrhh, c.avisoGuardar);
router.put('/avisos/:id',              ...rrhh, c.avisoGuardar);
router.get('/postulantes',             ...rrhh, c.postulantesListar);
router.get('/postulantes/:id',         ...rrhh, c.postulanteFicha);
router.get('/postulantes/:id/cv',      ...rrhh, c.postulanteCV);
router.post('/postulantes/:id/estado', ...rrhh, c.postulanteEstado);
router.post('/postulantes/:id/dealernet',       ...rrhh, c.dealernetPedir);
router.post('/postulantes/:id/analisis-ia',     ...rrhh, c.analisisIA);
router.post('/postulantes/:id/entrevistas',     ...rrhh, c.entrevistaCrear);
router.put('/postulantes/:id/entrevistas/:ix',  ...rrhh, c.entrevistaActualizar);
router.post('/postulantes/:id/informe',         ...rrhh, c.informeGuardar);
router.post('/postulantes/:id/docs',            ...rrhh, c.docSubir);
router.get('/docs/:idDoc',                      ...rrhh, c.docVer);
router.post('/jefatura',                        ...rrhh, c.enviarJefatura);

/* ── JEFE DIRECTO (token + permiso rh_postulaciones_jefe; ve solo sus avisos) ── */
const jefe = [verifyToken, requireFunc('rh_postulaciones_jefe')];
router.get('/jefe/postulantes',            ...jefe, c.jefePostulantes);
router.get('/jefe/postulantes/:id',        ...jefe, c.jefeFicha);
router.get('/jefe/postulantes/:id/cv',     ...jefe, c.jefeCV);
router.post('/jefe/postulantes/:id/marcar', ...jefe, c.jefeMarcar);

module.exports = router;
