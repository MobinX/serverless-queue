import type { QueueMessage } from "../types.ts";

/**
 * Abstract strategy that controls retry behaviour and dead-letter handling.
 *
 * Pluggable so callers can implement exponential back-off, circuit-breaker
 * patterns, error-type filtering, or any other retry policy.
 *
 * @template T  Shape of the business payload.
 *
 * @example
 * ```ts
 * class SimpleRetryStrategy extends RetryStrategy<MyPayload> {
 *   shouldRetry(_message, error) {
 *     // Only retry network errors, not validation errors
 *     return error instanceof NetworkError;
 *   }
 *   async onExhausted(message) {
 *     await deadLetterQueue.push(message);
 *     await alerting.notify(`Message ${message.id} exhausted`);
 *   }
 * }
 * ```
 */
export abstract class RetryStrategy<T = unknown> {
  /**
   * Decide whether the message should be retried after `error` was thrown.
   *
   * Called only when `message.attempt < config.maxAttempts`.
   * Return `false` to skip remaining attempts and go straight to `onExhausted`.
   *
   * @param message  The message that just failed (attempt count not yet incremented).
   * @param error    The error thrown by `MessageAction.execute`.
   */
  abstract shouldRetry(message: QueueMessage<T>, error: unknown): boolean;

  /**
   * Called when the message has exhausted all retry attempts
   * (`shouldRetry` returned `false`, or `attempt >= maxAttempts`).
   *
   * Use this hook to push to a dead-letter queue, send alerts,
   * log to an observability platform, etc.
   *
   * After this resolves the orchestrator marks the message `'failed'`
   * and unblocks the queue for any remaining pending messages.
   */
  abstract onExhausted(message: QueueMessage<T>): Promise<void>;
}
