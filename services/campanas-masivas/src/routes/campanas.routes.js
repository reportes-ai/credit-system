'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken }  = require('../../../../shared/middleware/auth');
const { requireFunc }  = require('../../../../shared/middleware/permisos');
const c = require('../controllers/campanas.controller');

const puede = requireFunc('campanas_masivas');

// Píxel de lectura de los mails: PÚBLICO (lo carga el correo del cliente) y
// declarado ANTES de /:id para no chocar con esa ruta. Solo marca LEIDO con firma válida.
router.get('/pixel/:token',          c.pixel);

router.get('/catalogo',              verifyToken, puede, c.catalogo);
router.get('/plantillas-wsp',        verifyToken, puede, c.plantillasWsp);
router.get('/',                      verifyToken, puede, c.listar);
router.post('/',                     verifyToken, puede, c.crear);
router.get('/:id',                   verifyToken, puede, c.obtener);
router.put('/:id',                   verifyToken, puede, c.actualizar);
router.delete('/:id',                verifyToken, puede, c.eliminar);
router.post('/:id/destinatarios',    verifyToken, puede, c.cargarDestinatarios);
router.post('/:id/generar-desde-bd', verifyToken, puede, c.generarDesdeBD);
router.get('/:id/preview',           verifyToken, puede, c.preview);
router.post('/:id/enviar',           verifyToken, puede, c.enviar);
router.post('/:id/recalcular',       verifyToken, puede, c.recalcularConversion);
router.get('/:id/resultados',        verifyToken, puede, c.resultados);
router.get('/:id/destinatarios',     verifyToken, puede, c.destinatarios);
router.post('/:id/analizar-ia',      verifyToken, puede, c.analizarIA);
router.post('/:id/excluir-riesgo',   verifyToken, puede, c.excluirRiesgo);
router.post('/:id/analizar-politica',    verifyToken, puede, c.analizarPolitica);
router.post('/:id/excluir-politica',     verifyToken, puede, c.excluirPolitica);
router.post('/:id/enriquecer-contactos', verifyToken, puede, c.enriquecerContactos);
router.get('/:id/contactos-pendientes',  verifyToken, puede, c.contactosPendientes);
router.post('/:id/asignar-contacto',     verifyToken, puede, c.asignarContacto);

module.exports = router;
