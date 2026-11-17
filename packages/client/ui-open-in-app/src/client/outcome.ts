/** Settled native gestures shared by directory, path, and delivery controls. */
import type { PresentedOpenFailure, PresentedOpenOutcome } from '@deepseek-ai/dsh-client-ui-deliverables/client'

/**
 * Failure kind of one settled gesture, keyed to the `path.*` copy it announces.
 * `managerUnavailable` names a missing Host opener and asks the user to copy the
 * path, which is the only remaining action on such a Host.
 */
export type OpenInAppPathFailure = PresentedOpenFailure | 'managerUnavailable'

/** Acknowledged open or reveal, named failure, or deliberately skipped gesture. */
export type OpenInAppOutcome =
  | Exclude<PresentedOpenOutcome, { kind: 'failed' }>
  | { readonly kind: 'failed'; readonly failure: OpenInAppPathFailure }
