param(
  [string]$JavaHome = "C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot",
  [string]$AndroidSdkRoot = "C:\opus\android-sdk"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $repoRoot "android"
$localProperties = Join-Path $androidDir "local.properties"

if (-not (Test-Path $JavaHome)) {
  throw "JAVA_HOME not found: $JavaHome"
}

if (-not (Test-Path $AndroidSdkRoot)) {
  throw "ANDROID_SDK_ROOT not found: $AndroidSdkRoot"
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdkRoot
$env:ANDROID_SDK_ROOT = $AndroidSdkRoot
$env:Path = "$JavaHome\bin;$AndroidSdkRoot\platform-tools;$env:Path"

$sdkDir = $AndroidSdkRoot.Replace("\", "\\")
Set-Content -Path $localProperties -Value "sdk.dir=$sdkDir"

Push-Location $repoRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed. Android packaging stopped." }
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { throw "Android resource sync failed. Packaging stopped." }

  Push-Location $androidDir
  try {
    .\gradlew.bat assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Android package build failed." }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
