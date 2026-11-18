/**
 * Pure types of the permission domain: the ONE home of the `permissions`
 * projection-key declaration plus its payload types, free of this package's
 * host-side value imports (cordis, schemastery). Two namespace projections
 * serve it — the package root re-export for host consumers, `./client` (the
 * browser half-entry's re-export) for client aggregates — with zero content
 * duplication.
 *
 * @module @deepseek-ai/dsh-permission-presets/types
 */

/** Presentation for an available preset or the derived `custom` current value. */
export interface PresetOption {
  /** Stable option value: a configured preset key, live `auto`, or derived `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means; omitted when not configured. */
  description?: string
}

/**
 * Enforcement a host actually delivers for its confined modes. `none` means no
 * backend confines this host, so confined presets would fail closed.
 */
export type SandboxAvailabilityEnforcementView = 'full' | 'partial' | 'none'

/**
 * This host's sandbox availability as the client presents it. The values come
 * from the process-level startup decision, not from Session history.
 */
export interface SandboxAvailabilityView {
  /** Whether a backend can enforce at least one confined mode on this host. */
  available: boolean
  /** Stable identifier of the backend that would confine, or `none`. */
  backend: string
  /** Enforcement the backend achieves; `none` when unavailable. */
  enforcement: SandboxAvailabilityEnforcementView
  /** One user-facing sentence explaining the verdict. */
  reason: string
  /** Actionable next step for a user who needs confinement. */
  remediation: string
  /** Whether unconfined work waits for an explicit user choice behind per-action approval. */
  awaitingChoice: boolean
}

/**
 * Process-level permission catalog. It changes with live contributions and is
 * deliberately separate from Session history.
 */
export interface PermissionCatalog {
  /** Every currently selectable preset, in contribution order. */
  options: PresetOption[]
  /** Configured presets eligible as defaults for future sessions. */
  defaultOptions: PresetOption[]
  /** Effective default when the Config field is omitted. */
  defaultPreset: string
  /** What this host can actually enforce behind those presets. */
  sandbox: SandboxAvailabilityView
}

/** Whole `permissions` Session projection: current durable selection only. */
export interface PermissionSelection {
  /** The effective current value: a configured preset key, `auto`, or `custom`. */
  currentValue: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The selectable process catalog changed. Payload-free by design:
     * consumers subscribe first, then re-read the complete catalog.
     * @mode emit
     */
    'permission-presets/catalog-changed'(): void
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current permission, folded from the three whole-value
     * knob events (`permission/preset`, `sandbox/mode`, `approval/policy`)
     * over the composition defaults. Selectable options come from the
     * process-level catalog Remote. Key absence means no permission service
     * is composed — clients hide the control.
     */
    permissions: PermissionSelection
  }
}
