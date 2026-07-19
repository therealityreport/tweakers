$ErrorActionPreference = "Stop"

foreach ($CommandName in @("tweaker", "tweakers", "codexplusplus", "codex-plusplus")) {
  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    & $CommandName update @args
    exit $LASTEXITCODE
  }
}

[Console]::Error.WriteLine("[!] tweaker is not installed in PATH; running the installer instead.")
irm https://raw.githubusercontent.com/therealityreport/tweakers/main/install.ps1 | iex
