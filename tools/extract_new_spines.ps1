param(
    [string]$WorkspaceDirectory,
    [string]$AssetRipperExecutable,
    [string]$AssetBundleDirectory,
    [string]$RepositoryDirectory,
    [int]$AssetRipperPort = 49127,
    [long]$MaximumBatchBytes = 100MB,
    [switch]$SkipIndexUpdate
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RepositoryDirectory)) {
    $parentDirectory = Split-Path -Parent $scriptDirectory
    if (
        (Test-Path -LiteralPath (Join-Path $parentDirectory '.git')) -and
        (Test-Path -LiteralPath (Join-Path $parentDirectory 'data.json'))
    ) {
        $RepositoryDirectory = $parentDirectory
    }
    else {
        $RepositoryDirectory = Join-Path $scriptDirectory 'langrisser-spiner-db-pr'
    }
}
if ([string]::IsNullOrWhiteSpace($WorkspaceDirectory)) {
    $WorkspaceDirectory = Split-Path -Parent $RepositoryDirectory
}
$WorkspaceDirectory = (Resolve-Path -LiteralPath $WorkspaceDirectory).Path
if ([string]::IsNullOrWhiteSpace($AssetRipperExecutable)) {
    $AssetRipperExecutable = Join-Path $WorkspaceDirectory 'AssetRipper.GUI.Free.exe'
}
if ([string]::IsNullOrWhiteSpace($AssetBundleDirectory)) {
    $AssetBundleDirectory = Join-Path $WorkspaceDirectory 'PGLauncher\games\Langrisser\Client\Langrisser_Data\StreamingAssets\ExportAssetBundle'
}

$inputDirectory = Join-Path $WorkspaceDirectory 'assetripper_batch_input'
$outputDirectory = Join-Path $WorkspaceDirectory 'assetripper_batch_output'
$allowedTaskDirectories = @($inputDirectory, $outputDirectory)

function Remove-TaskDirectory {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if ($resolved -notin $script:allowedTaskDirectories) {
        throw "Refusing to remove unexpected directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Invoke-AssetRipperPost {
    param(
        [Parameter(Mandatory)][string]$Route,
        [hashtable]$Body = @{}
    )

    $uri = "http://127.0.0.1:$AssetRipperPort$Route"
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uri -Body $Body -TimeoutSec 3600 | Out-Null
}

if (-not (Test-Path -LiteralPath $AssetBundleDirectory -PathType Container)) {
    throw "Asset bundle directory not found: $AssetBundleDirectory"
}
if (-not (Test-Path -LiteralPath $RepositoryDirectory -PathType Container)) {
    throw "Repository directory not found: $RepositoryDirectory"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepositoryDirectory '.git'))) {
    throw "Repository is not a Git worktree: $RepositoryDirectory"
}
if ($MaximumBatchBytes -le 0) {
    throw 'MaximumBatchBytes must be greater than zero.'
}

$remotePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
& git -C $RepositoryDirectory ls-tree -r --name-only HEAD | ForEach-Object {
    if (-not [string]::IsNullOrWhiteSpace($_)) {
        [void]$remotePaths.Add($_)
    }
}
if ($LASTEXITCODE -ne 0) {
    throw 'Could not read the repository HEAD tree.'
}

$bundles = @(
    Get-ChildItem -LiteralPath $AssetBundleDirectory -File -Filter 'spine_char_*.b'
    Get-ChildItem -LiteralPath $AssetBundleDirectory -File -Filter 'spine_confession_*.b'
) | Sort-Object Name

if ($bundles.Count -eq 0) {
    throw 'No spine_char or spine_confession bundles were found.'
}

$batches = [System.Collections.Generic.List[object]]::new()
$currentBatch = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
$currentBytes = 0L
foreach ($bundle in $bundles) {
    if ($currentBatch.Count -gt 0 -and ($currentBytes + $bundle.Length) -gt $MaximumBatchBytes) {
        $batches.Add($currentBatch.ToArray())
        $currentBatch = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
        $currentBytes = 0L
    }
    $currentBatch.Add($bundle)
    $currentBytes += $bundle.Length
}
if ($currentBatch.Count -gt 0) {
    $batches.Add($currentBatch.ToArray())
}

$newFileCount = 0
$duplicateFileCount = 0
$skippedTrackedCount = 0
$startedAssetRipper = $false
$assetRipperProcess = $null

Write-Host "Processing $($bundles.Count) bundles in $($batches.Count) batches."

