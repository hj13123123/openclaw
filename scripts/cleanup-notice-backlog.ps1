param(
  [Parameter(Mandatory = $true)]
  [string]$WorkspaceRoot
)

$ErrorActionPreference = 'Stop'

$notificationsRoot = Join-Path $WorkspaceRoot 'runtime\notifications'
$inboxDir = Join-Path $notificationsRoot 'inbox'
$archiveRoot = Join-Path $notificationsRoot 'archive'
$quarantineRoot = Join-Path $notificationsRoot 'quarantine'
$manifestPath = Join-Path $notificationsRoot 'backlog-manifest.json'

New-Item -ItemType Directory -Force -Path $inboxDir, $archiveRoot, $quarantineRoot | Out-Null

function Get-NoticeDate([System.IO.FileInfo]$File, $Notice) {
  $candidates = @($Notice.at, $Notice.createdAt, $Notice.timestamp, $Notice.deliveredAt) | Where-Object { $_ }
  foreach ($candidate in $candidates) {
    $dt = [datetime]::MinValue
    if ([datetime]::TryParse([string]$candidate, [ref]$dt)) {
      return $dt.ToString('yyyy-MM-dd')
    }
  }
  return $File.LastWriteTime.ToString('yyyy-MM-dd')
}

function Move-NoticeFile([System.IO.FileInfo]$File, [string]$TargetRoot, [string]$DatePart) {
  $targetDir = Join-Path $TargetRoot $DatePart
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  $targetPath = Join-Path $targetDir $File.Name
  if (Test-Path -LiteralPath $targetPath) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
    $ext = [System.IO.Path]::GetExtension($File.Name)
    $targetPath = Join-Path $targetDir ("$base-$([guid]::NewGuid().ToString('N').Substring(0,8))$ext")
  }
  Move-Item -LiteralPath $File.FullName -Destination $targetPath
  return $targetPath
}

$files = @(Get-ChildItem -LiteralPath $inboxDir -Filter 'notice-*.json' -File | Where-Object { $_.Name -notlike 'notice-digest-backlog-*' })
$actionRequired = New-Object System.Collections.Generic.List[object]
$archived = New-Object System.Collections.Generic.List[object]
$quarantined = New-Object System.Collections.Generic.List[object]
$actionArchived = New-Object System.Collections.Generic.List[object]

foreach ($file in $files) {
  try {
    $raw = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    $notice = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $notice -or $null -eq $notice.noticeId) {
      throw "invalid notice shape"
    }
    $datePart = Get-NoticeDate -File $file -Notice $notice
    if ($notice.actionRequired -eq $true) {
      $actionRequired.Add($notice) | Out-Null
      $target = Move-NoticeFile -File $file -TargetRoot (Join-Path $archiveRoot 'action-required') -DatePart $datePart
      $actionArchived.Add([ordered]@{ noticeId = [string]$notice.noticeId; path = $target }) | Out-Null
    } else {
      $target = Move-NoticeFile -File $file -TargetRoot $archiveRoot -DatePart $datePart
      $archived.Add([ordered]@{ noticeId = [string]$notice.noticeId; path = $target }) | Out-Null
    }
  } catch {
    $datePart = $file.LastWriteTime.ToString('yyyy-MM-dd')
    $target = Move-NoticeFile -File $file -TargetRoot $quarantineRoot -DatePart $datePart
    $quarantined.Add([ordered]@{ file = $file.Name; path = $target; error = $_.Exception.Message }) | Out-Null
  }
}

$digestPath = $null
if ($actionRequired.Count -gt 0) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $digestNoticeId = "notice-digest-backlog-$stamp"
  $sample = @($actionRequired | Select-Object -First 50 | ForEach-Object {
    [ordered]@{
      noticeId = [string]$_.noticeId
      taskId = [string]$_.taskId
      runId = [string]$_.runId
      type = [string]$_.type
      severity = [string]$_.severity
      summary = [string]$_.summary
    }
  })
  $digest = [ordered]@{
    noticeId = $digestNoticeId
    dedupKey = "notice-backlog-digest|$stamp|$($actionRequired.Count)"
    severity = 'warn'
    type = 'human_gate_required'
    deliveryMode = 'transcript'
    taskId = 'NOTICE-BACKLOG-CLEANUP-A'
    runId = $stamp
    source = 'engineering-executive'
    actionRequired = $true
    summary = "Notice backlog cleanup summarized $($actionRequired.Count) historical actionRequired notices into this digest. Original files were moved to runtime/notifications/archive/action-required/. Sample count: $($sample.Count)."
    relatedPaths = @($manifestPath, (Join-Path $archiveRoot 'action-required'))
    backlogDigest = [ordered]@{
      totalActionRequired = $actionRequired.Count
      sample = $sample
    }
  }
  $digestPath = Join-Path $inboxDir "$digestNoticeId.json"
  $digest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $digestPath -Encoding UTF8
}

$manifest = [ordered]@{
  manifestId = "notice-backlog-manifest-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  generatedAt = (Get-Date).ToString('o')
  workspaceRoot = $WorkspaceRoot
  inboxDir = $inboxDir
  totalInput = $files.Count
  actionRequiredCount = $actionRequired.Count
  actionRequiredDigestPath = $digestPath
  actionRequiredOriginalsArchived = $actionArchived.Count
  archivedCount = $archived.Count
  quarantinedCount = $quarantined.Count
  deletedCount = 0
  deliveryStateModified = $false
  archiveRoot = $archiveRoot
  quarantineRoot = $quarantineRoot
  actionRequiredOriginals = $actionArchived
  archived = $archived
  quarantined = $quarantined
}

$manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
$manifest | ConvertTo-Json -Depth 8
