# Termux deployment scripts

English | [中文](README.zh.md)

These scripts are the Termux deployment layer around a source checkout. They are not part of the `@deepseek-ai/dsh` package and are not required to run the CLI; they add a launcher, a restarting watchdog, and the checkout cutover and rollback used on the device.

## Files

| File | Purpose |
| --- | --- |
| `dsh` | Resolves the checkout beside itself and executes the source CLI, restoring the Android addons when the pinned require-builtin binary is missing. |
| `keep-alive.sh` | Runs `dsh web`, restarts it after a crash, publishes the login URL as a Termux notification, and holds a single-instance lock in `~/.dsh/run/watchdog.lock`. |
| `url.sh` | Prints the login URL published by the watchdog, preferring `latest.url` and falling back to `web-<pid>.url`. |
| `relogin.sh` | Restarts the server once and prints the new login URL. |
| `dsh-menu.sh` | Interactive start, stop, status, and URL menu; it also carries the local pi-web and SillyTavern shortcuts. |
| `cutover.sh` | Swaps a prepared checkout into the live path: preflight, watchdog and server stop, directory swap with git worktree link repair, post-restart smoke test, and automatic rollback on failure. |
| `rollback.sh` | Reverses the last `cutover.sh` swap, restarts the previous checkout, and parks the replaced one for inspection. |

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

`cutover.sh` and `rollback.sh` carry no version constants: paths, expected versions, and the expected branch come from environment variables that default to the layout above. The cutover validates both checkouts, stops the watchdog and server, swaps `CUTOVER_FROM` with `CUTOVER_TO` (the previous checkout lands at `CUTOVER_ASIDE`), rewrites the git worktree links, restarts the watchdog, and verifies the restarted server: the login URL answers, the serving process runs from the live path, and the version and branch match. Any failure after the service stops rolls the swap back and restarts the previous checkout. `rollback.sh` performs the reverse swap and leaves the replaced checkout at `CUTOVER_FAILED`. Both accept `--check`, which runs the preflight only; run it first. Keep the aside checkout until the new build is proven, because in this layout it holds the git directory that the live worktree's `.git` file names. The variables are `DSH_TERMUX_BASE`, `CUTOVER_FROM`, `CUTOVER_TO`, `CUTOVER_ASIDE`, `CUTOVER_FAILED`, `CUTOVER_EXPECT_FROM`, `CUTOVER_EXPECT_TO`, `CUTOVER_BRANCH`, `ROLLBACK_EXPECT`, `ROLLBACK_BRANCH`, and `DSH_HOME`.

## Notes

The login URL carries a bearer token; the watchdog writes `latest.url` with mode `600`. Treat it as a credential and do not commit it. The watchdog lock records its owning pid, and only that owner removes the lock when it exits.
