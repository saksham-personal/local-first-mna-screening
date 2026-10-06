@echo off
rem Development environment for this worktree. All paths stay on E:.
rem Usage: call scripts\dev-env.cmd   (then run cargo / pnpm in the same shell)
set "LFMS_WT=%~dp0..\.."
for %%I in ("%LFMS_WT%") do set "LFMS_WT=%%~fI"
set "CODEX_TC=C:\Users\eskay\Documents\Codex\2026-10-02\x20-im\work\toolchain"
set "RUSTUP_HOME=%CODEX_TC%\rustup"
set "RUST_BIN=%CODEX_TC%\rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"
set "GNU_BIN=%CODEX_TC%\w64devkit\bin"
set "CARGO_HOME=%LFMS_WT%\.cargo-home"
set "CARGO_TARGET_DIR=%LFMS_WT%\.cargo-target"
set "CARGO_BUILD_JOBS=2"
set "CARGO_BUILD_TARGET=x86_64-pc-windows-gnu"
set "RUSTC=%RUST_BIN%\rustc.exe"
set "RUSTDOC=%RUST_BIN%\rustdoc.exe"
set "CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=%GNU_BIN%\gcc.exe"
set "CC_x86_64_pc_windows_gnu=%GNU_BIN%\gcc.exe"
set "AR_x86_64_pc_windows_gnu=%GNU_BIN%\ar.exe"
set "LIBRARY_PATH=%RUSTUP_HOME%\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\lib\self-contained"
set "COREPACK_HOME=%LFMS_WT%\.corepack"
set "npm_config_store_dir=%LFMS_WT%\.pnpm-store"
rem Ports for this checkout (the original app keeps 4173 / 5173 / 7319 / 17318).
set "SCREENING_UI_PORT=4273"
set "SCREENING_DEV_PORT=5273"
set "SCREENING_BRIDGE_PORT=7419"
set "SCREENING_RUST_PORT=17418"
rem Binary the bridge launches (shared target dir).
set "SCREENING_RUST_BINARY=%CARGO_TARGET_DIR%\x86_64-pc-windows-gnu\release\mna-tools.exe"
set "PATH=%RUST_BIN%;%GNU_BIN%;%PATH%"
