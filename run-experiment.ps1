param(
    [Parameter(Mandatory)][string]$FuncExecutable,
    [Parameter(Mandatory)][string]$AzuriteScript,
    [string]$PythonExecutable = "$PSScriptRoot/.venv/Scripts/python.exe"
)

$ErrorActionPreference = 'Stop'
$savedWork = $env:GOWORK
$savedFunc = $env:BLOG_FUNC
$savedAzurite = $env:BLOG_AZURITE
$savedPython = $env:BLOG_PYTHON
Push-Location $PSScriptRoot
try {
    if (-not $IsWindows) { throw 'This experiment runner is currently tested on Windows only.' }
    foreach ($file in @($FuncExecutable, $AzuriteScript, $PythonExecutable)) {
        if (-not (Test-Path $file -PathType Leaf)) { throw "Missing executable or script: $file" }
    }
    $env:GOWORK = 'off'
    Push-Location go
    try {
        go test ./...
        if ($LASTEXITCODE) { throw 'Go handler tests failed' }
        go vet ./...
        if ($LASTEXITCODE) { throw 'Go handler vet failed' }
        go build -o ../bin/handler.exe .
        if ($LASTEXITCODE) { throw 'Go handler build failed' }
    } finally { Pop-Location }

    $env:BLOG_FUNC = (Resolve-Path $FuncExecutable).Path
    $env:BLOG_AZURITE = (Resolve-Path $AzuriteScript).Path
    $env:BLOG_PYTHON = (Resolve-Path $PythonExecutable).Path
    node fixtures.mjs
    if ($LASTEXITCODE) { throw 'Cross-language protocol fixtures failed' }
    node run.mjs
    if ($LASTEXITCODE) { throw 'Real-host experiment failed; see the latest artifacts directory' }
} finally {
    Pop-Location
    $env:GOWORK = $savedWork
    $env:BLOG_FUNC = $savedFunc
    $env:BLOG_AZURITE = $savedAzurite
    $env:BLOG_PYTHON = $savedPython
}