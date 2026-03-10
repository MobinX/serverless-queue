import type { MessageState, StoredMessage } from "../types.ts";

/**
 * Abstract persistence layer for the queue.
 *
 * Implementers map these six methods to their database of choice
 * (PostgreSQL, DynamoDB, Redis, SQLite, etc.).
 *
 * The storage layer is intentionally non-generic: the `message` field
 * on StoredMessage is an opaque JSON string. MessageQueue owns
 * serialization/deserialization at its boundary.
 *
 * ## Required DB index
 * Efficient operation requires a composite index on **(queueId, timestamp)**.
 * Without it, `readLastMessageByQueue` and `readMessagesByQueue` will full-scan.
 *
 * ## Atomicity
 * The orchestrator's `pending → processing` transition is two sequential
 * calls (`readLastMessageByQueue` then `updateMessage`). To prevent races
 * under concurrent invocations you should wrap these in:
 * - A DB transaction (PostgreSQL, SQLite)
 * - A conditional write (DynamoDB `ConditionExpression`, MongoDB `findOneAndUpdate`)
 * - An atomic SETNX-style primitive (Redis)
 *
 * @example
 * ```ts
 * class PostgresStorage extends MessageStorage {
 *   async readMessage(id) { ... }
 *   async writeMessage(msg) { ... }
 *   async updateMessage(msg) { ... }
 *   async deleteMessage(id) { ... }
 *   async readLastMessageByQueue(queueId) { ... }
 *   async readMessagesByQueue(queueId, state) { ... }
 * }
 * ```
 */
export abstract class MessageStorage {
  // ── Core CRUD ──────────────────────────────────────────────────────────────

  /**
   * Retrieve a single message by its unique ID.
   * Returns `null` if no record exists with that ID.
   */
  abstract readMessage(id: string): Promise<StoredMessage | null>;

  /**
   * Persist a new message record (INSERT).
   * The caller guarantees `id` is unique; implementations should throw
   * on a duplicate ID rather than silently overwriting.
   */
  abstract writeMessage(message: StoredMessage): Promise<void>;

  /**
   * Update an existing message record in-place (UPDATE by `id`).
   * Typically used to advance the `state` field through the lifecycle.
   *
   * Implementations are encouraged to use conditional / optimistic writes
   * to guard against concurrent state transitions (see class-level note).
   */
  abstract updateMessage(message: StoredMessage): Promise<void>;

  /**
   * Permanently remove a message by ID (DELETE).
   * Called by the orchestrator when a message reaches `'done'` and the
   * implementer prefers hard-deletes over keeping history.
   */
  abstract deleteMessage(id: string): Promise<void>;

  // ── Queue Queries ──────────────────────────────────────────────────────────

  /**
   * Return the **single most-recent message** for a queue
   * (ORDER BY timestamp DESC LIMIT 1).
   *
   * This is the primary busy-check used by the orchestrator:
   * - state `'pending'` or `'processing'` → queue is busy
   * - state `'done'` / `'failed'` / `null` → queue is idle
   *
   * Returns `null` if the queue has no messages at all.
   */
  abstract readLastMessageByQueue(
    queueId: string,
  ): Promise<StoredMessage | null>;

  /**
   * Return messages for a queue matching the given `state`,
   * ordered by **timestamp ASC** (oldest-first — FIFO order).
   *
   * @param queueId  The queue partition key.
   * @param state    Filter by lifecycle state. Omit to return all states.
   * @param limit    Maximum number of rows to return. Maps directly to a
   *                 SQL `LIMIT` clause or equivalent. Omit for no limit.
   *                 The orchestrator passes `QueueConfig.batchSize` here
   *                 during drain cycles.
   */
  abstract readMessagesByQueue(
    queueId: string,
    state?: MessageState,
    limit?: number,
  ): Promise<StoredMessage[]>;

  /**
   * Return a limited number of messages for a queue that are in the 'pending' state,
   * ordered by **timestamp ASC** (FIFO).
   *
   * Used for batch processing or looking ahead in the queue.
   */
  abstract readPendingMessages(
    queueId: string,
    limit: number,
  ): Promise<StoredMessage[]>;
}
