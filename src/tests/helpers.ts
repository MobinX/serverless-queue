import { MessageStorage } from "../abstracts/MessageStorage.ts";
import { MessageAction } from "../abstracts/MessageAction.ts";
import { RetryStrategy } from "../abstracts/RetryStrategy.ts";
import { MessageInvoker } from "../abstracts/MessageInvoker.ts";
import type { MessageState, QueueMessage, StoredMessage } from "../types.ts";

// ── InMemoryStorage ───────────────────────────────────────────────────────────

export class InMemoryStorage extends MessageStorage {
  readonly store = new Map<string, StoredMessage>();

  async readMessage(id: string): Promise<StoredMessage | null> {
    return this.store.get(id) ?? null;
  }

  async writeMessage(message: StoredMessage): Promise<void> {
    if (this.store.has(message.id)) {
      throw new Error(`Duplicate message id: ${message.id}`);
    }
    this.store.set(message.id, { ...message });
  }

  async updateMessage(message: StoredMessage): Promise<void> {
    this.store.set(message.id, { ...message });
  }

  async deleteMessage(id: string): Promise<void> {
    this.store.delete(id);
  }

  async readLastMessageByQueue(queueId: string): Promise<StoredMessage | null> {
    const msgs = [...this.store.values()]
      .filter((m) => m.queueId === queueId)
      .sort((a, b) => b.timestamp - a.timestamp);
    return msgs[0] ?? null;
  }

  async readMessagesByQueue(
    queueId: string,
    state?: MessageState,
    limit?: number,
  ): Promise<StoredMessage[]> {
    let msgs = [...this.store.values()]
      .filter((m) => m.queueId === queueId && (!state || m.state === state))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (limit !== undefined) msgs = msgs.slice(0, limit);
    return msgs;
  }

  async readPendingMessages(
    queueId: string,
    limit: number,
  ): Promise<StoredMessage[]> {
    return this.readMessagesByQueue(queueId, "pending", limit);
  }

  countByState(state: MessageState): number {
    return [...this.store.values()].filter((m) => m.state === state).length;
  }

  allMessages(): StoredMessage[] {
    return [...this.store.values()];
  }
}

// ── SpyAction ─────────────────────────────────────────────────────────────────

export class SpyAction<T = unknown> extends MessageAction<T> {
  readonly executed: QueueMessage<T>[] = [];
  private readonly failAlwaysIds = new Set<string>();
  private readonly failOnceIds = new Set<string>();

  /** Make every execution of this message id throw. */
  failAlways(id: string): this {
    this.failAlwaysIds.add(id);
    return this;
  }

  /** Make only the first execution of this message id throw. */
  failFirst(id: string): this {
    this.failOnceIds.add(id);
    return this;
  }

  async execute(message: QueueMessage<T>): Promise<void> {
    this.executed.push(message);
    if (this.failAlwaysIds.has(message.id)) {
      throw new Error(`Action failed for ${message.id}`);
    }
    if (this.failOnceIds.has(message.id)) {
      this.failOnceIds.delete(message.id);
      throw new Error(`First-attempt failure for ${message.id}`);
    }
  }
}

// ── SpyRetryStrategy ──────────────────────────────────────────────────────────

export class SpyRetryStrategy<T = unknown> extends RetryStrategy<T> {
  readonly exhausted: QueueMessage<T>[] = [];
  private _shouldRetry = true;
  private _exhaustThrows = false;

  alwaysRetry(): this {
    this._shouldRetry = true;
    return this;
  }

  neverRetry(): this {
    this._shouldRetry = false;
    return this;
  }

  /** Make onExhausted throw to test isolation. */
  exhaustThrows(): this {
    this._exhaustThrows = true;
    return this;
  }

  shouldRetry(_message: QueueMessage<T>, _error: unknown): boolean {
    return this._shouldRetry;
  }

  async onExhausted(message: QueueMessage<T>): Promise<void> {
    this.exhausted.push(message);
    if (this._exhaustThrows) throw new Error("onExhausted failed");
  }
}

// ── SpyInvoker ────────────────────────────────────────────────────────────────

export class SpyInvoker<T = unknown> extends MessageInvoker<T> {
  readonly invoked: QueueMessage<T>[] = [];
  private remainingFailures = 0;
  private callThrough: ((msg: QueueMessage<T>) => Promise<void>) | null = null;

  /** Fail the first `n` invoke calls, then succeed. */
  failTimes(n: number): this {
    this.remainingFailures = n;
    return this;
  }

  /** After any failures, delegate to `fn` (e.g. a self-invoking queue). */
  onSuccess(fn: (msg: QueueMessage<T>) => Promise<void>): this {
    this.callThrough = fn;
    return this;
  }

  async invoke(message: QueueMessage<T>): Promise<void> {
    this.invoked.push(message);
    if (this.remainingFailures > 0) {
      this.remainingFailures--;
      throw new Error("Invoke failed");
    }
    await this.callThrough?.(message);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _seq = 0;

/** Build a QueueMessage with sensible defaults. */
export function makeMessage<T>(
  overrides: Partial<QueueMessage<T>> & { payload: T },
): QueueMessage<T> {
  const n = ++_seq;
  return {
    id: `msg-${n}`,
    queueId: "q-default",
    attempt: 0,
    createdAt: 1_000_000 + n, // deterministic, monotonically increasing
    type: "new",
    ...overrides,
  };
}

/** Build N messages for the same queue with ordered timestamps. */
export function makeMessages<T>(
  count: number,
  payload: T,
  queueId = "q-shared",
): QueueMessage<T>[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage({ payload, queueId, createdAt: 1_000_000 + ++_seq + i }),
  );
}

// ── Async Utilities ───────────────────────────────────────────────────────────

/** Poll until `condition()` returns true or the timeout (ms) expires. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms — condition never became true`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Flush all pending microtasks (use after fire-and-forget operations). */
export async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}
