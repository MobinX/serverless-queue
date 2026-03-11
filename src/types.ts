/**
 * Discriminates whether an inbound invocation is a brand-new message,
 * a retry of a failed message, or a flush of queued pending messages.
 */
export type MessageType = "new" | "retry" | "flush";

/**
 * Lifecycle states a stored message moves through.
 *
 *   pending ──► processing ──► done
 *                    │
 *                    └────────► failed  (retries exhausted)
 *
 * The presence of a 'processing' or 'pending' row in the most-recent
 * position acts as the queue's busy signal — no separate lock needed.
 */
export type MessageState = "pending" | "processing" | "done" | "failed";

/**
 * The envelope that travels in every HTTP request body between invocations.
 * Every message MUST carry `queueId` so each invocation is fully self-contained.
 *
 * @template T  Shape of the business payload.
 */
export interface QueueMessage<T = unknown> {
  /** Unique message identifier (UUID recommended). */
  id: string;

  /**
   * Queue partition key — e.g. userId, tenantId, orderId.
   * All messages with the same queueId are processed serially.
   */
  queueId: string;

  /** The typed business payload for this message. */
  payload: T;

  /**
   * Zero-indexed attempt counter.
   * Incremented by the orchestrator before each retry self-invocation.
   */
  attempt: number;

  /** Unix timestamp (ms) when the message was first created. */
  createdAt: number;

  /** Invocation type — determines entry-point behaviour in the orchestrator. */
  type: MessageType;
}

/**
 * The raw row persisted to storage.
 * Payload is stored as an opaque JSON string so the storage layer
 * stays fully type-agnostic and works with any database.
 */
export interface StoredMessage {
  /** Unique message identifier — matches QueueMessage.id. */
  id: string;

  /** Queue partition key — matches QueueMessage.queueId. */
  queueId: string;

  /**
   * JSON-stringified QueueMessage envelope (including payload).
   * The storage layer treats this as opaque bytes.
   */
  message: string;

  /**
   * Unix timestamp (ms) of when this record was written.
   * Used for ordering — implementations MUST preserve insertion order.
   */
  timestamp: number;

  /** Current lifecycle state. */
  state: MessageState;
}

/**
 * Static configuration injected into MessageQueue at construction time.
 */
export interface QueueConfig {
  /**
   * Maximum number of messages to fetch from the pending queue and fire
   * as self-invocations in a single drain cycle.
   *
   * - Use a small number (e.g. `5`) to avoid platform payload / concurrency limits.
   * - Use `Infinity` to drain the entire pending queue in one cycle (use with caution).
   *
   * Each message still results in its own self-invocation — `batchSize` only
   * controls how many are dispatched in parallel per drain cycle.
   */
  batchSize: number;

  /**
   * Maximum number of attempts (including the first) before a message
   * is handed to RetryStrategy.onExhausted and marked 'failed'.
   */
  maxAttempts: number;

  /**
   * How many times the orchestrator will retry a failed self-invocation
   * (i.e. when `MessageInvoker.invoke` throws) before giving up.
   *
   * Defaults to `3` if not provided.
   * The message remains `'pending'` in storage if all invoke retries are
   * exhausted, allowing external recovery (e.g. a cron-based cleanup job).
   */
  invokeRetries?: number;

  /**
   * Controls how `drainPending` fires self-invocations after a message
   * completes (successfully or after exhausting retries).
   *
   * - `'individual'` (default) — fires one self-invocation per pending message.
   * - `'bulk'` — fires one self-invocation carrying all pending messages as a
   *   single batch.
   */
  drainMode?: 'bulk' | 'individual';
}
