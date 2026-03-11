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
   * Handle an array of inbound invocations.
   * Call this with the parsed JSON body of every request to your serverless function.
   *
   * The method always resolves (never throws) so the function can always
   * return HTTP 200 — preventing platform-level retries from kicking in.
   */
  async handle(messages: QueueMessage<T>[]): Promise<void> {
    try {
      if (!messages.length) return;
      const firstType = messages[0]!.type;

      if (firstType === 'new') {
        const toProcess: QueueMessage<T>[] = [];
        for (const message of messages) {
          const shouldDefer = await this.isBusy(message.queueId);
          await this.storage.writeMessage(this.toStoredMessage(message, 'pending'));
          if (!shouldDefer) {
            await this.storage.updateMessage(this.toStoredMessage(message, 'processing'));
            toProcess.push(message);
          }
        }
        if (toProcess.length > 0) await this.process(toProcess);
      } else {
        // 'retry' or 'flush' — previous invocation already holds the processing slot.
        for (const message of messages) {
          await this.storage.updateMessage(this.toStoredMessage(message, 'processing'));
        }
        await this.process(messages);
      }
    } catch {
      // Storage failures — swallow to honour "never throws" contract
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Execute the action and handle success / failure paths.
   */
  private async process(messages: QueueMessage<T>[]): Promise<void> {
    try {
      await this.action.execute(messages);
      await this.onSuccess(messages);
    } catch (error) {
      await this.onFailure(messages, error);
    }
  }

  private async onSuccess(messages: QueueMessage<T>[]): Promise<void> {
    for (const message of messages) {
      await this.storage.updateMessage(this.toStoredMessage(message, 'done'));
    }
    const queueIds = [...new Set(messages.map(m => m.queueId))];
    for (const queueId of queueIds) {
      await this.drainPending(queueId);
    }
  }

  private async onFailure(
    messages: QueueMessage<T>[],
    error: unknown,
  ): Promise<void> {
    const firstMsg = messages[0]!;
    const canRetry =
      firstMsg.attempt < this.config.maxAttempts - 1 &&
      this.retryStrategy.shouldRetry(firstMsg, error);

    if (canRetry) {
      const retried: QueueMessage<T>[] = messages.map(msg => ({
        ...msg,
        attempt: msg.attempt + 1,
        type: 'retry' as const,
      }));
      for (const msg of retried) {
        await this.storage.updateMessage(this.toStoredMessage(msg, 'processing'));
      }
      this.selfInvoke(retried);
      return;
    }

    // Exhausted — hand off and mark failed, then unblock pending queue.
    // onExhausted is user-land code (DLQ, alerting, etc.) — isolate its
    // failure so the queue still advances even if that side-effect errors.
    try {
      for (const msg of messages) await this.retryStrategy.onExhausted(msg);
    } catch {
      // onExhausted failed — continue to mark failed and drain.
    }
    for (const msg of messages) {
      await this.storage.updateMessage(this.toStoredMessage(msg, 'failed'));
    }
    const queueIds = [...new Set(messages.map(m => m.queueId))];
    for (const queueId of queueIds) {
      await this.drainPending(queueId);
    }
  }

  /**
   * If pending messages exist, fire self-invocations for the next batch
   * (up to `batchSize`) and return immediately. Behaviour depends on
   * `drainMode`: `'bulk'` sends all pending messages in one invoke;
   * `'individual'` (default) sends one invoke per message.
   */
  private async drainPending(queueId: string): Promise<void> {
    const { batchSize, drainMode } = this.config;
    const pending = await this.storage.readMessagesByQueue(
      queueId,
      'pending',
      batchSize,
    );
    if (pending.length === 0) return;

    const msgs = pending.map(stored => ({
      ...this.fromStoredMessage(stored),
      type: 'flush' as const,
    }));

    if (drainMode === 'bulk') {
      this.selfInvoke(msgs);
    } else {
      for (const msg of msgs) {
        this.selfInvoke([msg]);
      }
    }
  }

  /**
   * Fire-and-forget self-invocation via the injected `MessageInvoker`.
   * On failure, immediately fires a new invoke attempt and returns — the
   * current instance is never blocked waiting for retries.
   * Once `invokeRetries` attempts are exhausted the messages remain in their
   * current state so an external recovery job (e.g. cron) can pick them up.
   */
  private selfInvoke(messages: QueueMessage<T>[], invokeAttempt = 0): void {
    this.invoker.invoke(messages).catch(() => {
      const maxRetries = this.config.invokeRetries ?? 3;
      if (invokeAttempt < maxRetries) {
        this.selfInvoke(messages, invokeAttempt + 1);
      }
      // Retries exhausted — messages stay in current state for recovery.
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
