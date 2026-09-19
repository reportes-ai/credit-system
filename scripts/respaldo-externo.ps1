# respaldo-externo.ps1 — Respaldo completo al disco externo (D:\RESPALDO_AUTOFACIL\<fecha>)
#
# Qué respalda (todo lo que SOLO vive en este laptop):
#   1. codigo\        credit-system: bundle git (todo el historial) + zip del árbol sin node_modules/.git
#   2. credenciales\  .env local (JWT local, credenciales de desarrollo)
#   3. base-datos\    mysqldump de la BD del .env (si mysqldump está instalado; mismos flags que backup-bd.yml)
#   4. memoria-claude\ la memoria persistente de Claude Code (no la respalda nadie más)
#   5. proyectos\     parques-automotrices, remu-system, comunidad-app, comunidad-demo, _informe_build, respaldos-bd
#   6. documentacion\ la carpeta DOCUMENTACION de OneDrive (manuales Word) — el resto de OneDrive ya vive en la nube
#   7. INSTRUCCIONES_RESTAURACION.md + MANIFIESTO.txt (archivos, tamaños, SHA-256)
#
# Lo que NO hace falta respaldar acá: GitHub (código), TiDB + GitHub Actions (dump nocturno 30 días),
# Render (secretos de producción), OneDrive (documentos).
#
# Uso:   pwsh -File scripts\respaldo-externo.ps1            (con el disco D: conectado)
#        pwsh -File scripts\respaldo-externo.ps1 -Destino E:\RESPALDO_AUTOFACIL
# Nunca borra respaldos anteriores (cada corrida es una carpeta nueva con la fecha).

param(
  [string]$Destino = 'D:\RESPALDO_AUTOFACIL',
  [string]$Repo    = 'C:\Users\patri\Documents\credit-system'
)
$ErrorActionPreference = 'Stop'
$fecha = Get-Date -Format 'yyyy-MM-dd'
$raiz  = Split-Path $Destino -Qualifier
if (-not (Test-Path $raiz)) { throw "El disco $raiz no está conectado. Conecta el SSD externo y vuelve a correr." }
$dest = Join-Path $Destino $fecha
if (Test-Path $dest) { $dest = Join-Path $Destino ("{0}_{1}" -f $fecha, (Get-Date -Format 'HHmm')) }
New-Item -ItemType Directory -Force $dest | Out-Null
$log = @()
function Paso($t) { $script:log += "[$(Get-Date -Format 'HH:mm:ss')] $t"; Write-Host $t }

# Copia un directorio a un zip excluyendo node_modules / .git (vía staging con robocopy)
function ZipSinBasura($origen, $zip) {
  $stage = Join-Path $env:TEMP ("bk_" + [IO.Path]::GetRandomFileName())
  robocopy $origen $stage /E /XD node_modules .git .next dist /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  Remove-Item $stage -Recurse -Force
}

# 1. Código
$dc = Join-Path $dest 'codigo'; New-Item -ItemType Directory -Force $dc | Out-Null
Paso "Bundle git de credit-system (todo el historial)…"
git -C $Repo bundle create (Join-Path $dc 'credit-system.bundle') --all 2>&1 | Out-Null
$commit = git -C $Repo rev-parse --short HEAD
$pend   = (git -C $Repo status --porcelain | Measure-Object).Count
Paso "  HEAD $commit · $pend archivo(s) sin commitear"
Paso "Zip del árbol de trabajo (sin node_modules/.git)…"
ZipSinBasura $Repo (Join-Path $dc 'credit-system-codigo.zip')

# 2. Credenciales
$dcr = Join-Path $dest 'credenciales'; New-Item -ItemType Directory -Force $dcr | Out-Null
Copy-Item (Join-Path $Repo '.env') (Join-Path $dcr '.env') -Force
Copy-Item (Join-Path $Repo '.env') (Join-Path $dcr 'env-COPIA-VISIBLE.txt') -Force
Paso "Credenciales: .env copiado (OJO: el disco no está cifrado)"

# 3. Base de datos
$db = Join-Path $dest 'base-datos'; New-Item -ItemType Directory -Force $db | Out-Null
$md = Get-ChildItem 'C:\Program Files\MySQL' -Recurse -Filter mysqldump.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($md) {
  $env_ = @{}; Get-Content (Join-Path $Repo '.env') | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } | ForEach-Object { $env_[$Matches[1]] = $Matches[2].Trim().Trim('"') }
  $sql = Join-Path $db ("{0}_{1}.sql" -f $env_['DB_NAME'], $fecha)
  Paso "mysqldump de $($env_['DB_NAME'])@$($env_['DB_HOST'])…"
  $env:MYSQL_PWD = $env_['DB_PASSWORD']
  & $md.FullName -h $env_['DB_HOST'] -P ($env_['DB_PORT'] ?? '4000') -u $env_['DB_USER'] `
      --ssl-mode=REQUIRED --skip-lock-tables --quick --no-tablespaces --set-gtid-purged=OFF --column-statistics=0 `
      --result-file=$sql $env_['DB_NAME']
  $env:MYSQL_PWD = $null
  if ((Get-Content $sql -Tail 1) -match 'Dump completed') {
    Compress-Archive -Path $sql -DestinationPath ($sql + '.zip') -CompressionLevel Optimal; Remove-Item $sql
    Paso "  dump completo: $([math]::Round((Get-Item ($sql + '.zip')).Length/1MB,1)) MB"
  } else { Paso "  ⚠ el dump NO terminó completo (revisar)" }
} else { Paso "mysqldump no encontrado: la BD queda respaldada por el GitHub Action backup-bd.yml (30 días)" }

