param(
  [int]$Port = 3000,
  [string]$DatabasePath = ':memory:',
  [int]$StartupTimeoutSeconds = 30,
  [switch]$KeepRunning,
  [switch]$SkipInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $projectRoot 'apps/api/dist/server.js'
$acceptanceScript = Join-Path $projectRoot 'scripts/acceptance.ps1'
$baseUrl = "http://127.0.0.1:$Port"
$server = $null
$acceptanceSucceeded = $false
$leaveServerRunning = $false

if ($Port -lt 1 -or $Port -gt 65535) {
  throw '-Port must be between 1 and 65535.'
}
if ($StartupTimeoutSeconds -lt 5 -or $StartupTimeoutSeconds -gt 300) {
  throw '-StartupTimeoutSeconds must be between 5 and 300.'
}
if ([string]::IsNullOrWhiteSpace($DatabasePath)) {
  throw '-DatabasePath must not be blank.'
}

function Get-ExecutablePath {
  param(
    [Parameter(Mandatory = $true)][string[]]$Names
  )

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
  }
  throw "Required executable was not found: $($Names -join ', ')"
}

function Invoke-PowerShellScript {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $shellName = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
  $shellPath = Get-ExecutablePath -Names @($shellName)
  & $shellPath -NoProfile -ExecutionPolicy Bypass -File $Path
  if ($LASTEXITCODE -ne 0) {
    throw "PowerShell script failed with exit code $LASTEXITCODE`: $Path"
  }
}

function Invoke-NpmBuild {
  $npmPath = Get-ExecutablePath -Names @('npm.cmd', 'npm')
  Push-Location $projectRoot
  try {
    & $npmPath run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
}

function Set-DemoEnvironment {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Values
  )

  $snapshot = @{}
  foreach ($name in $Values.Keys) {
    $snapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, [string]$Values[$name], 'Process')
  }
  return $snapshot
}

function Restore-Environment {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Snapshot
  )

  foreach ($name in $Snapshot.Keys) {
    [Environment]::SetEnvironmentVariable($name, $Snapshot[$name], 'Process')
  }
}

function Read-LogTail {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) { return '<no log was written>' }
  $lines = Get-Content -LiteralPath $Path -Tail 40 -ErrorAction SilentlyContinue
  if (-not $lines) { return '<log is empty>' }
  return ($lines -join [Environment]::NewLine)
}

function Wait-ForReady {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$ErrorLogPath
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $Process.Refresh()
      if ($Process.HasExited) {
        $log = Read-LogTail -Path $ErrorLogPath
        throw "Demo server exited before readiness (exit code $($Process.ExitCode)).`n$log"
      }

      $health = Invoke-RestMethod `
        -Method Get `
        -Uri "$Url/health/ready" `
        -TimeoutSec 2
      if ($health.status -eq 'ready') { return $health }
    }
    catch {
      # A refused connection is expected while Fastify is starting. If the
      # process has exited, surface its diagnostics immediately instead.
      try {
        $Process.Refresh()
        if ($Process.HasExited) {
          $log = Read-LogTail -Path $ErrorLogPath
          throw "Demo server exited before readiness (exit code $($Process.ExitCode)).`n$log"
        }
      }
      catch {
        if ($_.Exception.Message -like 'Demo server exited before readiness*') { throw }
      }
    }
    Start-Sleep -Milliseconds 500
  }

  $Process.Refresh()
  $state = if ($Process.HasExited) { "exited with code $($Process.ExitCode)" } else { 'still running' }
  $log = Read-LogTail -Path $ErrorLogPath
  throw "Demo server was not ready after $TimeoutSeconds seconds ($state).`n$log"
}

function Stop-DemoServer {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process
  )

  try { $Process.Refresh() } catch { return }
  if ($Process.HasExited) { return }

  # The server is launched as node directly, but /T also protects against a
  # future wrapper process without ever targeting an unrelated PID.
  $taskkill = Get-Command 'taskkill.exe' -ErrorAction SilentlyContinue
  if ($taskkill -and $taskkill.Source) {
    & $taskkill.Source /PID $Process.Id /T /F *> $null
    if ($LASTEXITCODE -eq 0) {
      try { $Process.WaitForExit(5000) | Out-Null } catch { }
      return
    }
  }

  try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch { }
  try { $Process.WaitForExit(5000) | Out-Null } catch { }
}

