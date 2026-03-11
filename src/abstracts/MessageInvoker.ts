import type { QueueMessage } from "../types.ts";

/**
 * Abstract self-invocation transport layer.
 *
 * The library's core orchestrator needs to fire HTTP calls back to itself
 * (to flush pending messages and to retry failed ones). Rather than
 * hard-coding a `fetch` call, this abstract class lets you plug in any
 * transport — native `fetch`, `axios`, a platform SDK, or even an in-process
 * stub for testing.
 *
 * Implementations are responsible for:
 * - Knowing the target URL (e.g. read from an env variable)
 * - Adding any authentication headers
 * - Serialising the message body
 *
 * The orchestrator will call `invoke` and retry it up to `invokeRetries`
 * times (configured in `QueueConfig`) if it throws.
 *
 * @template T  Shape of the business payload — must match the `MessageQueue`.
 *
 * @example
 * ```ts
 * class FetchInvoker extends MessageInvoker<MyPayload> {
 *   async invoke(messages) {
 *     const res = await fetch(process.env.QUEUE_URL!, {
 *       method: 'POST',
 *       headers: {
 *         'Content-Type': 'application/json',
 *         'Authorization': `Bearer ${process.env.QUEUE_SECRET}`,
 *       },
 *       body: JSON.stringify(messages),
 *     });
 *     if (!res.ok) throw new Error(`Self-invoke failed: ${res.status}`);
 *   }
 * }
 * ```
 */
export abstract class MessageInvoker<T = unknown> {
  /**
   * Fire a request to the queue's own serverless endpoint carrying `messages`.
   *
   * Throw any error to signal that the invocation failed — the orchestrator
   * will retry up to `QueueConfig.invokeRetries` times before giving up.
   *
   * Implementations MUST NOT swallow errors; let them propagate so the
   * retry logic in `MessageQueue` can act on them.
   */
  abstract invoke(messages: QueueMessage<T>[]): Promise<void>;
}
