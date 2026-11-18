---
description: "The startup authority for the deployment's sandbox mode: resolves explicit configuration, host backend availability, and the declared no-backend policy into one mode, its paired approval policy, and a process-level availability report."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-startup

English | [中文](README.zh.md)

## Summary

`dsh-sandbox-startup` decides which file-effect mode a deployment starts from, and publishes that decision as `ctx.sandboxStartup`. It asks the mounted sandbox provider what this host can actually enforce, honors an explicitly configured mode first, and otherwise chooses `workspace-write` on a host with a backend or applies the deployment's declared no-backend policy. Every shipped bundle reads the resolved mode instead of restating a platform expression, so a host without a backend can never drift into unconfined execution silently: an explicit confined mode fails closed, and the GUI policy keeps the confined mode while reporting that the user has not chosen yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in any composition that mounts both `@deepseek-ai/dsh-sandbox` and `@deepseek-ai/dsh-sandbox-policy`, and point `sandbox-policy.mode` at `ctx.sandboxStartup.mode`.

### When to choose it

Choose it for every deployment whose default sandbox mode must follow host capability rather than a fixed platform table. Skip it only when a composition states its mode directly, in which case that row is the authority and no availability report exists.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-sandbox-startup'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE
    onUnavailable: ask
```

`mode` is the deployment's explicit mode (`DSH_PERMISSION_MODE` in the shipped bundles; a headless `--permission-mode` selects a permission preset per session and outranks it). Leaving it unset hands the choice to host capability.

### Decisions

`resolveDefaultMode()` is a pure function over the explicit mode, the host availability verdict, and `onUnavailable`. It resolves, in order:

1. An explicit `danger-full-access` — accepted as the deployment's own statement.
2. An explicit confined mode on a host with a backend.
3. An explicit confined mode without a backend — throws `SandboxStartupUnavailableError` (`SANDBOX_STARTUP_UNAVAILABLE`) naming the host reason, the remediation, and the exact override.
4. No explicit mode on a host with a backend — `workspace-write`.
5. No explicit mode without a backend — `onUnavailable: 'danger-full-access'` accepts unconfined effects, `'ask'` keeps the confined mode and reports `awaitingChoice`, and `'fail'` throws.

`ask` is the GUI default and `fail` is the headless default. Neither reaches `danger-full-access` on its own: confined operations fail closed through the provider's `SANDBOX_UNAVAILABLE` denial, and only the user's explicit, risk-confirmed preset switch runs unconfined work.

## Understand the implementation

The service resolves once at construction, because the provider caches its backend chain verdict for the same process lifetime, and emits `sandbox/availability-changed` with the availability verdict during init so process-level consumers subscribe before reading. The paired `approvalPolicy` is `never` only for an accepted unconfined mode, so `ask` and `fail` deployments keep the approval prompts a confined deployment would use. `awaitingChoice` marks the GUI state where the banner and chip explain that no backend exists and a wider mode stays the user's decision.

Availability itself is the provider's report: `available`, `backend`, `enforcement` (`full`, `partial`, or `none`), a user-facing `reason`, and an actionable `remediation`. Providers never throw from `availability()`; an unresolvable verdict becomes `available: false` with the failure in the reason, so a deployment can explain and choose instead of crashing. That rule matters here because this service calls the provider from its constructor: a thrown probe failure would take the whole composition down instead of reporting the host.

## Further Exploration

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, provider chain, and fail-closed errors.
- [`dsh-sandbox`](../sandbox/README.md) — the confinement seam and the availability report contract.
- [`dsh-sandbox-policy`](../sandbox-policy/README.md) — the per-call policy home this service feeds.
- [`dsh-permission-presets`](../../interaction/permission-presets/README.md) — the preset table whose rows are the mode/approval pairs startup resolves.

## Model Experience

Indirectly, through [`dsh-sandbox-policy`](../sandbox-policy/README.md), whose runtime-context snapshot carries the mode this service resolves.

#### KV Cache effect

No direct invalidation; resolving the mode changes the policy text only when the deployment's mode would also change it.

## Known Limitations and Deferred Work

- The verdict is resolved once per process; a backend installed while DSH runs changes nothing until restart.
- No shipped bundle presents the pending choice as a blocking first-run modal: the GUI shows the enforcement suffix on the permission chip and the reason and remediation in its picker, while confined operations fail closed until the user switches preset.
- `onUnavailable: 'ask'` has no acknowledgement channel, so a user who accepts unconfined work does so through the existing Full access risk confirmation rather than a startup dialog.
