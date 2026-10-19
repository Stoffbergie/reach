import { defaultCommandTimeoutSeconds } from "../shared/config";
import { quotePowerShell } from "../shared/strings";
import { scriptUsage } from "../site/pages";

export function powerShellAgentScript(baseUrl: string): string {
  return `${scriptUsage(baseUrl, "#")}
$ErrorActionPreference = "Stop"
$BaseUrl = ${quotePowerShell(baseUrl)}
$PlatformName = if ($PSVersionTable.Platform) { [string]$PSVersionTable.Platform } else { [string][Environment]::OSVersion.Platform }
$Code = ([string](Invoke-RestMethod -Method Post -Uri "$BaseUrl/" -Headers @{ "X-Agent-Shell" = "powershell"; "X-Agent-Platform" = $PlatformName })).Trim()
$Clipboard = "copied to clipboard"

try {
  Set-Clipboard -Value $Code
} catch {
  $Clipboard = "clipboard copy unavailable"
}

function Decode-Base64Text([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Get-ResponseHeader([object]$Response, [string]$Name) {
  if (!$Response -or !$Response.Headers) { return "" }
  if ($Response.Headers.AllKeys) {
    foreach ($Key in $Response.Headers.AllKeys) {
      if ($Key -ieq $Name) { return [string]$Response.Headers[$Key] }
    }
  }
  return ""
}

function Get-ErrorResponse([object]$ErrorRecord) {
  if ($ErrorRecord.Exception.Response) { return $ErrorRecord.Exception.Response }
  if ($ErrorRecord.Exception.InnerException -and $ErrorRecord.Exception.InnerException.Response) {
    return $ErrorRecord.Exception.InnerException.Response
  }
  return $null
}

function Invoke-AgentRequest {
  param([string]$Method, [string]$Path, [string]$OutFile, [byte[]]$Body, [string]$ContentType, [hashtable]$Headers = @{})
  $Request = [System.Net.WebRequest]::Create("$BaseUrl$Path")
  $Request.Method = $Method.ToUpperInvariant()
  $Request.Timeout = 35000
  try { $Request.ReadWriteTimeout = 35000 } catch {}
  foreach ($Key in $Headers.Keys) {
    $Request.Headers.Add($Key, [string]$Headers[$Key])
  }
  if ($ContentType) { $Request.ContentType = $ContentType }
  if ($null -ne $Body) {
    $Request.ContentLength = $Body.Length
    if ($Body.Length -gt 0) {
      $RequestStream = $Request.GetRequestStream()
      try {
        $RequestStream.Write($Body, 0, $Body.Length)
      } finally {
        $RequestStream.Close()
      }
    }
  } elseif ($Method -ine "GET") {
    $Request.ContentLength = 0
  }
  try {
    $Response = $Request.GetResponse()
  } catch {
    $ErrorResponse = Get-ErrorResponse $_
    if ($ErrorResponse) {
      $Response = $ErrorResponse
    } else {
      throw
    }
  }
  try {
    $StatusCode = [int]$Response.StatusCode
    if ($OutFile) {
      $Stream = $Response.GetResponseStream()
      $File = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write)
      try {
        if ($Stream) { $Stream.CopyTo($File) }
      } finally {
        $File.Close()
        if ($Stream) { $Stream.Close() }
      }
    }
    return [pscustomobject]@{ StatusCode = $StatusCode; Headers = $Response.Headers }
  } finally {
    $Response.Close()
  }
}

function Stop-Session {
  if ($env:REACH_NO_END_ON_EXIT -eq "1") { return }
  try { Invoke-AgentRequest -Method Delete -Path "/$Code" | Out-Null } catch {}
}

function Start-CommandJob([string]$CommandBody, [string]$Cwd) {
  $Block = {
    param([string]$CommandBody, [string]$Cwd)
    try {
      if ($Cwd) {
        if (!(Test-Path -LiteralPath $Cwd -PathType Container)) {
          [pscustomobject]@{ ExitCode = 1; Stdout = ""; Stderr = "Working directory does not exist: $Cwd\`n" }
          return
        }
        Set-Location -LiteralPath $Cwd
      }
      $global:LASTEXITCODE = $null
      $PowerShellPath = (Get-Process -Id $PID).Path
      $OutputEncoding = [Text.UTF8Encoding]::new($false)
      $Runner = @'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$global:LASTEXITCODE = $null
& ([scriptblock]::Create([Console]::In.ReadToEnd())) 3>&1 4>&1 5>&1 6>&1
if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }
'@
      $Output = @($CommandBody | & $PowerShellPath -NoProfile -NonInteractive -OutputFormat XML -Command $Runner *>&1)
      $Stdout = $Output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | Out-String
      $Stderr = $Output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | Out-String
      $ExitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
      [pscustomobject]@{ ExitCode = $ExitCode; Stdout = $Stdout; Stderr = $Stderr }
    } catch {
      [pscustomobject]@{ ExitCode = 1; Stdout = ""; Stderr = $_.Exception.Message }
    }
  }
  if (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue) {
    return Start-ThreadJob -ScriptBlock $Block -ArgumentList $CommandBody, $Cwd
  }
  return Start-Job -ScriptBlock $Block -ArgumentList $CommandBody, $Cwd
}

function Run-Command([string]$CommandBody, [string]$Cwd, [int]$TimeoutSeconds) {
  $Job = $null
  try {
    $Job = Start-CommandJob -CommandBody $CommandBody -Cwd $Cwd
    if (Wait-Job $Job -Timeout $TimeoutSeconds) {
      $Result = @(Receive-Job $Job) | Select-Object -Last 1
      if (!$Result) { return [pscustomobject]@{ ExitCode = 0; Stdout = ""; Stderr = "" } }
      return $Result
    }
    Stop-Job $Job -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ExitCode = 124; Stdout = ""; Stderr = "Command timed out after $TimeoutSeconds seconds\`n" }
  } catch {
    return [pscustomobject]@{ ExitCode = 1; Stdout = ""; Stderr = $_.Exception.Message }
  } finally {
    if ($Job) { Remove-Job $Job -ErrorAction SilentlyContinue }
  }
}

Write-Host "Session: $Code ($Clipboard)"
Write-Host "Stop anytime: Ctrl+C"

try { [Console]::TreatControlCAsInput = $false } catch {}
try {
  while ($true) {
    $BodyFile = [IO.Path]::GetTempFileName()
    $Response = Invoke-AgentRequest -Method Get -Path "/$Code/next" -OutFile $BodyFile
    $StatusCode = [int]$Response.StatusCode
    if ($StatusCode -eq 204) {
      Remove-Item $BodyFile -Force
      continue
    }
    if ($StatusCode -eq 410 -or $StatusCode -eq 404) {
      Remove-Item $BodyFile -Force
      break
    }
    if ($StatusCode -ne 200) {
      if (Test-Path $BodyFile) { Get-Content $BodyFile -Raw | Write-Host }
      Remove-Item $BodyFile -Force
      Start-Sleep -Seconds 1
      continue
    }
    $CommandId = Get-ResponseHeader $Response "X-Command-Id"
    $Cwd = Decode-Base64Text (Get-ResponseHeader $Response "X-Command-Cwd-Base64")
    $TimeoutSeconds = [int](Get-ResponseHeader $Response "X-Command-Timeout")
    if ($TimeoutSeconds -lt 1) { $TimeoutSeconds = ${defaultCommandTimeoutSeconds} }
    $CommandBody = Get-Content $BodyFile -Raw
    Remove-Item $BodyFile -Force
    $Result = Run-Command -CommandBody $CommandBody -Cwd $Cwd -TimeoutSeconds $TimeoutSeconds
    $Stdout = [Text.Encoding]::UTF8.GetBytes([string]$Result.Stdout)
    $Stderr = [Text.Encoding]::UTF8.GetBytes([string]$Result.Stderr)
    $ResultBody = $Stdout
    if ($Stdout.Length -eq 0) {
      $ResultBody = $Stderr
    } elseif ($Stderr.Length -gt 0) {
      $ResultBody = [byte[]]::new($Stdout.Length + $Stderr.Length)
      $Stdout.CopyTo($ResultBody, 0)
      $Stderr.CopyTo($ResultBody, $Stdout.Length)
    }
    Invoke-AgentRequest -Method Post -Path "/$Code/result/\${CommandId}?exit=$([int]$Result.ExitCode)" -Body $ResultBody -ContentType "application/octet-stream" -Headers @{ "X-Stdout-Bytes" = [string]$Stdout.Length } | Out-Null
  }
} finally {
  Stop-Session
}
`;
}
