# Almacén de Documentos — los archivos viven en Google, no en la base

> **Motor único:** `shared/almacen-docs.js` · **Bucket:** `gs://autofacil-docs` (us-east4)
> **Barrido:** `scripts/migrar-docs-bucket.js` · **Verificación:** `/api/health → documentos`

---

## 1. Qué problema resuelve

Hasta agosto de 2026 cada archivo que subía un usuario se guardaba **dentro de la base
de datos**, en una columna `LONGBLOB`. La medición del 04-08-2026 mostró lo que eso
significaba:

| Qué | Peso | Archivos |
|---|---:|---:|
| `fundantes_seg_docs` | 63,9 MB | 62 |
| `dealer_fichas` (ficha firmada) | 16,0 MB | 19 |
| `dealer_ficha_archivos` (informes comerciales) | 15,6 MB | 33 |
| `cartas_documentos` | 10,5 MB | 161 |
| `credito_documentos` | 4,6 MB | 12 |
| `evaluacion_documentos` | 2,3 MB | 6 |
| **Documentos** | **112,9 MB** | **293** |
| **Toda la operación del negocio** (17.932 créditos, 18.634 clientes, contabilidad completa) | **~6 MB** | — |

**Los documentos eran el 95% de la base.** Tres consecuencias concretas:

1. **TiDB cobra por almacenamiento Y por consulta.** Un PDF de 2 MB dentro de una fila
   encarece cada lectura de esa tabla, se use el archivo o no.
2. **El respaldo nocturno arrastra todo.** Pasó de 38 MB (20-jul) a 118,8 MB (04-ago) en
   quince días, y se conservan 30 copias.
3. **La trayectoria.** 293 archivos hoy, pero Fundantes tiene **4.940 operaciones** en
   seguimiento. El destino era multi-GB dentro de la base.

> **Nota sobre base64:** los archivos se guardaban en binario, no en base64. El base64
> es solo el transporte del navegador al servidor. No había inflado del 33%: los 63,9 MB
> de fundantes eran bytes reales.

---

## 2. La regla

**El archivo vive en el bucket; la base guarda solo la referencia.**

Cada tabla de documentos tiene tres columnas nuevas:

| Columna | Qué guarda |
|---|---|
| `doc_storage` | `'gcs'` o `'db'` |
| `doc_ruta` | ruta del objeto dentro del bucket |
| `doc_bytes` | tamaño, para informar sin ir a buscarlo |

**El bucket NO es disco de servidor.** Esa distinción es la lección de los informes
DealerNet (§11-ter del runbook): el disco de Render se borra en cada despliegue y no lo
ve el host de contingencia. El bucket es almacenamiento de objetos, alcanzable por igual
desde Render, desde Cloud Run y desde un computador cualquiera con credenciales.

---

## 3. Por qué un motor y no seis migraciones

Son siete tablas con el mismo problema. Si cada controlador resolviera su subida y su
descarga por su cuenta terminaríamos con siete criterios de nombre de ruta, siete manejos
de error y siete lugares donde arreglar el próximo bug. (Máxima 1: un solo motor por
cálculo.)

```js
const almacen = require('shared/almacen-docs');

// Subir: devuelve QUÉ escribir en la fila. El controlador no decide nada.
const d = await almacen.colocar({ ambito:'fundantes', clave: idCredito, buffer, mime, nombre });
//  → { storage:'gcs', ruta:'fundantes/123/20260804-carnet.pdf', blob:null, bytes }
//  → { storage:'db',  ruta:null, blob:<Buffer>, bytes }   (sin bucket, o si falló)

// Leer: no importa dónde viva.
const buf = await almacen.obtener({ ruta: fila.doc_ruta, blob: fila.archivo_data });

// Servir por HTTP con las cabeceras correctas, en una línea.
await almacen.servir(res, { ruta, blob, nombre, mime });

// Borrar el objeto (nunca lanza).
await almacen.borrar(fila.doc_ruta);
```

---

## 4. Las tres decisiones que hacen esto seguro

### 4.1 El blob manda mientras exista

`obtener()` mira **primero el blob** y solo va al bucket si la fila ya no lo tiene.

Esto elimina una trampa de orden que era fácil de pisar: si se marcan filas como
migradas en un servidor que todavía no alcanza el bucket, esos documentos quedarían
inaccesibles. Con el blob primero, **el orden de los pasos deja de importar**. El bucket
recién pasa a ser la única fuente cuando el blob se suelta, que es un paso aparte y
deliberado.

### 4.2 Una subida nunca se cae por el bucket

