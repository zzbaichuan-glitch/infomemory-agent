param(
  [string]$BaseUrl = 'http://127.0.0.1:3000',
  [string]$Token = $env:INFOMEMORY_TOKEN,
  [string]$TenantId = $env:INFOMEMORY_TENANT_ID,
  [string]$UserId = $env:INFOMEMORY_USER_ID
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Token)) {
  if ([string]::IsNullOrWhiteSpace($TenantId)) { $TenantId = 'acceptance-tenant' }
  if ([string]::IsNullOrWhiteSpace($UserId)) { $UserId = 'acceptance-user' }
  $headers = @{
    'x-tenant-id' = $TenantId
    'x-user-id' = $UserId
  }
  $authMode = 'trusted_headers'
} else {
  $headers = @{ authorization = "Bearer $Token" }
  $authMode = 'bearer'
}

$assetId = $null
$reminderId = $null
$idempotencyKey = "acceptance-$([guid]::NewGuid().ToString('N'))"
$secretFixture = 'synthetic-acceptance-secret-should-never-return'

function Invoke-ApiJson {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('Get', 'Post', 'Delete')][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [hashtable]$RequestHeaders = $headers,
    [object]$Body
  )

  $request = @{
    Method = $Method
    Uri = "{0}{1}" -f $BaseUrl.TrimEnd('/'), $Path
    Headers = $RequestHeaders
  }
  if ($null -ne $Body) {
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  return Invoke-RestMethod @request
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "验收失败：$Message" }
}

function Assert-NotFound {
  param([string]$Path, [hashtable]$RequestHeaders)
  try {
    Invoke-ApiJson -Method Get -Path $Path -RequestHeaders $RequestHeaders | Out-Null
    throw "验收失败：未授权请求意外返回成功：$Path"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -ne 404) { throw }
  }
}

try {
  $live = Invoke-ApiJson -Method Get -Path '/health/live' -RequestHeaders @{}
  $ready = Invoke-ApiJson -Method Get -Path '/health/ready' -RequestHeaders @{}
  $health = Invoke-ApiJson -Method Get -Path '/health' -RequestHeaders @{}
  $openapi = Invoke-WebRequest -Method Get -Uri ("{0}/openapi.yaml" -f $BaseUrl.TrimEnd('/')) -UseBasicParsing
  Assert-True ($live.status -eq 'ok') '存活探针不是 ok'
  Assert-True ($ready.status -eq 'ready') '就绪探针不是 ready'
  Assert-True ($health.version -eq '0.2.0') '健康页版本不是 0.2.0'
  Assert-True ($openapi.StatusCode -eq 200 -and $openapi.Content.Length -gt 1000) 'OpenAPI 文档不可用'

  $assetHeaders = $headers.Clone()
  $assetHeaders['idempotency-key'] = $idempotencyKey
  $body = @{
    title = '验收演示：部署说明 password=title-secret'
    content = "平台组维护部署说明；password=$secretFixture；请通过来源核验。"
    visibility = 'owner'
    source = @{
      type = 'manual'
      externalId = 'acceptance-demo'
      url = 'https://example.invalid/acceptance-demo?token=should-not-persist'
    }
  }
  $created = Invoke-ApiJson -Method Post -Path '/v1/assets' -RequestHeaders $assetHeaders -Body $body
  $assetId = $created.asset.id
  Assert-True $created.created '首次写入没有创建资产'
  Assert-True ($created.asset.secretFindingCount -ge 2) '没有识别到演示密钥'
  Assert-True (-not ($created.asset.redactedContent -like "*$secretFixture*")) '秘密出现在返回正文'
  Assert-True (($created.asset.sources[0].url -like '*token=REDACTED*') -and ($created.asset.sources[0].url -notlike '*should-not-persist*')) '敏感 URL 查询参数没有清洗'

  $replayed = Invoke-ApiJson -Method Post -Path '/v1/assets' -RequestHeaders $assetHeaders -Body $body
  Assert-True (-not $replayed.created -and $replayed.deduplicatedBy -eq 'idempotency') '幂等重放没有去重'
  Assert-True ($replayed.asset.id -eq $assetId) '幂等重放返回了错误资产'

  $search = Invoke-ApiJson -Method Post -Path '/v1/search' -RequestHeaders $headers -Body @{ query = '部署说明' }
  Assert-True (@($search.evidence).Count -ge 1) '检索没有返回刚写入的证据'
  $answer = Invoke-ApiJson -Method Post -Path '/v1/answers' -RequestHeaders $headers -Body @{ query = '部署说明由谁维护' }
  Assert-True ($answer.status -in @('evidence_only', 'answered')) '回答没有进入安全回答状态'
  Assert-True (@($answer.evidence).Count -ge 1) '回答缺少来源证据'

  $detail = Invoke-ApiJson -Method Get -Path "/v1/assets/$assetId" -RequestHeaders $headers
  Assert-True ($detail.asset.id -eq $assetId) '详情读取失败'

  if ($authMode -eq 'trusted_headers') {
    $otherUserHeaders = @{
      'x-tenant-id' = $TenantId
      'x-user-id' = "${UserId}-other"
    }
    Assert-NotFound -Path "/v1/assets/$assetId" -RequestHeaders $otherUserHeaders
  }

  $start = [DateTime]::UtcNow.AddHours(2)
  $reminder = Invoke-ApiJson -Method Post -Path '/v1/reminders' -RequestHeaders $headers -Body @{
    title = '验收演示提醒'
    startsAt = $start.ToString('o')
    remindAt = $start.AddMinutes(-30).ToString('o')
  }
  $reminderId = $reminder.reminder.id
  Assert-True ($reminder.reminder.status -eq 'scheduled') '手动提醒没有进入 scheduled'
  $completed = Invoke-ApiJson -Method Post -Path "/v1/reminders/$reminderId/status" -RequestHeaders $headers -Body @{ status = 'completed' }
  Assert-True ($completed.reminder.status -eq 'completed') '提醒状态转换失败'

  $deleted = Invoke-ApiJson -Method Delete -Path "/v1/assets/$assetId" -RequestHeaders $headers
  Assert-True $deleted.deleted '所有者删除失败'
  $assetId = $null

  [pscustomobject]@{
    status = 'acceptance_passed'
    authMode = $authMode
    version = $health.version
    searchEvidence = @($search.evidence).Count
    answerStatus = $answer.status
    reminderStatus = $completed.reminder.status
    idempotency = $replayed.deduplicatedBy
    secretFixtureReturned = $false
    ownerBoundary = if ($authMode -eq 'trusted_headers') { 'verified' } else { 'skipped_for_bearer_demo' }
  } | ConvertTo-Json
} finally {
  if ($assetId) {
    try { Invoke-ApiJson -Method Delete -Path "/v1/assets/$assetId" -RequestHeaders $headers | Out-Null } catch { }
  }
}