$listener = Get-NetTCPConnection -LocalPort $AssetRipperPort -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
    if (-not (Test-Path -LiteralPath $AssetRipperExecutable -PathType Leaf)) {
        throw "AssetRipper executable not found: $AssetRipperExecutable"
    }
    $logPath = Join-Path $WorkspaceDirectory 'AssetRipper_extraction.log'
    $assetRipperProcess = Start-Process -FilePath $AssetRipperExecutable -ArgumentList @(
        '--headless', '--port', "$AssetRipperPort", '--log-path', "`"$logPath`""
    ) -WindowStyle Hidden -PassThru
    $startedAssetRipper = $true

    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $listener = Get-NetTCPConnection -LocalPort $AssetRipperPort -State Listen -ErrorAction SilentlyContinue
    } until ($listener -or (Get-Date) -gt $deadline -or $assetRipperProcess.HasExited)
    if (-not $listener) {
        if (-not $assetRipperProcess.HasExited) {
            Stop-Process -Id $assetRipperProcess.Id
        }
        throw 'AssetRipper did not start listening within 30 seconds.'
    }
}

$assetRipperPage = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$AssetRipperPort/" -TimeoutSec 10
if ($assetRipperPage.Content -notmatch 'AssetRipper') {
    if ($startedAssetRipper -and $assetRipperProcess -and -not $assetRipperProcess.HasExited) {
        Stop-Process -Id $assetRipperProcess.Id
    }
    throw "Port $AssetRipperPort is not serving AssetRipper."
}

try {
    Invoke-AssetRipperPost -Route '/Reset'

    for ($batchIndex = 0; $batchIndex -lt $batches.Count; $batchIndex++) {
        Remove-TaskDirectory -Path $inputDirectory
        Remove-TaskDirectory -Path $outputDirectory
        New-Item -ItemType Directory -Path $inputDirectory | Out-Null
        New-Item -ItemType Directory -Path $outputDirectory | Out-Null

        $batch = @($batches[$batchIndex])
        foreach ($bundle in $batch) {
            $stagedPath = Join-Path $inputDirectory $bundle.Name
            try {
                New-Item -ItemType HardLink -Path $stagedPath -Target $bundle.FullName -ErrorAction Stop | Out-Null
            }
            catch {
                Copy-Item -LiteralPath $bundle.FullName -Destination $stagedPath
            }
        }

        $batchBytes = ($batch | Measure-Object -Property Length -Sum).Sum
        Write-Host ("Batch {0}/{1}: loading {2} bundles ({3:N1} MiB)" -f ($batchIndex + 1), $batches.Count, $batch.Count, ($batchBytes / 1MB))
        Invoke-AssetRipperPost -Route '/LoadFolder' -Body @{ Path = $inputDirectory }
        Invoke-AssetRipperPost -Route '/Export/UnityProject' -Body @{ Path = $outputDirectory }

        $spineRoot = Join-Path $outputDirectory 'ExportedProject\Assets\gameproject\runtimeassets\spine'
        if (Test-Path -LiteralPath $spineRoot -PathType Container) {
            $assetFiles = Get-ChildItem -LiteralPath $spineRoot -Recurse -File | Where-Object {
                $_.Name -like '*.atlas.txt' -or $_.Name -like '*.png' -or $_.Name -like '*.skel.bytes'
            }

            foreach ($assetFile in $assetFiles) {
                $relativePath = $assetFile.FullName.Substring($spineRoot.Length + 1).Replace('\', '/')
                $topLevel = $relativePath.Split('/')[0]
                if ($topLevel -notin @('char', 'confession')) {
                    continue
                }
                if ($remotePaths.Contains($relativePath)) {
                    $skippedTrackedCount++
                    continue
                }

                $destination = Join-Path $RepositoryDirectory $relativePath.Replace('/', '\')
                $destinationDirectory = Split-Path -Parent $destination
                if (-not (Test-Path -LiteralPath $destinationDirectory)) {
                    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
                }

                if (Test-Path -LiteralPath $destination) {
                    $sourceHash = (Get-FileHash -LiteralPath $assetFile.FullName -Algorithm SHA256).Hash
                    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
                    if ($sourceHash -ne $destinationHash) {
                        throw "Conflicting extracted content for $relativePath"
                    }
                    $duplicateFileCount++
                }
                else {
                    Copy-Item -LiteralPath $assetFile.FullName -Destination $destination
                    $newFileCount++
                }
            }
        }

        Invoke-AssetRipperPost -Route '/Reset'
        Write-Host "Batch $($batchIndex + 1) complete; $newFileCount new files collected so far."
    }

    if (-not $SkipIndexUpdate) {
        $updateScript = Join-Path $scriptDirectory 'update_spine_index.js'
        $validationScript = Join-Path $scriptDirectory 'validate_spine_update.js'
        & node $updateScript $RepositoryDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Index update failed.' }
        & node $validationScript $RepositoryDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Validation failed.' }
    }
}
finally {
    try { Invoke-AssetRipperPost -Route '/Reset' } catch { }
    Remove-TaskDirectory -Path $inputDirectory
    Remove-TaskDirectory -Path $outputDirectory
    if ($startedAssetRipper -and $assetRipperProcess -and -not $assetRipperProcess.HasExited) {
        Stop-Process -Id $assetRipperProcess.Id
    }
}

Write-Host "Extraction complete. New files: $newFileCount; already-tracked paths skipped: $skippedTrackedCount; identical batch duplicates: $duplicateFileCount."
