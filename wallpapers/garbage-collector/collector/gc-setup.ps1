<#
  Garbage Collector — setup / teardown for the read-only collector.

  Usage (right-click > Run with PowerShell, or from an elevated prompt):
    .\gc-setup.ps1                 # install: register a hidden logon task (admin)
    .\gc-setup.ps1 -EnablePsLog    # also turn on PowerShell script-block logging
    .\gc-setup.ps1 -Deep           # also install Sysmon for file/registry/DLL sources
    .\gc-setup.ps1 -Status         # show task state + tail the feed
    .\gc-setup.ps1 -Uninstall      # remove task (and Sysmon if -Deep given too)

  The task runs gc-collector.ps1 at logon, hidden, elevated. Everything it does
  is read-only. Re-run any time; it is idempotent.
#>
param(
  [switch]$Deep,
  [switch]$EnablePsLog,
  [switch]$Status,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName  = 'GarbageCollectorFeed'
$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$Collector = Join-Path $Here 'gc-collector.ps1'
$FeedPath  = Join-Path $env:APPDATA 'wallpaper-engine-clone\gc-feed.ndjson'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $pr.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host 'Elevating…' -ForegroundColor Yellow
    $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
    if ($Deep)        { $argList += '-Deep' }
    if ($EnablePsLog) { $argList += '-EnablePsLog' }
    if ($Status)      { $argList += '-Status' }
    if ($Uninstall)   { $argList += '-Uninstall' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
    exit
  }
}

function Show-Status {
  Write-Host "Task '$TaskName':" -ForegroundColor Cyan
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) { $t | Get-ScheduledTaskInfo | Format-List State, LastRunTime, LastTaskResult, NextRunTime }
  else { Write-Host '  not installed' -ForegroundColor Yellow }
  Write-Host "Feed: $FeedPath"
  if (Test-Path $FeedPath) {
    $c = (Get-Content $FeedPath -ErrorAction SilentlyContinue)
    Write-Host ("  lines: {0}" -f $c.Count)
    Write-Host '  last 8:' -ForegroundColor Cyan
    $c | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" }
  } else { Write-Host '  (no feed yet — start the task or wait a few seconds)' }
}

function Install-Task {
  if (-not (Test-Path $Collector)) { throw "collector not found at $Collector" }
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Collector`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $princ   = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $princ -Settings $set -Force | Out-Null
  Write-Host "Registered logon task '$TaskName'." -ForegroundColor Green
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Started it now. The feed should begin filling within a few seconds.' -ForegroundColor Green
}

function Enable-PsLogging {
  $key = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging'
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name 'EnableScriptBlockLogging' -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Host 'Enabled PowerShell script-block logging (source: ps).' -ForegroundColor Green
}

function Install-Sysmon {
  # Deep sources (file/registry/DLL). Sysmon is Microsoft Sysinternals, read-only.
  $tmp = Join-Path $env:TEMP 'gc-sysmon'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'Sysmon.zip'
  Write-Host 'Downloading Sysmon (Sysinternals)…' -ForegroundColor Yellow
  Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/Sysmon.zip' -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $cfg = Join-Path $Here 'gc-sysmon.xml'
  $exe = Join-Path $tmp 'Sysmon64.exe'
  if (-not (Test-Path $exe)) { $exe = Join-Path $tmp 'Sysmon.exe' }
  Write-Host 'Installing Sysmon with the Garbage Collector config…' -ForegroundColor Yellow
  & $exe -accepteula -i $cfg
  Write-Host 'Sysmon installed. Deep sources (file/reg/dll) are now live.' -ForegroundColor Green
}

# ---------------------------------------------------------------- main
Assert-Admin

if ($Status)    { Show-Status; return }
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task '$TaskName'." -ForegroundColor Green
  if ($Deep) { try { & (Join-Path $env:TEMP 'gc-sysmon\Sysmon64.exe') -u; Write-Host 'Uninstalled Sysmon.' } catch { Write-Host 'Sysmon: run "Sysmon64 -u" manually to remove.' -ForegroundColor Yellow } }
  Write-Host "Feed file left in place: $FeedPath (delete it yourself if you want)."
  return
}

Install-Task
if ($EnablePsLog) { Enable-PsLogging }
if ($Deep) {
  try { Install-Sysmon } catch { Write-Host "Sysmon step failed: $($_.Exception.Message)" -ForegroundColor Red; Write-Host 'The light sources (proc/net/dns/hist/ps) still work without it.' -ForegroundColor Yellow }
}
Write-Host ''
Write-Host 'Done. Restart the wallpaper app so it picks up the feed bridge, then switch to Garbage Collector.' -ForegroundColor Cyan
Write-Host 'Check anytime with:  .\gc-setup.ps1 -Status'
