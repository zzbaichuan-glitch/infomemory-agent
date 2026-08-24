param(
  [string]$BaseUrl = 'http://127.0.0.1:3000',
  [string]$Token = $env:INFOMEMORY_TOKEN
)

$ErrorActionPreference = 'Stop'
$headers = if ($Token) {
  @{ 'authorization' = "Bearer $Token" }
} else {
  @{
    'x-tenant-id' = 'smoke-tenant'
    'x-user-id' = 'smoke-user'
  }
}
$idempotencyHeaders = $headers.Clone()
$idempotencyHeaders['idempotency-key'] = "smoke-$([guid]::NewGuid().ToString('N'))"

$health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
$assetBody = @{
  title = '冒烟测试部署说明'
  content = '部署说明由平台组维护；password=smoke-example-password'
  visibility = 'owner'
} | ConvertTo-Json
$created = Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/v1/assets" `
  -Headers $idempotencyHeaders `
  -ContentType 'application/json; charset=utf-8' `
  -Body $assetBody
$searchBody = @{ query = '部署说明' } | ConvertTo-Json
$searched = Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/v1/search" `
  -Headers $headers `
  -ContentType 'application/json; charset=utf-8' `
  -Body $searchBody
$answerBody = @{ query = '部署说明由谁维护' } | ConvertTo-Json
$answered = Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/v1/answers" `
  -Headers $headers `
  -ContentType 'application/json; charset=utf-8' `
  -Body $answerBody

[pscustomobject]@{
  health = $health.status
  searchMode = $health.searchMode
  assetCreated = $created.created
  secretFindingCount = $created.asset.secretFindingCount
  evidenceCount = @($searched.evidence).Count
  answerStatus = $answered.status
  degradedReason = $answered.degradedReason
} | ConvertTo-Json
