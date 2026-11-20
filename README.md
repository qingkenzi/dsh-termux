# DSH for Android/Termux

English | [中文](README.zh.md)

This repository is the Android/Termux source build of **DeepSeekRuntime (DSH)**, the open-source agent harness from [DeepSeek AI](https://deepseek.com). It carries the same `@deepseek-ai/dsh` package as the [official repository](https://github.com/deepseek-ai/deepseek-harness), plus Android-arm64 native binaries, Termux setup scripts, and platform fixes.

- Upstream: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT)
- Baseline: upstream master snapshot from 2026-11-13
- Install guide: [Run DSH on Android with Termux](docs/user/guide/android-termux.md)

## Quick start

```sh
pkg install nodejs-lts python clang make cmake git binutils
pip install meson ninja
git clone https://github.com/qingkenzi/dsh-termux.git
cd dsh-termux
pnpm install
pnpm run setup:android
pnpm run build
pnpm run verify:android
pnpm dsh web --no-open
```

## What works on Android

| Capability | Android/Termux |
| --- | --- |
| CLI, Web UI, Sessions, attachments | Yes |
| Model requests and tool calls | Yes |
| bash and persistent terminals | Yes |
| `grep` and `glob` | Yes, through the bundled ripgrep binary |
| SSH execution | Yes, when a local `ssh` client and remote host are available |
| File-manager reveal and Open folder | Yes, through `xdg-open`/`termux-open` |
| CUA, Playwright automation | No |
| File sandbox | No: the Android default is `danger-full-access` |

## Permission mode

Android carries no supported sandbox backend: bubblewrap, Landlock, and Seatbelt do not exist there. The shipped Android default is therefore `danger-full-access`, so file-modifying tools run unconfined. Selecting a confined preset without a working backend fails closed with `SANDBOX_UNAVAILABLE`; do not run untrusted prompts or tools on a deployment that cannot confine.

## Upstream README

The official DeepSeekRuntime README follows, collapsed. Everything outside the Android port is upstream documentation.

<details>
<summary>Official DeepSeekRuntime README</summary>

# DeepSeek Harness


DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

On Android/Termux, install the prerequisites and run `pnpm run setup:android` before `pnpm run build`; see the [Android/Termux guide](docs/user/guide/android-termux.md).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

</details>
