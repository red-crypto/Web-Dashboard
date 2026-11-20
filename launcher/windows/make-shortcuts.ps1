# Creates/removes the "My Dashboard" shortcuts. Called by install.bat / uninstall.bat.
param([string]$Mode = "install", [switch]$Autostart)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here "..\..")).Path
$vbs = Join-Path $here "start-hidden.vbs"
$desktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "My Dashboard.lnk"
$startupLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "My Dashboard (auto start).lnk"
$shell = New-Object -ComObject WScript.Shell

function New-Link($path, $arguments) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $s.Arguments = "`"$vbs`" $arguments"
  $s.WorkingDirectory = $root
  $s.IconLocation = (Join-Path $here "dashboard.ico")
  $s.Description = "My Dashboard"
  $s.Save()
}

if ($Mode -eq "install") {
  New-Link $desktopLnk "--open"
  Write-Output "DESKTOP_OK"
  if ($Autostart) { New-Link $startupLnk ""; Write-Output "STARTUP_OK" }
} else {
  foreach ($p in @($desktopLnk, $startupLnk)) { if (Test-Path $p) { Remove-Item $p } }
  Write-Output "REMOVED"
}