Si `colocar()` no puede subir, devuelve el blob y el archivo se guarda en la base, con
aviso en el log. El barrido posterior lo recoge. **Un documento mal ubicado es mucho
menos grave que un documento perdido.** (Mismo principio que la contabilidad: el motor
no bloquea la operación.)

### 4.3 El objeto viejo se borra DESPUÉS, y la ruta se captura ANTES

En cada reemplazo el patrón es idéntico:

1. leer `doc_ruta` **antes** del `DELETE`/`UPDATE` — después de borrar la fila ya no hay
   forma de saber qué objeto quedó huérfano;
2. escribir la fila apuntando al archivo nuevo;
3. recién ahí borrar el objeto anterior.

Si el paso 3 falla, lo peor que queda es un objeto de más. Nunca un documento sin archivo.

---

## 5. Infraestructura

| | |
|---|---|
| Bucket | `gs://autofacil-docs` · **us-east4** (junto a la app y a TiDB, como Render en Virginia) |
| Clase | Standard · acceso público **bloqueado** · acceso uniforme |
| Versionado | **activado el 05-08-2026** — un borrado por error se puede revertir. Antes de esa fecha NO lo estaba, aunque este mismo documento decía que sí: lo único que había era el *soft delete* de 7 días que Google pone por defecto |
| Costo | ~US$0,026/GB/mes → **centavos** al volumen actual |
| Cuenta de servicio | `afbs-docs@autofacil-bs.iam.gserviceaccount.com` — `objectAdmin` **solo sobre este bucket** |

### El respaldo de los documentos es un paso aparte

**El `mysqldump` nocturno ya no los contiene.** Es la consecuencia menos obvia de sacar los
archivos de la base: el respaldo siguió corriendo igual, verde, y dejó de cubrir el 95% de
lo que cubría — sin avisar. Un respaldo que se achica solo es peor que no tenerlo, porque
nadie lo mira.

| | |
|---|---|
| Destino | `gs://autofacil-docs-respaldo` · **southamerica-west1** (otra región que el origen) |
| Clase | Nearline · versionado activo · **sin regla de borrado** |
| Cuándo | en el mismo workflow nocturno, después del dump (`.github/workflows/backup-bd.yml`) |
| Cuenta | `github-backup-uploader@` — `objectViewer` en el origen, `objectAdmin` en el destino |

**Por qué `objectViewer` y no `objectAdmin` en el origen:** el proceso de respaldo no tiene
ninguna razón para poder modificar los documentos vivos. Si algo sale mal ahí, que salga
mal en dirección inofensiva.

**Y por qué un bucket propio y no el de los dumps:** `autofacil-respaldos-bd` borra a los 90
días por regla de ciclo de vida. Un documento que lleve tres meses sin cambiar sería
borrado por esa regla, y `rsync` **no lo repondría** —en el origen no cambió nada—, así que
desaparecería del respaldo en silencio.

El paso imprime `documentos: origen=N respaldo=N` al terminar. Si el respaldo tiene menos
archivos que el origen, avisa en el log.

#### Y una tercera copia FUERA de Google

Las dos de arriba **viven en la misma cuenta de Google**. Eso cubre un borrado por error,
un archivo corrupto o la caída de una región; **no cubre perder la cuenta** —suspensión,
factura impaga, acceso comprometido— y ahí se irían las dos juntas.

`.github/workflows/backup-docs-github.yml` empaqueta el bucket y lo deja como artefacto
privado del repositorio: **domingos 03:30, retención 7 días**. Es semanal y no diario
porque son ~110 MB casi todo PDF (no comprimen): diario con 30 días serían ~3,3 GB, muy por
encima del medio giga gratis de un repositorio privado. Para lo único que esta copia cubre
—perder Google entero— una semana de atraso es aceptable, y las otras dos siguen siendo del
día.

**Aborta si no bajó ni un archivo.** Un `tar` de un directorio vacío pesa poco y se sube
feliz: sin esa comparación, una falla de la copia produciría un respaldo verde y hueco, que
es peor que no tenerlo.

**Restaurar**: descargar el artefacto, descomprimir y
`gsutil -m rsync -r ./documentos gs://autofacil-docs`. La estructura de carpetas del
paquete **es** la del bucket, así que las rutas guardadas en `doc_ruta` siguen calzando sin
tocar la base.

Con esto los documentos tienen las mismas tres patas que la base de datos: el original, una
copia en otra región y una copia en otro proveedor.

**Autenticación, en este orden:**

1. `GCS_CREDENCIALES` — el JSON de la cuenta de servicio en una variable de entorno.
   Es lo que necesita **Render**, que vive fuera de Google.
2. Credenciales del ambiente (ADC) — en **Cloud Run** la identidad del servicio alcanza
   sola: sin llave que rotar y sin llave que se pueda filtrar.

