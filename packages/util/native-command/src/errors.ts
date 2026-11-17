/** Coded failures for native path and application handoffs. */
import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Native-command failure codes. Host surfaces route on these instead of
 * command output, so a missing opener is distinguishable from a refused
 * launch and a platform with no association query.
 */
export type NativeCommandErrorCode =
  | 'NATIVE_FILE_ASSOCIATIONS_UNSUPPORTED'
  | 'NATIVE_FILE_MANAGER_UNAVAILABLE'
  | 'NATIVE_FILE_OPEN_FAILED'

/**
 * One failed native path or application operation.
 * Messages stay user-safe; the underlying command failure is retained as `cause`.
 */
export class NativeCommandError extends HarnessError {
  /** Stable failure class callers route on. */
  override readonly code: NativeCommandErrorCode

  /**
   * @param message - diagnostic naming the operation that failed.
   * @param code - stable failure class.
   * @param options - standard Error options; `cause` keeps the command failure.
   */
  constructor(message: string, code: NativeCommandErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
    this.name = 'NativeCommandError'
  }
}
