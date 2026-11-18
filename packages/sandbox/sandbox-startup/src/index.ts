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
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SandboxAvailability, SandboxMode } from '@deepseek-ai/dsh-sandbox'

export type { SandboxAvailability, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * What a deployment does when this host has no confining backend. No policy
 * reaches `danger-full-access` on its own:
 * - `ask` — start confined anyway, so every confined operation fails closed
 *   with an actionable denial while the user sees the availability banner and
 *   the permission chip; switching to full access stays their explicit,
 *   risk-confirmed choice (the GUI default).
 * - `danger-full-access` — the deployment states that unconfined file effects
 *   are acceptable here (an explicit deployment assertion, logged at startup).
 * - `fail` — refuse to start (the headless and package default).
 */
export type SandboxUnavailablePolicy = 'ask' | 'danger-full-access' | 'fail'

/** Every {@link SandboxUnavailablePolicy} value, in documentation order. */
export const SANDBOX_UNAVAILABLE_POLICIES = ['ask', 'danger-full-access', 'fail'] as const

/** Error code for a startup decision that cannot be satisfied. */
export const SANDBOX_STARTUP_UNAVAILABLE = 'SANDBOX_STARTUP_UNAVAILABLE'

/**
 * Thrown when startup must fail closed: an explicit confined mode on a host
 * with no backend, or `onUnavailable: 'fail'` without one. Carries
 * {@link SANDBOX_STARTUP_UNAVAILABLE} through the structured error channel.
 */
export class SandboxStartupUnavailableError extends HarnessError {
  /**
   * @param message - names the requested mode, the host verdict, and every actionable next step.
   */
  constructor(message: string) {
    super(message, SANDBOX_STARTUP_UNAVAILABLE)
    this.name = 'SandboxStartupUnavailableError'
  }
}

/** Inputs to {@link resolveDefaultMode}; every value is explicit so the decision is testable without process state. */
export interface DefaultModeRequest {
  /** Mode stated by configuration, `DSH_PERMISSION_MODE`, or `--permission-mode`; absent when the deployment states none. */
  mode?: SandboxMode
  /** This host's provider availability verdict. */
  availability: SandboxAvailability
  /** The deployment's declared behavior when no backend exists. */
  onUnavailable: SandboxUnavailablePolicy
}

/** The startup mode decision plus the facts other services pair with it. */
export interface DefaultModeDecision {
  /** The mode every consumer starts from. */
  mode: SandboxMode
  /** Whether {@link mode} came from explicit configuration rather than host capability. */
  explicit: boolean
  /**
   * Whether the deployment has no backend and still starts confined under
   * `onUnavailable: 'ask'`: confined operations fail closed, and the user must
   * pick a mode themselves before file-modifying work can run.
   */
  awaitingChoice: boolean
  /** The approval policy that pairs with {@link mode}: `never` only for an accepted unconfined mode. */
  approvalPolicy: 'ask' | 'never'
}

/** The fail-closed report for one unsatisfiable decision. */
function refuse(request: DefaultModeRequest, requested: string, override: string): never {
  const { availability } = request
  throw new SandboxStartupUnavailableError(
    `sandbox-startup: ${requested} is requested but no sandbox backend can enforce it on this host `
    + `(backend: ${availability.backend}; ${availability.reason}). The command would run unconfined, so startup refuses. `
    + `To continue with unconfined file effects, ${override}. To enable confinement, ${availability.remediation}`,
  )
}

/**
 * Resolve the deployment's starting file-effect mode. Precedence is explicit
 * configuration, then host capability, then the declared unavailable policy —
 * and no branch reaches `danger-full-access` without either an explicit
 * request or that declared policy.
 * @param request - the explicit mode if any, this host's availability, and the deployment's unavailable policy.
 * @returns the starting mode with its explicitness, pending-choice, and paired approval facts.
 * @throws `SandboxStartupUnavailableError` when an explicit confined mode has no backend, or when
 *   `onUnavailable: 'fail'` meets a host with no backend.
 */
export function resolveDefaultMode(request: DefaultModeRequest): DefaultModeDecision {
  const { mode, availability, onUnavailable } = request
  if (mode !== undefined) {
    if (mode === 'danger-full-access') {
      return { mode, explicit: true, awaitingChoice: false, approvalPolicy: 'never' }
    }
    if (availability.available) {
      return { mode, explicit: true, awaitingChoice: false, approvalPolicy: 'ask' }
    }
    return refuse(request, `sandbox mode "${mode}"`, 'set DSH_PERMISSION_MODE=danger-full-access or configure onUnavailable: danger-full-access explicitly')
  }
  if (availability.available) {
    return { mode: 'workspace-write', explicit: false, awaitingChoice: false, approvalPolicy: 'ask' }
  }
  switch (onUnavailable) {
    case 'danger-full-access':
      return { mode: 'danger-full-access', explicit: false, awaitingChoice: false, approvalPolicy: 'never' }
    case 'ask':
      // Confined on paper and fail-closed in practice: every confined operation
      // denies with the provider's actionable SANDBOX_UNAVAILABLE report, and
      // only the user's explicit, risk-confirmed switch runs unconfined work.
      return { mode: 'workspace-write', explicit: false, awaitingChoice: true, approvalPolicy: 'ask' }
    case 'fail':
      return refuse(request, 'a confined default mode', 'set DSH_PERMISSION_MODE=danger-full-access or configure onUnavailable: danger-full-access (or ask)')
    default:
      return refuse(request, `onUnavailable "${String(onUnavailable)}"`, 'configure onUnavailable as ask, danger-full-access, or fail')
  }
}

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
    onUnavailable: z.union([...SANDBOX_UNAVAILABLE_POLICIES] as SandboxUnavailablePolicy[]).default('fail'),
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
