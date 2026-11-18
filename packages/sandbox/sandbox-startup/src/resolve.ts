/**
 * Pure sandbox startup decision: explicit configuration, host availability, and the
 * deployment's no-backend policy resolve to the one mode and paired approval policy.
 * Kept out of the plugin entry so the Loader entry exports only what it loads.
 * @module @deepseek-ai/dsh-sandbox-startup/resolve
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SandboxAvailability, SandboxMode } from '@deepseek-ai/dsh-sandbox'

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
