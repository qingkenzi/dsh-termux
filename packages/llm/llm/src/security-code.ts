import type { BuiltinLlmFailureCode } from './error.ts'

/** Stable failure code for a provider endpoint that would carry credentials over untrusted transport. */
export const INSECURE_BASE_URL_CODE = 'INSECURE_BASE_URL' satisfies BuiltinLlmFailureCode
