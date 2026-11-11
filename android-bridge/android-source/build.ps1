param([Parameter(Mandatory=$true)][string]$Sdk,[Parameter(Mandatory=$true)][string]$Jdk,[Parameter(Mandatory=$true)][string]$SigningKey)
$ErrorActionPreference='Continue'
$root=$PSScriptRoot
$build=Join-Path $root 'build'
$dist=Join-Path $root 'dist'
New-Item -ItemType Directory -Path $build,$dist,(Join-Path $build 'classes'),(Join-Path $build 'dex') -Force|Out-Null
$platform=Join-Path $Sdk 'platforms\android-35\android.jar'
$tools=Join-Path $Sdk 'build-tools\35.0.0'
$nativeStage=Join-Path $env:PUBLIC ('YusaekTalkBuild_'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $nativeStage -Force|Out-Null
Copy-Item -LiteralPath $platform -Destination (Join-Path $nativeStage 'android.jar')
Copy-Item -LiteralPath (Join-Path $root 'AndroidManifest.xml') -Destination $nativeStage
Copy-Item -LiteralPath (Join-Path $root 'res') -Destination $nativeStage -Recurse
$env:JAVA_HOME=$Jdk
$sources=@(Get-ChildItem -LiteralPath (Join-Path $root 'src') -Filter '*.java' -Recurse|ForEach-Object{$_.FullName})
& (Join-Path $Jdk 'bin\javac.exe') -encoding UTF-8 -Xlint:-options -source 8 -target 8 -classpath $platform -d (Join-Path $build 'classes') @sources
if($LASTEXITCODE-ne0){throw 'bridge_javac_failed'}
$classes=@(Get-ChildItem -LiteralPath (Join-Path $build 'classes') -Filter '*.class' -Recurse|ForEach-Object{$_.FullName})
& (Join-Path $tools 'd8.bat') --min-api 26 --lib $platform --output (Join-Path $build 'dex') @classes
if($LASTEXITCODE-ne0){throw 'bridge_dex_failed'}
& (Join-Path $tools 'aapt.exe') package -f -M (Join-Path $nativeStage 'AndroidManifest.xml') -S (Join-Path $nativeStage 'res') -I (Join-Path $nativeStage 'android.jar') -F (Join-Path $nativeStage 'unsigned.apk')
if($LASTEXITCODE-ne0){throw 'bridge_resources_failed'}
Copy-Item -LiteralPath (Join-Path $build 'dex\classes.dex') -Destination $nativeStage
Push-Location $nativeStage
try{& (Join-Path $tools 'aapt.exe') add (Join-Path $nativeStage 'unsigned.apk') 'classes.dex';if($LASTEXITCODE-ne0){throw 'bridge_apk_add_failed'}}finally{Pop-Location}
& (Join-Path $tools 'zipalign.exe') -f 4 (Join-Path $nativeStage 'unsigned.apk') (Join-Path $nativeStage 'aligned.apk')
if($LASTEXITCODE-ne0){throw 'bridge_zipalign_failed'}
Copy-Item -LiteralPath (Join-Path $nativeStage 'aligned.apk') -Destination (Join-Path $build 'aligned.apk')
if(-not(Test-Path -LiteralPath $SigningKey)){
  New-Item -ItemType Directory -Path (Split-Path $SigningKey -Parent) -Force|Out-Null
  & (Join-Path $Jdk 'bin\keytool.exe') -genkeypair -keystore $SigningKey -storepass android -keypass android -alias yusaek-talk -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=YUSAEK TALK Internal Development'
  if($LASTEXITCODE-ne0){throw 'bridge_key_generation_failed'}
}
$apk=Join-Path $dist 'YusaekTalkBridge.apk'
& (Join-Path $tools 'apksigner.bat') sign --ks $SigningKey --ks-pass pass:android --key-pass pass:android --out $apk (Join-Path $build 'aligned.apk')
if($LASTEXITCODE-ne0){throw 'bridge_sign_failed'}
& (Join-Path $tools 'apksigner.bat') verify $apk
if($LASTEXITCODE-ne0){throw 'bridge_signature_invalid'}
Get-FileHash -LiteralPath $apk -Algorithm SHA256
