<#
  Garbage Collector — read-only activity collector.

  Emits redacted NDJSON lines {"t":<unix ms>,"src":"<source>","text":"..."} to
      %APPDATA%\wallpaper-engine-clone\gc-feed.ndjson
  which the wallpaper tails through the host bridge (gc:pull).

  READ-ONLY. It never opens, writes, injects into, suspends or modifies any other
  process. It only reads activity Windows already exposes:
    proc  new process command lines        (CIM Win32_Process, polled + diffed)
    net   new outbound TCP endpoints        (Get-NetTCPConnection, diffed)
    dns   resolver cache entries            (Get-DnsClientCache, diffed)
    hist  your terminal history             (PSReadLine history file, tailed)
    ps    PowerShell script blocks          (PowerShell/Operational 4104)
    file  file creates      \
    reg   registry writes    |  from Sysmon/Operational IF Sysmon is installed
    dll   image (DLL) loads   |  (setup -Deep). Skipped silently if absent.
    net2  Sysmon network     /

  Secrets (tokens, passwords, key=value, long hex/base64) and your username are
  masked before anything is written. Live symbolized call stacks and any reading
  of other processes' memory are intentionally NOT collected.
#>

param(
  [string]$FeedPath = (Join-Path $env:APPDATA 'wallpaper-engine-clone\gc-feed.ndjson'),
  [int]$MaxLines = 6000,           # feed file is trimmed to this
  [int]$MaxLineChars = 200
)

$ErrorActionPreference = 'SilentlyContinue'
$feedDir = Split-Path -Parent $FeedPath
if (-not (Test-Path $feedDir)) { New-Item -ItemType Directory -Force -Path $feedDir | Out-Null }

# never-touch / ignore list (image names we never emit, e.g. security tooling)
$IGNORE = @('lsass.exe','vgc.exe','vgtray.exe','vanguard','easyanticheat','battleye','beservice.exe')

