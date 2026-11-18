import { join } from 'node:path'
import type { ConfinedArgv, SandboxAvailability, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'

const NOTICE = 'landlock-run: partial enforcement (older Landlock ABI)'
const MISSING_RUNNER_ENV = 'DSH_SNAPSHOT_MISSING_SANDBOX_RUNNER'

/**
 * Snapshot-only provider for deterministic runner classification. Its default
 * launch reproduces older-ABI Landlock; an explicit scenario flag selects a
 * missing executable under the valid workspace cwd. Keep the Landlock tuple
 * aligned with `RUNNER_FAILURE_RULES` in `packages/sandbox/sandbox-local/src/index.ts`.
 */
export default class PartialLandlockSandboxProvider extends SandboxProvider {
  /** The fixture reproduces an older-ABI Landlock host, so it reports partial enforcement. */
  availability(): SandboxAvailability {
    return {
      available: true,
      backend: 'snapshot-landlock',
      enforcement: 'partial',
      reason: 'Snapshot fixture reproducing older-ABI Landlock enforcement.',
      remediation: 'none (test fixture)',
    }
  }

  async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    if (process.env[MISSING_RUNNER_ENV] === '1') {
      return {
        argv: [join(policy.workspaceRoot, '.dsh-missing-sandbox-runner'), ...argv],
        enforcement: 'full',
        denialSignatures: ['permission denied'],
        runnerFailureRules: [{ fatalSignatures: ['snapshot-runner: '] }],
      }
    }
    return {
      argv: [
        'bash',
        '-c',
        `printf '%s\\n' '${NOTICE}' >&2; exec "$@"`,
        'partial-landlock-run',
        ...argv,
      ],
      enforcement: 'partial',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{
        allowedExitCodes: [125],
        fatalSignatures: ['landlock-run: '],
        informationalLines: [NOTICE],
      }],
    }
  }
}
