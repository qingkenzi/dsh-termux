# Android prebuilt binaries

Prebuilt Android/arm64 binaries used by the Termux port. They are committed as
build inputs because npm's platform packages do not ship Android bionic builds.

| File | Tool | Version | Target | SHA-256 |
| --- | --- | --- | --- | --- |
| `system.node` | `@deepseek-ai/node-addon-system` flock addon | 0.1.2 | `aarch64-linux-android` | `23088d7c148231572547c8ff39494a16b31a258d4d233499443b20c569d2ee86` |
| `require_builtin.node` | `node-addon-require-builtin` | 0.1.9 | `aarch64-linux-android` | `73fb205f9ba9ed43a7462359f0dd1b568fec671cede4a15e9978316a8d6bebfd` |
| `rg` | ripgrep | 14.1.1 | `aarch64-linux-android` | `d5aa71af88bf9b99f2ad62699d8f644cf8528306b6d17ee954899e49d98a81b3` |

`addons.manifest.json` pins the size and SHA-256 of all three files. Regenerate
it with `node scripts/android-addons-manifest.mjs` after replacing a binary;
the file is deterministic so a matching tree produces an unchanged manifest.
`scripts/setup-android.sh` verifies every prebuilt against that manifest before
restoring it, and `scripts/stage-android-addons.ts` verifies the two files that
the CLI package publishes.

`rg.manifest.json` records the ripgrep build command, version, size, and ELF
page-size compatibility. `scripts/setup-android-rg.sh --verify` checks the
manifest hash, version, size ceiling, and 16 KB-page ELF alignment;
`scripts/setup-android-rg.sh --rebuild` rebuilds from the pinned source tag and
rewrites both manifests.

All binaries are AArch64 bionic executables. Their ELF `LOAD` segments use
`p_align` 0x4000 so they remain loadable on 16 KB page-size Android devices.
