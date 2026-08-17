# Certificado digital del SII — rescate, respaldo y carga

> El certificado es el único activo del sistema que no se reemite gratis: se compra,
> tiene vigencia y reponerlo toma días. Regla permanente: **el archivo .pfx y su clave
> viven SEPARADOS** (pendrive/caja fuerte vs gestor de contraseñas).

## Dónde vive

- **Producción**: Render → Environment → `SII_CERT_B64` (el .pfx convertido a base64) + `SII_CERT_PASS` (su clave).
- **Diagnóstico**: Contabilidad → Libros Auxiliares → banner "Diagnóstico del certificado" (muestra bytes, RUT empresa, usuario SII y titular; distingue "el .pfx está bien pero la clave no" de un archivo corrupto).

## Rescatar el .pfx desde un PC donde el certificado funciona (certmgr)

1. `Win + R` → `certmgr.msc` → **Personal → Certificados**.
2. Clic derecho sobre el certificado del titular → **Todas las tareas → Exportar…**
3. **"Sí, exportar la clave privada"** — si sale deshabilitado, el certificado se instaló
   como NO exportable y esta vía no sirve (ver alternativas abajo).
4. Formato **PKCS #12 (.PFX)**, incluir la cadena, NO eliminar la clave privada.
5. La contraseña del asistente la eliges tú → esa exacta será `SII_CERT_PASS` (al gestor de contraseñas).
6. Convertir a base64 para Render:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\Downloads\certificado-sii.pfx")) | Set-Content "$env:USERPROFILE\Downloads\cert-base64.txt"
   ```
7. Render → `SII_CERT_B64` (el texto) + `SII_CERT_PASS` → redeploy → **Sincronizar SII (RCV)**.
8. Copia del .pfx al pendrive/caja fuerte y **borrar ambos archivos de Descargas**.

## Probar una clave SIN ciclos de redeploy

```powershell
$raw = (Get-Content "$env:USERPROFILE\Downloads\cert-base64.txt" -Raw) -replace '\s',''; [IO.File]::WriteAllBytes("$env:USERPROFILE\Downloads\certificado-sii.pfx", [Convert]::FromBase64String($raw)); $pass = Read-Host -AsSecureString "Clave del certificado"; try { $d = Get-PfxData -FilePath "$env:USERPROFILE\Downloads\certificado-sii.pfx" -Password $pass; "CLAVE CORRECTA — titular: $($d.EndEntityCertificates[0].Subject)" } catch { "CLAVE INCORRECTA" }
```

## Reconstruir el .pfx desde Render (respaldo de emergencia)

`scripts/extraer-cert-sii.js` — pegar el valor de `SII_CERT_B64` en `Downloads\sii-cert-b64.txt`
y correr el script (valida la firma PKCS#12 `30 82` antes de escribir). Sin repo ni Node, el
one-liner de PowerShell del punto anterior hace lo mismo.

## Si el export está bloqueado (clave privada no exportable)

1. **Re-descarga del proveedor** (E-Cert / E-Sign / Acepta): durante la vigencia, el titular
   entra al centro de descarga del emisor con su RUT + correo de compra y re-descarga el .pfx
   definiendo una clave nueva. Solo si fue emitido en modalidad re-descargable.
2. **Certificado nuevo**: se compra en el día (~$10-20 mil/año). No rescata el actual, pero
   elimina el problema de raíz con una clave conocida desde el día uno.

## Historia (para contexto)

- 12-08-2026: el RCV quedó cableado pero `SII_CERT_PASS` no correspondía a la clave real del
  .pfx cargado — nadie la conocía. El certificado funciona instalado en otro PC; el plan es
  exportarlo desde ahí con clave nueva (procedimiento de arriba).
