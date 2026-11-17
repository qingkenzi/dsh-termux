# Android prebuilt binaries

Prebuilt Android/arm64 binaries used by the Termux port. They are committed as
build inputs because npm's platform packages do not ship Android bionic builds.

| File | Tool | Version | Target | SHA-256 |
| --- | --- | --- | --- | --- |
| `system.node` | `@deepseek-ai/node-addon-system` flock addon | 0.1.2 | `aarch64-linux-android` | recorded by `scripts/setup-android.sh` |
| `require_builtin.node` | `node-addon-require-builtin` | 0.1.9 | `aarch64-linux-android` | recorded by `scripts/setup-android.sh` |
| `rg` | ripgrep | 14.1.1 | `aarch64-linux-android` | `d5aa71af88bf9b99f2ad62699d8f644cf8528306b6d17ee954899e49d98a81b3` |

`rg.manifest.json` records the ripgrep build command, version, size, and ELF
page-size compatibility. `scripts/setup-android.sh` verifies the manifest hash
before restoring `rg`; `scripts/setup-android-rg.sh` rebuilds it from a fixed
source tag.

All binaries are AArch64 bionic executables. Their ELF `LOAD` segments use
`p_align` 0x4000 so they remain loadable on 16 KB page-size Android devices.
