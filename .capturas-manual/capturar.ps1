# Captura la ventana de Chrome (AutoFácil) al frente y la guarda como PNG.
# Uso: powershell -File capturar.ps1 -Nombre "01-estado-creditos"
param([Parameter(Mandatory=$true)][string]$Nombre)

Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public struct R { public int L, T, Rt, B; }
}
'@
$chrome = Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -match 'AutoF' } | Select-Object -First 1
if (-not $chrome) { Write-Output 'NO CHROME'; exit 1 }
[W]::ShowWindow($chrome.MainWindowHandle, 3) | Out-Null      # maximizar
[W]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900
$r = New-Object W+R
[W]::GetWindowRect($chrome.MainWindowHandle, [ref]$r) | Out-Null
# recortar el marco invisible (8 px) y la barra del navegador (tabs+URL+marcadores ~110 px)
$margen = 8; $arriba = 110
$x = $r.L + $margen; $y = $r.T + $margen + $arriba
$w = ($r.Rt - $r.L) - 2*$margen; $h = ($r.B - $r.T) - 2*$margen - $arriba
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$out = "C:\Users\patri\Documents\credit-system\.capturas-manual\$Nombre.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "OK -> $out (${w}x${h})"