# 4. Memoria de Claude
$mem = 'C:\Users\patri\.claude\projects\C--Users-patri-Documents-credit-system\memory'
if (Test-Path $mem) {
  Compress-Archive -Path (Join-Path $mem '*') -DestinationPath (Join-Path $dest 'memoria-claude.zip') -CompressionLevel Optimal
  Paso "Memoria de Claude: $((Get-ChildItem $mem -File).Count) archivos"
}

# 5. Otros proyectos sin remote
$dp = Join-Path $dest 'proyectos'; New-Item -ItemType Directory -Force $dp | Out-Null
foreach ($p in 'parques-automotrices','remu-system','comunidad-app','comunidad-demo','_informe_build','respaldos-bd') {
  $src = "C:\Users\patri\Documents\$p"
  if (Test-Path $src) { ZipSinBasura $src (Join-Path $dp "$p.zip"); Paso "Proyecto $p respaldado" }
}

# 6. Documentación (manuales Word)
$doc = 'C:\Users\patri\OneDrive\Documentos\01 AUTOFACIL\02 SOFTWARE PROPIO\01 BUSINESS SUITE\DOCUMENTACION'
if (Test-Path $doc) { Compress-Archive -Path (Join-Path $doc '*') -DestinationPath (Join-Path $dest 'documentacion.zip') -CompressionLevel Optimal; Paso "Documentación Word respaldada" }

# 7. Instrucciones + manifiesto
@"
# INSTRUCCIONES DE RESTAURACIÓN — respaldo del $fecha (commit $commit)

## Si murió el laptop
1. Instalar Git, Node 20+, PowerShell 7 y (opcional) MySQL 8.4 (por mysqldump/mysql).
2. Código: ``git clone https://github.com/reportes-ai/credit-system.git`` (GitHub es la fuente).
   Sin internet o sin GitHub: ``git clone codigo\credit-system.bundle credit-system``.
   El zip codigo\credit-system-codigo.zip es el árbol de trabajo tal cual (incluye lo no commiteado).
3. Copiar credenciales\.env a la raíz del repo. Luego ``npm install`` y ``MOTORES=off npm start``.
   NUNCA levantar el servidor local con motores contra la base de producción.
4. Base de datos: producción sigue viva en TiDB Cloud; no hay que restaurar nada.
   Si hubiera que reconstruirla: base-datos\*.sql.zip (o el artefacto del GitHub Action backup-bd.yml, 30 días;
   los documentos viven en el bucket gs://autofacil-docs, no en el dump).
5. Memoria de Claude Code: descomprimir memoria-claude.zip en
   C:\Users\<usuario>\.claude\projects\C--Users-<usuario>-Documents-credit-system\memory\
6. Otros proyectos: proyectos\*.zip → C:\Users\<usuario>\Documents\<nombre>\ (npm install en cada uno).
7. Documentación: documentacion.zip (también está en OneDrive → 01 AUTOFACIL).
8. Secretos de producción (SMTP, DealerNet, SimpleAPI, Workera, CMF, JWT prod): SOLO en Render → Environment. No están acá.

## Para volver a respaldar
``pwsh -File scripts\respaldo-externo.ps1`` con el disco conectado. Cada corrida crea una carpeta nueva; no borra las anteriores.
"@ | Set-Content (Join-Path $dest 'INSTRUCCIONES_RESTAURACION.md') -Encoding UTF8

$man = Get-ChildItem $dest -Recurse -File | ForEach-Object {
  "{0,-60} {1,10:N1} MB  {2}" -f $_.FullName.Replace($dest + '\',''), ($_.Length/1MB), (Get-FileHash $_.FullName -Algorithm SHA256).Hash
}
(@("RESPALDO $fecha · HEAD $commit · generado $(Get-Date)", '') + $man + @('', '--- LOG ---') + $log) | Set-Content (Join-Path $dest 'MANIFIESTO.txt') -Encoding UTF8
$tot = [math]::Round((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum/1MB,1)
Paso "LISTO: $dest ($tot MB)"
