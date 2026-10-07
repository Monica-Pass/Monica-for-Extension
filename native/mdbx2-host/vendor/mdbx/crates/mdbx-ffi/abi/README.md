# MDBX FFI ABI baselines

`mdbx2-uniffi-bindings-v1.json` freezes the native contract used by Kotlin bindings generated from MDBX2 commit `1070dee739dbe564806654359b6c6caa68156de5` with UniFFI 0.31.1.

The baseline records:

1. UniFFI contract version.
2. Every native function declared by the generated MDBX2 Kotlin bindings.
3. Every API checksum and its expected 16-bit value.
4. The SHA-256 of the generated bindings source.

MDBX3 may add functions and types. Every baseline symbol and checksum must remain available so an application can replace `libmdbx_ffi.so` without regenerating MDBX2 bindings.

Build the current production library and verify it with:

```powershell
cargo build -p mdbx-ffi --profile mdbx3-release
python scripts/verify-mdbx3-ffi-abi.py verify `
  --baseline crates/mdbx-ffi/abi/mdbx2-uniffi-bindings-v1.json `
  --library target/mdbx3-release/mdbx_ffi.dll
```

Linux uses `target/mdbx3-release/libmdbx_ffi.so`; macOS uses the corresponding dylib.

For Android, the production build script checks every cross-compiled SO with the
NDK `llvm-nm`. All 535 symbols required by the frozen MDBX2 bindings must exist
in arm64-v8a, armeabi-v7a, and x86_64:

```powershell
powershell -File scripts/build-mdbx3-android.ps1 `
  -NdkPath $env:ANDROID_NDK_HOME `
  -BaselineReport target/mdbx2-android-baseline/reports/mdbx2-android-artifacts.json
```

The comparison baseline is built from the exact commit recorded in the ABI JSON:

```powershell
git worktree add --detach C:\tmp\mdbx2-abi-baseline-1070dee 1070dee
powershell -File scripts/build-mdbx2-android-baseline.ps1 `
  -BaselineSourceRoot C:\tmp\mdbx2-abi-baseline-1070dee `
  -NdkPath $env:ANDROID_NDK_HOME
```

Both scripts apply `llvm-strip --strip-all`, record the Rust/Cargo/NDK/linker
versions and Cargo.lock hash, validate ELF machine types, and write reports only
under `target/`.
