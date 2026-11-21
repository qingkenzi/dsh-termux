# Termux deployment scripts

English | [中文](README.zh.md)

These scripts are the Termux deployment layer around a source checkout. They are not part of the `@deepseek-ai/dsh` package and are not required to run the CLI; they add a launcher, a restarting watchdog, and the one-shot checkout migration used on the device.

## Files

| File | Purpose |
| --- | --- |
| `dsh` | Resolves the checkout beside itself and executes the source CLI, restoring the Android addons when the pinned require-builtin binary is missing. |
| `keep-alive.sh` | Runs `dsh web`, restarts it after a crash, publishes the login URL as a Termux notification, and holds a single-instance lock in `~/.dsh/run/watchdog.lock`. |
| `url.sh` | Prints the login URL published by the watchdog, preferring `latest.url` and falling back to `web-<pid>.url`. |
| `relogin.sh` | Restarts the server once and prints the new login URL. |
| `dsh-menu.sh` | Interactive start, stop, status, and URL menu; it also carries the local pi-web and SillyTavern shortcuts. |
| `cutover-rc5.sh` | One-shot rc.3 to rc.5 checkout swap with preflight, post-restart smoke test, and automatic rollback. |
| `rollback-rc3.sh` | Reverts the swap performed by `cutover-rc5.sh`. |

## Install

Copy the scripts into the directory that holds the checkout, then make them executable:

```sh
mkdir -p ~/dsh
cp deploy/termux/dsh deploy/termux/*.sh ~/dsh/
chmod +x ~/dsh/dsh ~/dsh/*.sh
```

Start the watchdog from that directory and open the URL it sends to the Termux notification shade:

```sh
tmux new-session -d -s dsh -n watchdog '~/dsh/keep-alive.sh'
```

## Environment

`DSH_TERMUX_BASE` defaults to `$HOME/dsh` and locates the launcher, the checkout, and the `.logs` directory. `DSH_HOME` defaults to `$HOME/.dsh` and locates the run directory, sessions, and settings. The watchdog, menu, and `url.sh` assume the Web port `3080`; the port itself comes from the composed profile.

## Migration scripts

`cutover-rc5.sh` and `rollback-rc3.sh` are pinned to the rc.3 and rc.5 package versions. The cutover checks both builds, stops the watchdog and server, swaps the two checkouts, rewrites the git worktree links, and verifies the restarted server before reporting success. Change the version constants and checkout names before reusing them for another release, run `cutover-rc5.sh --check` first, and keep the rc.3 checkout because it holds the repository's git directory.

## Notes

The login URL carries a bearer token; the watchdog writes `latest.url` with mode `600`. Treat it as a credential and do not commit it. The watchdog lock records its owning pid, and only that owner removes the lock when it exits.
