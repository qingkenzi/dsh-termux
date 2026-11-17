/** Mutable credential records used by the token implementation tests. */
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'

export class RecordCredentials extends CredentialProvider {
  constructor() {
    const ctx = new Context()
    super(ctx)
    onTestFinished(() => ctx.fiber.dispose())
  }

  override resolve(): never { throw new Error('Reference resolution is outside this fixture') }
  override describe(): never { throw new Error('Reference description is outside this fixture') }
  override set(): never { throw new Error('Reference writes are outside this fixture') }
  override unset(): never { throw new Error('Reference removal is outside this fixture') }
  override describeRecord(): never { throw new Error('Record description is outside this fixture') }
  override listRecords(): never { throw new Error('Record enumeration is outside this fixture') }
  records = new Map<string, CredentialRecord>()
  discardWrites = false
  reads = 0
  modifies = 0

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.records.get(key))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.records.get(key))
    if (this.discardWrites) return undefined
    if (next !== undefined) this.records.set(key, next)
    return this.records.get(key)
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}
