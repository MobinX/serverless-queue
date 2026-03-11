import type { QueueMessage } from "../types.ts";

/**
 * Abstract business-logic handler for a batch of queue messages.
 *
 * Implementers contain the actual work to be done — sending an email,
 * calling a third-party API, writing to a database, etc.
 *
 * The method receives an array of fully-typed `QueueMessage<T>` envelopes so
 * it has access to metadata (attempt count, queueId, createdAt) as well as
 * the business payload for each message.
 *
 * Throw any error to signal failure — the orchestrator will catch it
 * and delegate to `RetryStrategy`.
 *
 * @template T  Shape of the business payload.
 *
 * @example
 * ```ts
 * class SendEmailAction extends MessageAction<{ to: string; subject: string }> {
 *   async execute(messages) {
 *     for (const message of messages) {
 *       await emailClient.send(message.payload);
 *     }
 *   }
 * }
 * ```
 */
export abstract class MessageAction<T = unknown> {
  /**
   * Execute the business logic for this batch of messages.
   * @throws Any error to indicate failure and trigger retry logic.
   */
  abstract execute(messages: QueueMessage<T>[]): Promise<void>;
}
