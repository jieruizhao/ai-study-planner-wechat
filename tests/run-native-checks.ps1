param(
  [string]$CompilerRoot = 'C:\Program Files (x86)\Tencent\微信web开发者工具\code\package.nw\node_modules\wcc-exec'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot 'test-results'
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$wcc = Join-Path $CompilerRoot 'wcc.exe'
$wcsc = Join-Path $CompilerRoot 'wcsc.exe'
if (!(Test-Path -LiteralPath $wcc) -or !(Test-Path -LiteralPath $wcsc)) { throw '请指定微信开发者工具自带的 wcc-exec 目录' }
$pagesRoot = Join-Path $projectRoot 'miniprogram\pages'
$templates = @(Get-ChildItem -LiteralPath $pagesRoot -Recurse -Filter *.wxml | ForEach-Object { $_.FullName })
& $wcc -o (Join-Path $buildRoot 'wxml.js') @templates
if ($LASTEXITCODE -ne 0) { throw 'WXML 编译失败' }
$styles = @((Join-Path $projectRoot 'miniprogram\app.wxss')) + @(Get-ChildItem -LiteralPath $pagesRoot -Recurse -Filter *.wxss | ForEach-Object { $_.FullName })
& $wcsc -o (Join-Path $buildRoot 'wxss.js') @styles
if ($LASTEXITCODE -ne 0) { throw 'WXSS 编译失败' }
Write-Output "PASS: $($templates.Count) WXML pages, $($styles.Count) WXSS files"
