[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$config = Join-Path $PSScriptRoot '..\wrangler.jsonc'

foreach ($name in @('DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_PUBLIC_KEY')) {
  & npx wrangler secret put $name --config $config
  if ($LASTEXITCODE -ne 0) { throw "Wrangler could not set $name" }
}

Write-Host 'Interactions Endpoint URL: https://kyro-auth.kyro-ownr.workers.dev/api/discord/interactions'
Write-Host 'Save the endpoint in Discord Developer Portal, then verify a private application ticket and its public notice.'
