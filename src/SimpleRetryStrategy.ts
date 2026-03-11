import { RetryStrategy } from './abstracts/RetryStrategy.ts'
import type { QueueMessage } from './types.ts'

export interface SimpleRetryStrategyOptions<T = unknown> {
  /**
   * Custom predicate — return false to skip remaining attempts.
   * Defaults to always returning true (retry everything).
   */
  shouldRetry?: (message: QueueMessage<T>, error: unknown) => boolean
  /**
   * Called when all attempts are exhausted.
   * Use for DLQ writes, alerts, logging, etc.
   * Errors thrown here are swallowed by the orchestrator — always guard internally.
   */
  onExhausted?: (message: QueueMessage<T>) => Promise<void>
}

export class SimpleRetryStrategy<T = unknown> extends RetryStrategy<T> {
  constructor(private readonly options: SimpleRetryStrategyOptions<T> = {}) {
    super()
  }

  shouldRetry(message: QueueMessage<T>, error: unknown): boolean {
    return this.options.shouldRetry ? this.options.shouldRetry(message, error) : true
  }

  async onExhausted(message: QueueMessage<T>): Promise<void> {
    if (this.options.onExhausted) {
      await this.options.onExhausted(message)
    }
  }
}
