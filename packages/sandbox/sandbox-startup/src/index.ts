/**
 * Startup authority for the deployment's sandbox mode (`ctx.sandboxStartup`).
 * It asks the mounted sandbox provider what this host can enforce
 * ({@link SandboxProvider.availability}) and resolves the one mode every
 * consumer starts from: an explicit mode when a deployment states one,
 * `workspace-write` when a backend exists, and otherwise the deployment's
 * declared {@link SandboxUnavailablePolicy}. No path turns confinement off
 * silently: an explicit confined mode without a backend fails closed, and the
 * GUI `ask` policy keeps the confined mode while reporting `awaitingChoice`, so
 * confined operations fail closed until the user explicitly confirms a wider
 * mode through the permission UI.
 *
 * The resolved mode is the authoritative source for the base and headless
 * bundles (`ctx.sandboxStartup.mode` feeds `sandbox-policy`'s `mode`) and for
 * the paired approval policy, so the default mode always names a preset the
 * permission table carries (each preset row is a mode/approval pair).
 * @module @deepseek-ai/dsh-sandbox-startup
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SandboxAvailability, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { resolveDefaultMode, type SandboxUnavailablePolicy } from './resolve.ts'

export { SandboxStartupUnavailableError } from './resolve.ts'
export type { DefaultModeDecision, DefaultModeRequest, SandboxUnavailablePolicy } from './resolve.ts'

export type { SandboxAvailability, SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxStartup: SandboxStartupService
  }

  interface Events {
    /**
     * This process published a new sandbox availability verdict and the
     * startup decision that follows it. Payload-carrying and non-vetoing:
     * consumers re-read `ctx.sandboxStartup` for the complete decision.
     * @mode emit
     * @param availability - the verdict the published decision was resolved from.
     */
    'sandbox/availability-changed'(availability: SandboxAvailability): void
  }
}

/** Plugin config. `mode` is the explicit deployment mode; the unavailable policy is required to be stated. */
export interface Config {
  /**
   * Explicit starting mode from the deployment (`DSH_PERMISSION_MODE` in the
   * shipped bundles). Absent means the host decides per
   * {@link SandboxUnavailablePolicy}; an explicit confined mode without a
   * backend fails closed.
   */
  mode?: SandboxMode
  /** Behavior when this host has no confining backend; the safe default is `fail`. */
  onUnavailable?: SandboxUnavailablePolicy
}

/**
 * The starting sandbox mode for this process, published as
 * `ctx.sandboxStartup`. Resolved once at construction from the mounted
 * `ctx.sandbox` provider's availability, so every consumer of the deployment
 * default ({@link mode}) and of its paired approval policy reads one decision.
 */
export class SandboxStartupService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const),
    onUnavailable: z.union(['ask', 'danger-full-access', 'fail'] as const).default('fail'),
  })

  static inject = ['sandbox']

  /** The starting file-effect mode every consumer resolves from. */
  readonly mode: SandboxMode
  /** This host's provider availability verdict. */
  readonly availability: SandboxAvailability
  /** Whether this host has no backend while the deployment still starts confined, so a user must choose a wider mode. */
  readonly awaitingChoice: boolean
  /** The approval policy pairing with {@link mode}. */
  readonly approvalPolicy: 'ask' | 'never'
  /** Whether {@link mode} came from explicit configuration. */
  readonly explicit: boolean

  /**
   * @param ctx - owning context; requires the mounted sandbox provider.
   * @param config - the explicit mode and the declared unavailable policy.
   * @throws `SandboxStartupUnavailableError` when the decision must fail closed.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxStartup')
    const availability = ctx.sandbox.availability()
    const decision = resolveDefaultMode({
      ...config.mode === undefined ? {} : { mode: config.mode },
      availability,
      onUnavailable: config.onUnavailable as SandboxUnavailablePolicy,
    })
    if (config.mode !== undefined && !availability.available && config.mode === 'danger-full-access') {
      this.ctx.logger.warn(
        `sandbox-startup: running with danger-full-access because it was requested explicitly; ${availability.reason}`,
      )
    }
    if (decision.mode === 'danger-full-access' && !availability.available && !decision.explicit) {
      this.ctx.logger.warn(
        `sandbox-startup: this deployment accepts danger-full-access because no sandbox backend is usable; `
        + `${availability.reason} ${availability.remediation}`,
      )
    }
    if (decision.awaitingChoice) {
      this.ctx.logger.warn(
        `sandbox-startup: no sandbox backend is usable on this host, so sessions start in ${decision.mode} and every `
        + `confined operation fails closed until a user explicitly switches to danger-full-access. `
        + `${availability.reason} ${availability.remediation}`,
      )
    }
    this.mode = decision.mode
    this.availability = availability
    this.awaitingChoice = decision.awaitingChoice
    this.approvalPolicy = decision.approvalPolicy
    this.explicit = decision.explicit
  }

  protected [Service.init](): void {
    // Consumers subscribe first (Loader wiring order), then read the service;
    // the verdict is published once per process because providers cache their
    // chain verdict for the same lifetime.
    this.ctx.emit('sandbox/availability-changed', this.availability)
  }
}

export default SandboxStartupService
