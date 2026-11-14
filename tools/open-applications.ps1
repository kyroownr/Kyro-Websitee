<#
.SYNOPSIS
  Opens the Kyro staff & contributor application system on the deployed
  kyro-auth Worker.

.DESCRIPTION
  The application form only accepts submissions once the Worker can reach
  Discord with a bot. That needs four values, none of which belong in this
  repository:

    DISCORD_BOT_TOKEN              the bot's token (keep it out of shell history)
    DISCORD_APPLICATIONS_CATEGORY_ID  the channel id of the applications category
    DISCORD_MOD_ROLE_ID            the role id of the staff role that reviews
    DISCORD_PUBLIC_KEY             the bot's application public key

  Every value is written as an encrypted Worker secret, so nothing lands in
  git and the Worker flips itself to "open" the moment the last one is in
  place — there is no separate "open" switch to remember.

  The bot itself must already exist, be a member of the Kyro Discord, and
  have Manage Channels in the applications category. Its interactions
  endpoint must be
    https://kyro-auth.kyro-ownr.workers.dev/applications/interactions
  with the same public key, otherwise the Approve/Decline buttons stay
  unsigned and Discord rejects them.

.PARAMETER Worker
  Worker name. Defaults to kyro-auth.

.PARAMETER Value
  Supply values non-interactively as a hashtable, e.g.
    .\tools\open-applications.ps1 -Value @{
      DISCORD_BOT_TOKEN = $env:KYRO_BOT_TOKEN
      DISCORD_APPLICATIONS_CATEGORY_ID = '1539961184323772499'
      DISCORD_MOD_ROLE_ID = '1539961184323772500'
      DISCORD_PUBLIC_KEY = '...'
    }
  Anything missing from the hashtable is prompted for.

.EXAMPLE
  .\tools\open-applications.ps1
#>
[CmdletBinding()]
param(
  [string]$Worker = 'kyro-auth',
  [hashtable]$Value = @{}
)

$ErrorActionPreference = 'Stop'

$required = @(
  'DISCORD_BOT_TOKEN',
  'DISCORD_APPLICATIONS_CATEGORY_ID',
  'DISCORD_MOD_ROLE_ID',
  'DISCORD_PUBLIC_KEY'
)

function Get-Plain {
  param([string]$Prompt, [string]$Label)
  $secure = Read-Host -Prompt "$Prompt ($Label)" -AsSecureString
  $credential = New-Object System.Net.NetworkCredential('', $secure)
  return $credential.Password
}

Write-Host ''
Write-Host 'Kyro — open the staff application system' -ForegroundColor Cyan
Write-Host "Worker: $Worker"
Write-Host ''

# 1. Wrangler has to be installed and signed in, or the secrets go nowhere.
try {
  $version = (& npx --yes wrangler@latest --version 2>&1 | Select-Object -Last 1).ToString().Trim()
} catch {
  throw 'wrangler could not be started. Install Node.js and try again.'
}
Write-Host "wrangler $version"

& npx --yes wrangler@latest whoami *>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { throw 'wrangler is not authenticated. Run: npx wrangler login' }

# 2. Collect every value, prompting only for the ones not supplied.
$values = @{}
foreach ($name in $required) {
  if ($Value.ContainsKey($name) -and $Value[$name]) {
    $values[$name] = [string]$Value[$name]
    continue
  }
  $prompt = if ($name -eq 'DISCORD_BOT_TOKEN') { 'Bot token' } else { $name }
  $entered = Get-Plain -Prompt $prompt -Label $name
  if (-not $entered) { throw "$name was empty. Nothing was changed." }
  $values[$name] = $entered
}

# 3. Write each value as an encrypted secret.
foreach ($name in $required) {
  Write-Host "setting $name ..."
  $values[$name] | & npx --yes wrangler@latest secret put $name --name $Worker | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "wrangler could not set $name" }
}

# 4. The Worker decides for itself whether it is open; ask it.
Start-Sleep -Seconds 2
$config = Invoke-RestMethod -Uri "https://kyro-auth.kyro-ownr.workers.dev/applications/config" -TimeoutSec 20
Write-Host ''
if ($config.open) {
  Write-Host 'Applications are OPEN. https://kyro.new.tg/apply now accepts submissions.' -ForegroundColor Green
} else {
  Write-Host 'The Worker still reports open: false. Check that all four values reached the Worker.' -ForegroundColor Yellow
  Write-Host '  npx wrangler secret list --name ' + $Worker
}
