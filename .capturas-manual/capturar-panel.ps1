# Captura la ventana de Claude (panel del navegador) y guarda PNG, con recorte opcional.
# Uso: powershell -File capturar-panel.ps1 -Nombre "01-x" [-X 690 -Y 115 -W 660 -H 610]
param(
  [Parameter(Mandatory=$true)][string]$Nombre,
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0
)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W3 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct R { public int L, T, Rt, B; }
}
'@
$c = Get-Process | Where-Object { $_.MainWindowTitle -match 'Claude' -and $_.MainWindowHandle -ne 0 } |
     Select-Object -First 1
if (-not $c) { Write-Output 'NO CLAUDE'; exit 1 }
[W3]::SetForegroundWindow($c.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
$r = New-Object W3+R
[W3]::GetWindowRect($c.MainWindowHandle, [ref]$r) | Out-Null
if ($W -eq 0) { $X = 0; $Y = 0; $W = $r.Rt - $r.L; $H = $r.B - $r.T }   # ventana completa
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L + $X, $r.T + $Y, 0, 0, $bmp.Size)
$out = "C:\Users\patri\Documents\credit-system\.capturas-manual\$Nombre.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "OK -> $out (${W}x${H})"
