<#
.SYNOPSIS
  POOLNET Zero-VPS Operator Activation Wizard (Cloudflare Worker Cron + BytePlus ModelArk on Vercel).
  100% Non-Custodial · Zero Secrets Stored in Git · Masked Input via Read-Host -AsSecureString.

.EXAMPLE
  bun run ops:setup:zero-vps
#>

$ErrorActionPreference = 'Stop'
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'

function Read-SecretPlain([string]$PromptText) {
  $sec = Read-Host -Prompt $PromptText -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

Write-Host ""
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "  POOLNET ZERO-VPS OPERATOR WIZARD (VERCEL + CLOUDFLARE + BYTEPLUS)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan

# ------------------------------------------------------------------------------
# STEP 1: Cloudflare Worker Cron Deployment (rtrader-autopilot-cron)
# ------------------------------------------------------------------------------
$runCf = Read-Host "`n[STEP 1] Login & deploy Cloudflare Worker rtrader-autopilot-cron sekarang? (y/N)"
if ($runCf -match '^(y|Y)') {
  Push-Location (Join-Path $PSScriptRoot '..\workers\cloudflare-autopilot-cron')
  try {
    Write-Host "-> Checking Cloudflare Wrangler auth..." -ForegroundColor Yellow
    npx wrangler whoami
    if ($LASTEXITCODE -ne 0) {
      Write-Host "-> Membuka browser untuk Cloudflare OAuth login..." -ForegroundColor Yellow
      npx wrangler login
    }

    $setCfSecrets = Read-Host "Apakah Anda ingin memasang/update CRON_SECRET_TESTNET & CRON_SECRET_PROD di Cloudflare? (y/N)"
    if ($setCfSecrets -match '^(y|Y)') {
      Write-Host "-> Memasang CRON_SECRET_TESTNET (input tersembunyi oleh wrangler)..." -ForegroundColor Yellow
      npx wrangler secret put CRON_SECRET_TESTNET
      Write-Host "-> Memasang CRON_SECRET_PROD (input tersembunyi oleh wrangler)..." -ForegroundColor Yellow
      npx wrangler secret put CRON_SECRET_PROD
    }

    Write-Host "-> Deploying rtrader-autopilot-cron (ENABLE_EXECUTION_PULSE=1)..." -ForegroundColor Green
    npx wrangler deploy
  } finally {
    Pop-Location
  }
}

# ------------------------------------------------------------------------------
# STEP 2: BytePlus ModelArk Env Vars on Vercel (Testnet & Production)
# ------------------------------------------------------------------------------
$runBp = Read-Host "`n[STEP 2] Pasang 7 Env Var BytePlus ModelArk ke Vercel (Testnet & Production)? (y/N)"
if ($runBp -match '^(y|Y)') {
  $arkKey = Read-SecretPlain "Masukkan BYTEDANCE_ARK_API_KEY (ModelArk Project API Key, input disembunyikan)"
  if ([string]::IsNullOrWhiteSpace($arkKey)) {
    throw "BYTEDANCE_ARK_API_KEY tidak boleh kosong."
  }
  $baseUrl = Read-Host "BYTEDANCE_BASE_URL [default: https://ark.ap-southeast.bytepluses.com/api/v3]"
  if ([string]::IsNullOrWhiteSpace($baseUrl)) { $baseUrl = "https://ark.ap-southeast.bytepluses.com/api/v3" }

  $fastEp = Read-Host "BYTEDANCE_MODEL_ENDPOINT (fast waterfall comma-separated, mis. ep-fast-1,ep-fast-2)"
  $deepEp = Read-Host "BYTEDANCE_DEEP_ENDPOINT (deep thinking waterfall comma-separated)"
  $imgEp  = Read-Host "BYTEDANCE_IMAGE_ENDPOINT (Seedream endpoint, opsional)"

  $kvPairs = [ordered]@{
    'AI_PRIMARY_PROVIDER'         = 'byteplus'
    'BYTEDANCE_BASE_URL'          = $baseUrl.Trim()
    'BYTEDANCE_ARK_API_KEY'       = $arkKey.Trim()
    'BYTEDANCE_MODEL_ENDPOINT'    = $fastEp.Trim()
    'BYTEDANCE_DEEP_ENDPOINT'     = $deepEp.Trim()
    'BYTEDANCE_INFOQUEST_ENABLED' = '1'
  }
  if (-not [string]::IsNullOrWhiteSpace($imgEp)) {
    $kvPairs['BYTEDANCE_IMAGE_ENDPOINT'] = $imgEp.Trim()
  }

  foreach ($project in @('rtrader-testnet', 'rtrader-production')) {
    Write-Host "`n-> Linking Vercel project: $project ..." -ForegroundColor Cyan
    npx vercel link --project $project --yes
    foreach ($key in $kvPairs.Keys) {
      $val = $kvPairs[$key]
      if ([string]::IsNullOrWhiteSpace($val)) { continue }
      Write-Host "   Setting $key on $project (production)..." -ForegroundColor Yellow
      npx vercel env rm $key production --yes 2>$null | Out-Null
      $val | npx vercel env add $key production --force | Out-Null
    }
    Write-Host "-> Redeploying $project ..." -ForegroundColor Green
    npx vercel deploy --prod --yes
  }

  # Re-link local workspace back to testnet default
  npx vercel link --project rtrader-testnet --yes | Out-Null
}

# ------------------------------------------------------------------------------
# STEP 3: Full Live Verification Gate
# ------------------------------------------------------------------------------
$runVerify = Read-Host "`n[STEP 3] Jalankan full live verification (adversarial + testnet E2E + dual blackbox/UI)? (Y/n)"
if ($runVerify -notmatch '^(n|N)') {
  bun run verify:adversarial
  bun run verify:testnet:e2e
  bun run verify:live:all
}

Write-Host "`n[DONE] Aktivasi Zero-VPS selesai. Cek /billing -> Tab Admin -> Ops Preflight Readiness." -ForegroundColor Green
