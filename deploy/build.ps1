<#
.SYNOPSIS
    Builds SvnAdmin into a single folder ready to copy to the SVN server.
.DESCRIPTION
    Builds the Angular UI into the API's wwwroot, then publishes the API as a
    self-contained win-x64 app (no .NET install needed on the server).
    Output: SvnAdmin\publish\
.EXAMPLE
    .\deploy\build.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'publish'

Write-Host 'Running tests...' -ForegroundColor Cyan
dotnet test (Join-Path $root 'server\SvnAdmin.Tests\SvnAdmin.Tests.csproj') --nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Nothing was built.' }

Push-Location (Join-Path $root 'client')
try {
    if (-not (Test-Path node_modules)) { npm ci }
    Write-Host 'Building the UI...' -ForegroundColor Cyan
    # On some Windows machines Angular's esbuild helper keeps the process alive after a finished build,
    # so wait for Angular's own "complete"/"failed" line, then end the leftover process tree.
    $log = Join-Path ([IO.Path]::GetTempPath()) "svnadmin-ng-$PID.log"
    $proc = Start-Process -FilePath 'node' -ArgumentList 'node_modules/@angular/cli/bin/ng.js', 'build', '--configuration', 'production' `
        -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $deadline = (Get-Date).AddMinutes(10)
    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
        $text = (Get-Content $log, "$log.err" -Raw -ErrorAction SilentlyContinue) -join ''
        if ($text -match 'Application bundle generation (complete|failed)') { Start-Sleep -Seconds 2; break }
        Start-Sleep -Seconds 1
    }
    if (-not $proc.HasExited) { taskkill /PID $proc.Id /T /F | Out-Null }
    $text = (Get-Content $log, "$log.err" -Raw -ErrorAction SilentlyContinue) -join "`n"
    Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
    Write-Host ($text -replace '\x1b\[[0-9;]*m', '')
    if ($text -notmatch 'Application bundle generation complete' -or $text -match '\[ERROR\]|✘') { throw 'Angular build failed' }
} finally { Pop-Location }

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
dotnet publish (Join-Path $root 'server\SvnAdmin.Api\SvnAdmin.Api.csproj') `
    -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o $out
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

# Never ship the development settings or local test data.
Remove-Item (Join-Path $out 'appsettings.Development.json') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $out 'appsettings.Local.json') -ErrorAction SilentlyContinue
Copy-Item (Join-Path $PSScriptRoot 'install-service.ps1') $out
Copy-Item (Join-Path $PSScriptRoot 'appsettings.Local.example.json') $out

Write-Host "`nBuilt to $out" -ForegroundColor Green
Write-Host 'Copy that folder to the server (e.g. C:\SvnAdmin\app) and follow deploy\DEPLOY.md.'