# ---- redaction ------------------------------------------------------------
$UserName = [Regex]::Escape($env:USERNAME)
$UserProf = if ($env:USERPROFILE) { [Regex]::Escape($env:USERPROFILE) } else { 'x' }
function Redact([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  $s = $s -replace $UserProf, '~'
  $s = $s -replace "(?i)\b$UserName\b", '~'
  $s = $s -replace '(?i)\b(password|passwd|pwd|token|secret|apikey|api[_-]?key|bearer|authorization|client[_-]?secret)\b(\s*[:=]\s*)\S+', '$1$2****'
  $s = $s -replace '\b[A-Fa-f0-9]{24,}\b', '····'          # long hex
  $s = $s -replace '\b[A-Za-z0-9+/_-]{28,}\b', '····'      # token / base64 shaped
  if ($s.Length -gt $MaxLineChars) { $s = $s.Substring(0, $MaxLineChars) }
  return $s.Trim()
}

# ---- buffered writer ------------------------------------------------------
$script:buf = New-Object System.Collections.Generic.List[string]
function Emit([string]$src, [string]$text) {
  $t = Redact $text
  if ($t.Length -lt 2) { return }
  foreach ($ig in $IGNORE) { if ($t.ToLower().Contains($ig)) { return } }
  $t = $t -replace '\\','/'
  $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $obj = [ordered]@{ t = $ms; src = $src; text = $t }
  $script:buf.Add(($obj | ConvertTo-Json -Compress))
}
function Flush() {
  if ($script:buf.Count -eq 0) { return }
  try { Add-Content -Path $FeedPath -Value $script:buf -Encoding UTF8 } catch {}
  $script:buf.Clear()
}
function Trim() {
  try {
    if (-not (Test-Path $FeedPath)) { return }
    $lines = Get-Content -Path $FeedPath -ErrorAction Stop
    if ($lines.Count -gt $MaxLines) {
      $keep = $lines[($lines.Count - [int]($MaxLines * 0.7))..($lines.Count - 1)]
      Set-Content -Path $FeedPath -Value $keep -Encoding UTF8
    }
  } catch {}
}

# ---- source state ---------------------------------------------------------
$seenPid  = New-Object System.Collections.Generic.HashSet[int]
$seenNet  = New-Object System.Collections.Generic.HashSet[string]
$seenDns  = New-Object System.Collections.Generic.HashSet[string]
$histPath = (Get-PSReadLineOption).HistorySavePath
if (-not $histPath) { $histPath = Join-Path $env:APPDATA 'Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt' }
$histLen  = 0
$psLastRec = 0
$symLastRec = 0
$sysmonLog = 'Microsoft-Windows-Sysmon/Operational'
$haveSysmon = $false
try { if (Get-WinEvent -ListLog $sysmonLog -ErrorAction Stop) { $haveSysmon = $true } } catch {}

# seed process set so we only emit NEW processes
try { Get-CimInstance Win32_Process | ForEach-Object { [void]$seenPid.Add([int]$_.ProcessId) } } catch {}

function Poll-Proc() {
  try {
    foreach ($p in Get-CimInstance Win32_Process) {
      $id = [int]$p.ProcessId
      if ($seenPid.Add($id)) {
        $cmd = if ($p.CommandLine) { $p.CommandLine } else { $p.Name }
        Emit 'proc' $cmd
      }
    }
    if ($seenPid.Count -gt 4000) { $seenPid.Clear() }  # bound memory; reseeds naturally
  } catch {}
}
function Poll-Net() {
  try {
    foreach ($c in Get-NetTCPConnection -State Established,SynSent -ErrorAction SilentlyContinue) {
      $ra = "$($c.RemoteAddress)"
      if ($ra -in '0.0.0.0','::','127.0.0.1','::1' -or $ra.StartsWith('127.') -or $ra.StartsWith('::1')) { continue }
      $key = "$ra`:$($c.RemotePort)"
      if ($seenNet.Add($key)) { Emit 'net' "TCP $key" }
    }
    if ($seenNet.Count -gt 3000) { $seenNet.Clear() }
  } catch {}
}
function Poll-Dns() {
  try {
    foreach ($e in Get-DnsClientCache -ErrorAction SilentlyContinue) {
      $n = "$($e.Entry)"
      if ($n -and $seenDns.Add($n.ToLower())) { Emit 'dns' $n }
    }
    if ($seenDns.Count -gt 3000) { $seenDns.Clear() }
  } catch {}
}
function Poll-Hist() {
  try {
    if (-not (Test-Path $histPath)) { return }
    $all = Get-Content -Path $histPath -ErrorAction Stop
    if ($all.Count -gt $histLen) {
      for ($i = $histLen; $i -lt $all.Count; $i++) { Emit 'hist' $all[$i] }
      $script:histLen = $all.Count
    } elseif ($all.Count -lt $histLen) { $script:histLen = $all.Count }  # file rotated
  } catch {}
}
function Poll-Ps() {
  try {
    $evs = Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-PowerShell/Operational'; Id=4104 } -MaxEvents 40 -ErrorAction Stop
    foreach ($e in ($evs | Sort-Object RecordId)) {
      if ([int]$e.RecordId -le $psLastRec) { continue }
      $script:psLastRec = [int]$e.RecordId
      $txt = ($e.Message -split "`n" | Select-Object -First 1)
      if ($txt) { Emit 'ps' $txt }
    }
  } catch {}
}
function Poll-Sysmon() {
  if (-not $haveSysmon) { return }
  try {
    $evs = Get-WinEvent -FilterHashtable @{ LogName=$sysmonLog } -MaxEvents 120 -ErrorAction Stop
    foreach ($e in ($evs | Sort-Object RecordId)) {
      if ([int]$e.RecordId -le $symLastRec) { continue }
      $script:symLastRec = [int]$e.RecordId
      $x = [xml]$e.ToXml(); $d = @{}
      foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
      switch ([int]$e.Id) {
        7  { Emit 'dll'  $d['ImageLoaded'] }
        11 { Emit 'file' $d['TargetFilename'] }
        12 { Emit 'reg'  $d['TargetObject'] }
        13 { Emit 'reg'  $d['TargetObject'] }
        14 { Emit 'reg'  $d['TargetObject'] }
        22 { Emit 'dns'  $d['QueryName'] }
        3  { Emit 'net'  ("$($d['DestinationIp']):$($d['DestinationPort'])") }
        1  { Emit 'proc' $d['CommandLine'] }
        default {}
      }
    }
  } catch {}
}

# ---- main loop ------------------------------------------------------------
Emit 'proc' "GARBAGE COLLECTOR ONLINE — READ ONLY — SYSMON=$haveSysmon"
$tick = 0
while ($true) {
  try {
    Poll-Hist
    Poll-Ps
    if ($tick % 2 -eq 0) { Poll-Proc }        # ~2s
    if ($tick % 3 -eq 0) { Poll-Net; Poll-Dns } # ~3s
    Poll-Sysmon                                # as fast as it logs
    Flush
    if ($tick % 20 -eq 0) { Trim }             # ~20s
  } catch {}
  Start-Sleep -Milliseconds 1000
  $tick++
}
