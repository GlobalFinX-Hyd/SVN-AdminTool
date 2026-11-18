<#
.SYNOPSIS
    Installs (or updates) SvnAdmin as a Windows service on the SVN server.
.DESCRIPTION
    Run from an elevated PowerShell in the folder that holds SvnAdmin.Api.exe.
    - Creates the "SvnAdmin" service (automatic start, restarts on failure).
    - Runs it as the same account as Apache by default, because both need to
      read/write the passwd and authz files. Pass -Account to override.
    - Grants that account Modify on the SVN folders and the SvnAdmin data folder.
.PARAMETER Account
    Service account. Default: the account the Apache service runs as.
.EXAMPLE
    .\install-service.ps1
    .\install-service.ps1 -Account 'NT AUTHORITY\LocalService'
#>
param(
    [string]$Account,
    [string]$ApacheServiceName = 'Apache2.4',
    [string]$DataDir = 'C:\SvnAdmin\data',
    [string[]]$SvnDirs = @('C:\Subversion', 'C:\SvnAdmin\backups')
)
$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')) {
    throw 'Run this from an elevated (Administrator) PowerShell.'
}

$exe = Join-Path $PSScriptRoot 'SvnAdmin.Api.exe'
if (-not (Test-Path $exe)) { throw "SvnAdmin.Api.exe not found next to this script ($PSScriptRoot)." }

if (-not $Account) {
    $apache = Get-CimInstance Win32_Service -Filter "Name='$ApacheServiceName'" -ErrorAction SilentlyContinue
    $Account = if ($apache) { $apache.StartName } else { 'LocalSystem' }
    Write-Host "Using the Apache service account: $Account"
}

foreach ($d in @($DataDir) + $SvnDirs) {
    New-Item -ItemType Directory -Force $d | Out-Null
    if ($Account -notin @('LocalSystem', '.\LocalSystem')) {
        icacls $d /grant "${Account}:(OI)(CI)M" /T /C /Q | Out-Null
        Write-Host "Granted Modify on $d to $Account"
    }
}

$existing = Get-Service SvnAdmin -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host 'Stopping existing SvnAdmin service...'
    Stop-Service SvnAdmin -Force
    sc.exe config SvnAdmin binPath= "`"$exe`"" | Out-Null
} else {
    $params = @{
        Name           = 'SvnAdmin'
        BinaryPathName = "`"$exe`""
        DisplayName    = 'SvnAdmin (SVN administration portal)'
        Description    = 'Manages SVN users, groups, repositories, permissions and backups. Serves http://127.0.0.1:5080 behind Apache.'
        StartupType    = 'Automatic'
    }
    if ($Account -notin @('LocalSystem', '.\LocalSystem')) {
        $params.Credential = Get-Credential -UserName $Account -Message "Password for the service account $Account (leave blank for built-in accounts)"
    }
    New-Service @params | Out-Null
}

# Restart after 10s on the first three failures.
sc.exe failure SvnAdmin reset= 86400 actions= restart/10000/restart/10000/restart/10000 | Out-Null

Start-Service SvnAdmin
Start-Sleep -Seconds 3
try {
    $h = Invoke-RestMethod http://127.0.0.1:5080/api/health -TimeoutSec 10
    if ($h.ok) { Write-Host 'SvnAdmin is running: http://127.0.0.1:5080/api/health OK' -ForegroundColor Green }
} catch {
    Write-Warning "Service started but the health check failed: $($_.Exception.Message). Check Event Viewer > Windows Logs > Application (source: SvnAdmin)."
}
