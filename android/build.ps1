param(
  [string]$Sdk = 'E:\AndroidSDK',
  [string]$Java = 'E:\jdk17\jdk-17.0.20.1+1',
  [string]$SigningDir = '',
  [string]$BuildTools = '35.0.1'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $SigningDir) { $SigningDir = Join-Path $repo '.deployment\android-signing' }
$tools = Join-Path $Sdk "build-tools\$BuildTools"
$platform = Join-Path $Sdk 'platforms\android-35\android.jar'
$env:JAVA_HOME = $Java
$env:PATH = (Join-Path $Java 'bin') + [IO.Path]::PathSeparator + $env:PATH
foreach ($path in @($platform,(Join-Path $tools 'aapt.exe'),(Join-Path $Java 'bin\javac.exe'))) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing build tool: $path" } }
$build = Join-Path $PSScriptRoot 'build'
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
$distribution = Join-Path $PSScriptRoot 'distribution'
New-Item -ItemType Directory -Force -Path $build,$classes,$dex,$distribution,$SigningDir | Out-Null
$password = Join-Path $SigningDir 'password.txt'
$keystore = Join-Path $SigningDir 'release.jks'
if (-not (Test-Path -LiteralPath $keystore)) {
  if (Test-Path -LiteralPath $password) { throw 'Signing password exists but keystore is missing; restore it before building' }
  $secret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  [IO.File]::WriteAllText($password,$secret,[Text.Encoding]::ASCII)
  & (Join-Path $Java 'bin\keytool.exe') -genkeypair -keystore $keystore -alias starpost -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Starpost Android, O=Starpost' '-storepass:file' $password '-keypass:file' $password
  if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $SigningDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
}
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
& (Join-Path $Java 'bin\javac.exe') -encoding UTF-8 -source 8 -target 8 -bootclasspath "$platform$([IO.Path]::PathSeparator)$(Join-Path $tools 'core-lambda-stubs.jar')" -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed' }
$classFiles = @(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' | ForEach-Object FullName)
& (Join-Path $tools 'd8.bat') --min-api 26 --lib $platform --output $dex @classFiles
if ($LASTEXITCODE -ne 0) { throw 'DEX compilation failed' }
$unsigned = Join-Path $build 'unsigned.apk'
& (Join-Path $tools 'aapt.exe') package -f -M (Join-Path $PSScriptRoot 'AndroidManifest.xml') -S (Join-Path $PSScriptRoot 'res') -I $platform -F $unsigned
if ($LASTEXITCODE -ne 0) { throw 'APK packaging failed' }
Push-Location $dex
try { & (Join-Path $tools 'aapt.exe') add $unsigned classes.dex; if ($LASTEXITCODE -ne 0) { throw 'DEX packaging failed' } } finally { Pop-Location }
$aligned = Join-Path $build 'aligned.apk'
& (Join-Path $tools 'zipalign.exe') -f -p 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'Alignment failed' }
$apk = Join-Path $distribution 'starpost-android.apk'
& (Join-Path $tools 'apksigner.bat') sign --ks $keystore --ks-key-alias starpost --ks-pass "file:$password" --out $apk $aligned
if ($LASTEXITCODE -ne 0) { throw 'Signing failed' }
& (Join-Path $tools 'apksigner.bat') verify --verbose --print-certs $apk | Set-Content -LiteralPath (Join-Path $distribution 'signing-certificate.txt') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Signature verification failed' }
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $distribution 'starpost-android.apk.sha256'), "$hash  starpost-android.apk`n", [Text.Encoding]::ASCII)
[pscustomobject]@{ Apk = $apk; Bytes = (Get-Item -LiteralPath $apk).Length; SHA256 = $hash } | ConvertTo-Json -Compress