**Variables:**

```
GCS_BUCKET=autofacil-docs
GCS_PROYECTO=autofacil-bs
GCS_CREDENCIALES=<JSON en una línea>     ← solo Render
```

**Sin `GCS_BUCKET` el sistema funciona igual que siempre**, guardando en la base. Eso es
deliberado: local, staging y el host de contingencia siguen enteros aunque no se les
carguen credenciales.

---

## 6. Cómo migrar los archivos que ya estaban en la base

```bash
node scripts/migrar-docs-bucket.js                    # informe, no mueve nada
node scripts/migrar-docs-bucket.js fundantes          # copia una tabla
node scripts/migrar-docs-bucket.js todo               # copia todas
node scripts/migrar-docs-bucket.js todo --soltar-blob # copia Y libera, en un solo paso
```

Para cada archivo: **1)** se sube, **2)** se verifica que arriba pese lo mismo, **3)**
recién entonces la fila apunta al bucket. Si el proceso se corta en cualquier punto el
documento sigue siendo legible. Es **re-ejecutable**: solo toma filas con blob y sin
`doc_ruta`.

Copiar **no** libera espacio: el archivo queda en los dos lados y basta borrar `doc_ruta`
para volver atrás. Soltar los blobs es un paso aparte y sin retorno.

### Soltar los blobs: `scripts/soltar-blobs-migrados.js`

```bash
node scripts/soltar-blobs-migrados.js              # informe, no borra nada
node scripts/soltar-blobs-migrados.js todo --si    # libera (el --si es a propósito)
```

**Por qué un script propio y no `--soltar-blob`.** Esa bandera suelta el blob *en el mismo
momento de subirlo*, y su SELECT solo alcanza filas con `doc_ruta IS NULL`. Las filas ya
migradas quedan fuera de ese filtro para siempre: correrla después no libera un solo byte.
El caso normal —migrar primero, verificar durante días, soltar después— necesita este
barrido distinto.

Fila por fila, antes de borrar: baja el objeto del bucket, compara el **tamaño** y compara
el **SHA-256**. Los tres tienen que coincidir. Que `doc_ruta` esté escrito no prueba nada
—prueba que alguien dijo que subió, no que el archivo esté arriba y entero—. Lo que no
coincide conserva su blob y queda marcado `!revisar:` en `doc_ruta` para que salte a la
vista y no se relea en un ciclo infinito.

**Antes de soltar, verificar que TODOS los hosts alcanzan el bucket:**

```
/api/health → "documentos": { "activo": true, "bucket": "autofacil-docs" }
```

en producción **y** en `afbs2.autofacilchile.cl`. Si un host no lo alcanza, para ese host
los documentos migrados dejan de existir.

**Y verificar leyendo de verdad, no por checksum.** El checksum prueba que los bytes están
arriba; no prueba que la aplicación sepa ir a buscarlos, porque mientras el blob exista
todo lo lee del blob. Hay que abrir un documento de cada pantalla —con el blob ya en NULL—
antes de soltar el resto.

---

## 7. Qué falta

- ~~Soltar los blobs~~ ✅ **cerrado el 05-08-2026.** Antes se probó **abriendo un documento
  real de cada pantalla** con su blob ya en NULL —fundantes, cartas, ficha de dealer,
  informe comercial, respaldo de crédito y evaluación—, que es la única prueba de que la
  aplicación sabe leer del bucket. Recién ahí se soltaron los **287** restantes: los 287
  coincidieron en tamaño y SHA-256, cero conservados. **La base pasó de 118 MB a 44,4 MB**
  y ninguna tabla de documentos aparece ya entre las más grandes; el respaldo nocturno
  pesa menos de la mitad.
- ~~Tablas chicas todavía no cableadas~~ ✅ **cerrado el 04-08-2026.** Al revisarlas una a
  una resultó que **estaban todas vacías**: existían pero no tenían ni un archivo. Así que
  no había nada que migrar, solo que cablear para que el primero que suban ya vaya al
  bucket. Quedaron listas `fundantes_brokerage`, `facturas_brokerage`, `rh_documentos`,
  `dealer_liquidez_documentos`, `ar_adjuntos` (Atención Remota) e `informes_dealernet`.
  `rh_documentos` necesitó además un `MODIFY` porque su blob nació `NOT NULL` y una fila
  cuyo archivo vive en el bucket tiene que poder soltar sus bytes.
- **Lo que NO es documento y también pesa**: `dealernet_consultas.output_raw` (3,3 MB de
  respuestas crudas) y `op_correlativos.snapshot_json` (1,3 MB en 10.709 filas). Eso no
  va al bucket — se purga o se acota, que es otra decisión.