try {
  $nodePath = Get-ExecutablePath -Names @('node.exe', 'node')
  if (-not $SkipInstall -and -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    Write-Host '未检测到 node_modules，先执行安装脚本…'
    Invoke-PowerShellScript -Path (Join-Path $projectRoot 'scripts/install.ps1')
  }

  if (-not $SkipBuild) {
    Write-Host '正在构建 core 与 API…'
    Invoke-NpmBuild
  }
  if (-not (Test-Path -LiteralPath $serverScript)) {
    throw "Compiled server entry was not found: $serverScript (remove -SkipBuild or run npm run build)."
  }

  $logDirectory = Join-Path $projectRoot 'var'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutLog = Join-Path $logDirectory "demo-server-$stamp.stdout.log"
  $stderrLog = Join-Path $logDirectory "demo-server-$stamp.stderr.log"

  $demoEnvironment = @{
    NODE_ENV = 'development'
    AUTH_MODE = 'trusted_headers'
    HOST = '127.0.0.1'
    PORT = [string]$Port
    DATABASE_PATH = $DatabasePath
    APP_TIMEZONE = 'Asia/Shanghai'
    HTTP_BODY_LIMIT_BYTES = '4194304'
    HTTP_REQUEST_TIMEOUT_MS = '30000'
    HTTP_CONNECTION_TIMEOUT_MS = '125000'
    RATE_LIMIT_ENABLED = 'true'
    RATE_LIMIT_MAX_REQUESTS = '120'
    RATE_LIMIT_WINDOW_MS = '60000'
    RATE_LIMIT_MAX_KEYS = '10000'
    LLM_ENABLED = 'false'
    FEISHU_NOTIFICATIONS_ENABLED = 'false'
    FEISHU_VERIFICATION_TOKEN = ''
    FEISHU_ENCRYPT_KEY = ''
    REMINDER_POLL_INTERVAL_MS = '15000'
  }
  $environmentSnapshot = Set-DemoEnvironment -Values $demoEnvironment
  try {
    # Start-Process joins ArgumentList items into one command line on Windows;
    # quote the absolute entry path so clones under a directory containing
    # spaces still start correctly on PowerShell 5.1 and 7.
    $quotedServerScript = '"' + $serverScript + '"'
    $server = Start-Process `
      -FilePath $nodePath `
      -ArgumentList @($quotedServerScript) `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru
  }
  finally {
    Restore-Environment -Snapshot $environmentSnapshot
  }

  Write-Host "服务启动中：$baseUrl（PID $($server.Id)）"
  Wait-ForReady -Process $server -Url $baseUrl -TimeoutSeconds $StartupTimeoutSeconds -ErrorLogPath $stderrLog | Out-Null
  Write-Host '服务已就绪，开始运行完整验收…'

  # The demo server is deliberately started in trusted_headers mode. Pass an
  # explicit empty token so a caller's inherited production token cannot make
  # the acceptance client send Bearer credentials to this development server.
  & $acceptanceScript `
    -BaseUrl $baseUrl `
    -Token '' `
    -TenantId 'demo-tenant' `
    -UserId 'demo-user'
  $acceptanceSucceeded = $true
  if ($KeepRunning) {
    $leaveServerRunning = $true
    Write-Host "验收通过。服务保持运行，供第二终端演示 CLI：$baseUrl"
    Write-Host "Web 工作台：$baseUrl/app/"
    Write-Host "停止命令：Stop-Process -Id $($server.Id)；日志：$stdoutLog"
  }
}
finally {
  if ($server -and (-not $leaveServerRunning -or -not $acceptanceSucceeded)) {
    Stop-DemoServer -Process $server
    if ($acceptanceSucceeded) { Write-Host '演示服务已清理。' }
  }
}
