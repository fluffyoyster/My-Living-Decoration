# Garbage Collector — the collector

A small, **read-only** background program that scrapes live Windows activity and
writes it (with secrets masked) to a feed the wallpaper reads. It never opens,
writes to, injects into, suspends, or modifies any other process. It only reads
activity Windows already exposes.

## Install

Right-click `gc-setup.ps1` → **Run with PowerShell** (it will elevate itself), or
from an elevated PowerShell prompt:

```powershell
cd <this folder>
.\gc-setup.ps1                 # light sources, logon task
.\gc-setup.ps1 -EnablePsLog    # + PowerShell script-block source
.\gc-setup.ps1 -Deep           # + Sysmon for file / registry / DLL sources
```

Then **restart the wallpaper app** (so it loads the new feed bridge) and switch to
Garbage Collector. The feed begins filling within a few seconds; the wallpaper
looks alive immediately either way (it falls back to a synthetic feed until real
data arrives).

Check status / see the feed:

```powershell
.\gc-setup.ps1 -Status
```

Remove everything:

```powershell
.\gc-setup.ps1 -Uninstall            # add -Deep to also uninstall Sysmon
```

## Sources

| src   | what                              | how                                   | needs        |
|-------|-----------------------------------|---------------------------------------|--------------|
| proc  | new process command lines         | `Win32_Process`, polled + diffed      | —            |
| net   | new outbound TCP endpoints        | `Get-NetTCPConnection`, diffed        | —            |
| dns   | resolver cache entries            | `Get-DnsClientCache`, diffed          | —            |
| hist  | your terminal history             | PSReadLine history file, tailed       | —            |
| ps    | PowerShell script blocks          | PowerShell/Operational 4104           | `-EnablePsLog` |
| file  | file creates                      | Sysmon 11                             | `-Deep`      |
| reg   | registry writes                   | Sysmon 12/13/14                       | `-Deep`      |
| dll   | image / DLL loads                 | Sysmon 7                              | `-Deep`      |

The light sources (top five) run with zero extra install. The deep sources use
**Sysmon** (Microsoft Sysinternals) — a standard, read-only telemetry tool. Its
config is `gc-sysmon.xml`; tune the excludes there if a source floods or is quiet.

## Deliberately not collected

- **Live disassembly / reading other processes' memory** — dropped by design.
- **Symbolized call stacks** — would need always-on profiling + symbol resolution;
  deferred (the wallpaper keeps a `stack` colour slot for later).

## Redaction

Before anything is written, the collector masks: your username and profile path
(→ `~`), `key=value` secrets (password/token/apikey/bearer/…), and long
hex/base64-shaped tokens. The wallpaper also has a second display-side redaction
pass (on by default).

## Notes / tuning

- This Windows layer is the part most likely to need a little live tuning on your
  actual machine (event log availability, Sysmon volume). If a source is missing
  or too noisy, run `-Status`, look at the last lines, and adjust.
- Feed file: `%APPDATA%\wallpaper-engine-clone\gc-feed.ndjson`, auto-trimmed to
  ~6000 lines.
