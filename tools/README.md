# Spine update tools

These scripts extract only `spine_char_*` and `spine_confession_*` bundles with
`AssetRipper.GUI.Free.exe`, retain paths that are not already in Git `HEAD`, update
`data.json`, and validate the result.

The default layout is:

```text
workspace/
  AssetRipper.GUI.Free.exe
  PGLauncher/games/Langrisser/Client/Langrisser_Data/StreamingAssets/ExportAssetBundle/
  langrisser-spiner-db/
    tools/
```

From the repository root, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\extract_new_spines.ps1
```

The extractor starts AssetRipper's local GUI server in headless mode, processes
bundles in memory-safe batches, and stops the server when finished. The operation
is rerunnable: already-tracked files are skipped and matching generated files are
verified instead of overwritten.

Paths can be supplied explicitly when the layout differs:

```powershell
.\tools\extract_new_spines.ps1 `
  -AssetRipperExecutable C:\Tools\AssetRipper.GUI.Free.exe `
  -AssetBundleDirectory C:\Games\Langrisser\ExportAssetBundle `
  -RepositoryDirectory C:\src\langrisser-spiner-db
```

The index and validator can also be run independently:

```powershell
node .\tools\update_spine_index.js
node .\tools\validate_spine_update.js
```

The indexer resolves files against the repository tree, repairs malformed or
case-mismatched paths, adds canonical companion files, and preserves the existing
JSON ordering and escaping style. The validator checks every index reference,
completion flag, PNG header, atlas page, and skeleton payload.

Generate the browser catalog from the complete entries in `data.json` with:

```powershell
node .\tools\generate_catalog.js
```

This writes `catalog.json` beside `data.json`, so all asset URLs remain relative
to the catalog itself. Incomplete entries are skipped.
