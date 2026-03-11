import type { QueueConfig, QueueMessage, StoredMessage } from "./types.ts";
import type { MessageStorage } from "./abstracts/MessageStorage.ts";
import type { MessageAction } from "./abstracts/MessageAction.ts";
import type { RetryStrategy } from "./abstracts/RetryStrategy.ts";
import type { MessageInvoker } from "./abstracts/MessageInvoker.ts";

/**
 * Core orchestrator — the single entry point for every serverless invocation.
 *
 * Wire it up once at the top of your serverless function, then call
 * `queue.handle(message)` with the parsed request body.
 *
 * ## Invocation flow
 *
 * **New message (`type: 'new'`)**
 * 1. Read the most-recent message for `queueId` from storage.
 * 2. If that message is `'pending'` or `'processing'` (queue busy):
 *    - Write the incoming message as `'pending'` and return immediately.
 * 3. If the queue is idle (`'done'` / `'failed'` / no messages):
 *    - Write as `'pending'`, immediately promote to `'processing'`, then execute.
 *
 * **Retry / Flush (`type: 'retry' | 'flush'`)**
 * - Skip the busy check (a `'processing'` row from the previous invocation
 *   already acts as the lock).
 * - Promote to `'processing'` and execute.
 *
 * **After success**
 * - Mark message `'done'`.
 * - If pending messages remain, fire a self-invocation (fire-and-forget)
 *   with the next batch according to `batchMode`, then return 200.
 *
 * **After failure**
 * - If `shouldRetry` returns `true` and attempts remain:
 *   increment `attempt`, fire a self-retry invocation, return 200.
 * - Otherwise call `onExhausted`, mark `'failed'`, drain pending queue.
 *
 * @template T  Shape of the business payload — inferred from the `MessageAction`.
 */
export class MessageQueue<T = unknown> {
  private readonly storage: MessageStorage;
  private readonly action: MessageAction<T>;
  private readonly retryStrategy: RetryStrategy<T>;
  private readonly invoker: MessageInvoker<T>;
  private readonly config: QueueConfig;

  constructor(
    storage: MessageStorage,
    action: MessageAction<T>,
    retryStrategy: RetryStrategy<T>,
    invoker: MessageInvoker<T>,
    config: QueueConfig,
  ) {
    this.storage = storage;
    this.action = action;
    this.retryStrategy = retryStrategy;
    this.invoker = invoker;
    this.config = config;
  }

  /**
   * Handle a single inbound invocation.
   * Call this with the parsed JSON body of every request to your serverless function.
   *
   * The method always resolves (never throws) so the function can always
   * return HTTP 200 — preventing platform-level retries from kicking in.
   */
  async handle(message: QueueMessage<T>): Promise<void> {
    try {
      if (message.type === "new") {
        const shouldDefer = await this.isBusy(message.queueId);

        if (shouldDefer) {
          await this.storage.writeMessage(
            this.toStoredMessage(message, "pending"),
          );
          return;
        }

        // Queue is idle — write then immediately take ownership.
        await this.storage.writeMessage(
          this.toStoredMessage(message, "pending"),
        );
        await this.storage.updateMessage(
          this.toStoredMessage(message, "processing"),
        );
      } else {
        // 'retry' or 'flush' — previous invocation already holds the processing slot.
        await this.storage.updateMessage(
          this.toStoredMessage(message, "processing"),
        );
      }

      await this.process(message);
    } catch (error) {
      // Storage failures in the setup phase — the message stays in its current
      // state for external recovery (e.g. a TTL-based cleanup job).
      // Swallow the error to honour the "never throws" contract so the
      // serverless platform always receives HTTP 200 and won't retry blindly.
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Execute the action and handle success / failure paths.
   */
  private async process(message: QueueMessage<T>): Promise<void> {
    try {
      await this.action.execute(message);
      await this.onSuccess(message);
    } catch (error) {
      await this.onFailure(message, error);
    }
  }

  private async onSuccess(message: QueueMessage<T>): Promise<void> {
    await this.storage.updateMessage(this.toStoredMessage(message, "done"));
    await this.drainPending(message.queueId);
  }

  private async onFailure(
    message: QueueMessage<T>,
    error: unknown,
  ): Promise<void> {
    const canRetry =
      message.attempt < this.config.maxAttempts - 1 &&
      this.retryStrategy.shouldRetry(message, error);

    if (canRetry) {
      const retried: QueueMessage<T> = {
        ...message,
        attempt: message.attempt + 1,
        type: "retry",
      };
      // Keep the row in 'processing' state — the next invocation inherits ownership.
      await this.storage.updateMessage(
        this.toStoredMessage(retried, "processing"),
      );
      this.selfInvoke(retried);
      return;
    }

    // Exhausted — hand off and mark failed, then unblock pending queue.
    // onExhausted is user-land code (DLQ, alerting, etc.) — isolate its
    // failure so the queue still advances even if that side-effect errors.
    try {
      await this.retryStrategy.onExhausted(message);
    } catch {
      // onExhausted failed — continue to mark failed and drain.
    }
    await this.storage.updateMessage(this.toStoredMessage(message, "failed"));
    await this.drainPending(message.queueId);
  }

  /**
   * If pending messages exist, fire a self-invocation for each message in the
   * next batch (up to `batchSize`) and return immediately.
   */
  private async drainPending(queueId: string): Promise<void> {
    const { batchSize } = this.config;
    const pending = await this.storage.readMessagesByQueue(
      queueId,
      "pending",
      batchSize,
    );
    if (pending.length === 0) return;

    for (const stored of pending) {
      const msg = this.fromStoredMessage(stored);
      this.selfInvoke({ ...msg, type: "flush" });
    }
  }

  /**
   * Fire-and-forget self-invocation via the injected `MessageInvoker`.
   * On failure, immediately fires a new invoke attempt and returns — the
   * current instance is never blocked waiting for retries.
   * Once `invokeRetries` attempts are exhausted the message remains in its
   * current state so an external recovery job (e.g. cron) can pick it up.
   */
  private selfInvoke(message: QueueMessage<T>, invokeAttempt = 0): void {
    this.invoker.invoke(message).catch(() => {
      const maxRetries = this.config.invokeRetries ?? 3;
      if (invokeAttempt < maxRetries) {
        this.selfInvoke(message, invokeAttempt + 1);
      }
      // Retries exhausted — message stays in current state for recovery.
    });
  }

  /**
   * A queue is busy if its most-recent message is still in-flight
   * (`'pending'` or `'processing'`).
   */
  private async isBusy(queueId: string): Promise<boolean> {
    const last = await this.storage.readLastMessageByQueue(queueId);
    if (!last) return false;
    return last.state === "pending" || last.state === "processing";
  }

  /**
   * Serialize a `QueueMessage` into the storage row format.
   */
  private toStoredMessage(
    message: QueueMessage<T>,
    state: StoredMessage["state"],
  ): StoredMessage {
    return {
      id: message.id,
      queueId: message.queueId,
      message: JSON.stringify(message),
      timestamp: message.createdAt,
      state,
    };
  }

  /**
   * Deserialize a storage row back into a `QueueMessage`.
   * Throws if the stored JSON is malformed — surfaces at the orchestrator
   * boundary, not deep in the DB layer.
   */
  private fromStoredMessage(stored: StoredMessage): QueueMessage<T> {
    return JSON.parse(stored.message) as QueueMessage<T>;
  }
}
