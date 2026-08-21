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
router.get('/avisos',                 verifyToken, requireFunc('rh_postulaciones'), c.avisosListar);
router.post('/avisos',                verifyToken, requireFunc('rh_postulaciones'), c.avisoGuardar);
router.put('/avisos/:id',             verifyToken, requireFunc('rh_postulaciones'), c.avisoGuardar);
router.get('/postulantes',            verifyToken, requireFunc('rh_postulaciones'), c.postulantesListar);
router.get('/postulantes/:id',        verifyToken, requireFunc('rh_postulaciones'), c.postulanteFicha);
router.get('/postulantes/:id/cv',     verifyToken, requireFunc('rh_postulaciones'), c.postulanteCV);
router.post('/postulantes/:id/estado', verifyToken, requireFunc('rh_postulaciones'), c.postulanteEstado);

module.exports = router;
