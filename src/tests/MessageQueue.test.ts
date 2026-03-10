import { describe, it, expect, beforeEach } from "bun:test";
import { MessageQueue } from "../MessageQueue.ts";
import { MessageInvoker } from "../abstracts/MessageInvoker.ts";
import type { QueueConfig, QueueMessage } from "../types.ts";
import {
  InMemoryStorage,
  SpyAction,
  SpyRetryStrategy,
  SpyInvoker,
  makeMessage,
  makeMessages,
  waitFor,
  flushMicrotasks,
} from "./helpers.ts";

// ── Shared defaults ───────────────────────────────────────────────────────────

const BASE_CONFIG: QueueConfig = {
  batchSize: 10,
  maxAttempts: 3,
  invokeRetries: 2,
};

type Payload = { value: number };

function setup(configOverrides: Partial<QueueConfig> = {}) {
  const storage = new InMemoryStorage();
  const action = new SpyAction<Payload>();
  const strategy = new SpyRetryStrategy<Payload>();
  const invoker = new SpyInvoker<Payload>();
  const config = { ...BASE_CONFIG, ...configOverrides };
  const queue = new MessageQueue<Payload>(
    storage,
    action,
    strategy,
    invoker,
    config,
  );
  return { queue, storage, action, strategy, invoker };
}

/** A self-invoking invoker that routes messages back through the queue — simulates
 *  the serverless platform re-invoking the same function. */
function makeSelfInvokingQueue(configOverrides: Partial<QueueConfig> = {}) {
  const storage = new InMemoryStorage();
  const action = new SpyAction<Payload>();
  const strategy = new SpyRetryStrategy<Payload>();
  const config = { ...BASE_CONFIG, invokeRetries: 0, ...configOverrides };

  // Forward declaration so the invoker can close over `queue`.
  let queue!: MessageQueue<Payload>;

  class LoopbackInvoker extends MessageInvoker<Payload> {
    async invoke(message: QueueMessage<Payload>): Promise<void> {
      await queue.handle(message);
    }
  }

  queue = new MessageQueue<Payload>(
    storage,
    action,
    strategy,
    new LoopbackInvoker(),
    config,
  );

  return { queue, storage, action, strategy };
}

// ═════════════════════════════════════════════════════════════════════════════
// handle — new message
// ═════════════════════════════════════════════════════════════════════════════

describe("handle — new message on idle queue", () => {
  it("executes the action immediately", async () => {
    const { queue, action } = setup();
    const msg = makeMessage<Payload>({ payload: { value: 1 } });

    await queue.handle(msg);

    expect(action.executed).toHaveLength(1);
    expect(action.executed[0]!.id).toBe(msg.id);
  });

  it("transitions state: pending → processing → done", async () => {
    const storage = new InMemoryStorage();
    const states: string[] = [];

    const origWrite = storage.writeMessage.bind(storage);
    const origUpdate = storage.updateMessage.bind(storage);
    storage.writeMessage = async (m) => {
      states.push(`write:${m.state}`);
      return origWrite(m);
    };
    storage.updateMessage = async (m) => {
      states.push(`update:${m.state}`);
      return origUpdate(m);
    };

    const { action, strategy, invoker } = setup();
    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      invoker,
      BASE_CONFIG,
    );

    await queue.handle(makeMessage<Payload>({ payload: { value: 1 } }));

    expect(states).toEqual([
      "write:pending",
      "update:processing",
      "update:done",
    ]);
  });

  it("stores the message as 'done' after success", async () => {
    const { queue, storage } = setup();
    const msg = makeMessage<Payload>({ payload: { value: 1 } });

    await queue.handle(msg);

    const stored = await storage.readMessage(msg.id);
    expect(stored?.state).toBe("done");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// handle — busy queue
// ═════════════════════════════════════════════════════════════════════════════

describe("handle — new message on busy queue", () => {
  it("defers the message as 'pending' without executing", async () => {
    const { queue, action, storage } = setup();
    const blocker = makeMessage<Payload>({ payload: { value: 0 } });
    const msg = makeMessage<Payload>({
      payload: { value: 1 },
      queueId: blocker.queueId,
    });

    // Seed a 'processing' row to simulate a busy queue.
    await storage.writeMessage({
      id: blocker.id,
      queueId: blocker.queueId,
      message: JSON.stringify(blocker),
      timestamp: blocker.createdAt,
      state: "processing",
    });

    await queue.handle(msg);

    expect(action.executed).toHaveLength(0);
    const stored = await storage.readMessage(msg.id);
    expect(stored?.state).toBe("pending");
  });

  it("executes when the last message is 'done'", async () => {
    const { queue, action, storage } = setup();
    const prev = makeMessage<Payload>({ payload: { value: 0 } });
    const msg = makeMessage<Payload>({
      payload: { value: 1 },
      queueId: prev.queueId,
    });

    // Seed a 'done' row — queue should be considered idle.
    await storage.writeMessage({
      id: prev.id,
      queueId: prev.queueId,
      message: JSON.stringify(prev),
      timestamp: prev.createdAt,
      state: "done",
    });

    await queue.handle(msg);

    expect(action.executed).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// handle — retry / flush
// ═════════════════════════════════════════════════════════════════════════════

describe("handle — retry / flush message", () => {
  it("processes a retry message even when the queue appears busy", async () => {
    const { queue, action, storage } = setup();
    const msg = makeMessage<Payload>({ payload: { value: 1 }, type: "retry" });

    // Seed a busy row — retry should ignore it.
    await storage.writeMessage({
      id: "blocker",
      queueId: msg.queueId,
      message: "{}",
      timestamp: 0,
      state: "processing",
    });

    await queue.handle(msg);

    expect(action.executed).toHaveLength(1);
  });

  it("processes a flush message and marks it done", async () => {
    const { queue, storage } = setup();
    const msg = makeMessage<Payload>({ payload: { value: 1 }, type: "flush" });

    await queue.handle(msg);

    const stored = await storage.readMessage(msg.id);
    expect(stored?.state).toBe("done");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Success path — drainPending
// ═════════════════════════════════════════════════════════════════════════════

describe("drainPending — after success", () => {
  it("fires selfInvoke for each pending message after success", async () => {
    const { queue, storage, invoker } = setup();
    // Use type:"flush" so the busy check is skipped — this mirrors the real
    // scenario where a previous invocation completed and a self-invocation
    // is now draining the pending backlog.
    const trigger = makeMessage<Payload>({
      payload: { value: 0 },
      queueId: "q-drain",
      createdAt: 100,
      type: "flush",
    });
    const pending = makeMessage<Payload>({
      payload: { value: 1 },
      queueId: "q-drain",
      createdAt: 200,
    });

    await storage.writeMessage({
      id: pending.id,
      queueId: pending.queueId,
      message: JSON.stringify(pending),
      timestamp: pending.createdAt,
      state: "pending",
    });

    await queue.handle(trigger);
    await flushMicrotasks();

    expect(invoker.invoked.some((m) => m.id === pending.id)).toBe(true);
    expect(invoker.invoked.find((m) => m.id === pending.id)?.type).toBe(
      "flush",
    );
  });

  it("respects batchSize — only dispatches batchSize messages per drain cycle", async () => {
    const batchSize = 3;
    const { queue, storage, invoker } = setup({ batchSize });

    // flush trigger — skips busy check so it processes and then drains.
    const trigger = makeMessage<Payload>({
      payload: { value: 0 },
      queueId: "q-batch",
      createdAt: 0,
      type: "flush",
    });

    // Insert 10 pending messages — only 3 should be drained.
    for (let i = 1; i <= 10; i++) {
      const m = makeMessage<Payload>({
        payload: { value: i },
        queueId: "q-batch",
        createdAt: i * 100,
      });
      await storage.writeMessage({
        id: m.id,
        queueId: m.queueId,
        message: JSON.stringify(m),
        timestamp: m.createdAt,
        state: "pending",
      });
    }

    await queue.handle(trigger);
    await flushMicrotasks();

    expect(invoker.invoked).toHaveLength(batchSize);
  });

  it("does not invoke when there are no pending messages", async () => {
    const { queue, invoker } = setup();

    await queue.handle(
      makeMessage<Payload>({ payload: { value: 1 }, queueId: "q-empty" }),
    );
    await flushMicrotasks();

    expect(invoker.invoked).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Failure path — retries
// ═════════════════════════════════════════════════════════════════════════════

describe("failure path — retry logic", () => {
  it("fires a retry self-invoke with incremented attempt on failure", async () => {
    const invoker = new SpyInvoker<Payload>();
    const action = new SpyAction<Payload>().failAlways("fail-msg");
    const strategy = new SpyRetryStrategy<Payload>().alwaysRetry();
    const queue = new MessageQueue<Payload>(
      new InMemoryStorage(),
      action,
      strategy,
      invoker,
      { ...BASE_CONFIG, maxAttempts: 3 },
    );

    const msg = makeMessage<Payload>({ id: "fail-msg", payload: { value: 1 } });
    await queue.handle(msg);
    await flushMicrotasks();

    expect(invoker.invoked).toHaveLength(1);
    expect(invoker.invoked[0]!.attempt).toBe(1);
    expect(invoker.invoked[0]!.type).toBe("retry");
  });

  it("does not retry when shouldRetry returns false", async () => {
    const invoker = new SpyInvoker<Payload>();
    const action = new SpyAction<Payload>().failAlways("no-retry");
    const strategy = new SpyRetryStrategy<Payload>().neverRetry();
    const queue = new MessageQueue<Payload>(
      new InMemoryStorage(),
      action,
      strategy,
      invoker,
      BASE_CONFIG,
    );

    await queue.handle(
      makeMessage<Payload>({ id: "no-retry", payload: { value: 1 } }),
    );

    expect(invoker.invoked).toHaveLength(0);
  });

  it("stops retrying after maxAttempts is reached", async () => {
    const invoker = new SpyInvoker<Payload>();
    const action = new SpyAction<Payload>().failAlways("exhaust");
    const strategy = new SpyRetryStrategy<Payload>().alwaysRetry();
    const queue = new MessageQueue<Payload>(
      new InMemoryStorage(),
      action,
      strategy,
      invoker,
      { ...BASE_CONFIG, maxAttempts: 1 },
    );

    await queue.handle(
      makeMessage<Payload>({ id: "exhaust", payload: { value: 1 } }),
    );

    // maxAttempts=1 means attempt 0 is the only try — no retry invoke.
    expect(invoker.invoked).toHaveLength(0);
    expect(strategy.exhausted).toHaveLength(1);
  });

  it("marks message 'failed' after retries are exhausted", async () => {
    const storage = new InMemoryStorage();
    const action = new SpyAction<Payload>().failAlways("will-fail");
    const strategy = new SpyRetryStrategy<Payload>().neverRetry();
    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      new SpyInvoker<Payload>(),
      BASE_CONFIG,
    );

    const msg = makeMessage<Payload>({ id: "will-fail", payload: { value: 1 } });
    await queue.handle(msg);

    expect((await storage.readMessage(msg.id))?.state).toBe("failed");
    expect(strategy.exhausted).toHaveLength(1);
  });

  it("calls onExhausted with the original message", async () => {
    const action = new SpyAction<Payload>().failAlways("ex-msg");
    const strategy = new SpyRetryStrategy<Payload>().neverRetry();
    const queue = new MessageQueue<Payload>(
      new InMemoryStorage(),
      action,
      strategy,
      new SpyInvoker<Payload>(),
      BASE_CONFIG,
    );

    const msg = makeMessage<Payload>({ id: "ex-msg", payload: { value: 42 } });
    await queue.handle(msg);

    expect(strategy.exhausted[0]!.id).toBe("ex-msg");
    expect(strategy.exhausted[0]!.payload.value).toBe(42);
  });

  it("continues to mark 'failed' and drain even if onExhausted throws", async () => {
    const storage = new InMemoryStorage();
    const action = new SpyAction<Payload>().failAlways("ex-throws");
    const strategy = new SpyRetryStrategy<Payload>()
      .neverRetry()
      .exhaustThrows();
    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      new SpyInvoker<Payload>(),
      BASE_CONFIG,
    );

    const msg = makeMessage<Payload>({
      id: "ex-throws",
      payload: { value: 1 },
    });
    await queue.handle(msg);

    // Message must be 'failed' even though onExhausted threw.
    expect((await storage.readMessage(msg.id))?.state).toBe("failed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// invokeWithRetry
// ═════════════════════════════════════════════════════════════════════════════

describe("invokeWithRetry", () => {
  it("succeeds on the first attempt with no failures", async () => {
    const { queue, invoker } = setup({ maxAttempts: 3, invokeRetries: 3 });
    const action = new SpyAction<Payload>().failAlways("f");
    // Re-wire action — we need a fresh queue with this action.
    const storage = new InMemoryStorage();
    const strategy = new SpyRetryStrategy<Payload>().alwaysRetry();
    const q = new MessageQueue<Payload>(storage, action, strategy, invoker, {
      ...BASE_CONFIG,
      invokeRetries: 3,
    });

    await q.handle(makeMessage<Payload>({ id: "f", payload: { value: 1 } }));
    await flushMicrotasks();

    // 1 invoke (first attempt — no prior failures).
    expect(invoker.invoked).toHaveLength(1);
  });

  it("retries invoke failures up to invokeRetries, then succeeds", async () => {
    const invoker = new SpyInvoker<Payload>().failTimes(2);
    const action = new SpyAction<Payload>().failAlways("f");
    const strategy = new SpyRetryStrategy<Payload>().alwaysRetry();
    const queue = new MessageQueue<Payload>(
      new InMemoryStorage(),
      action,
      strategy,
      invoker,
      { ...BASE_CONFIG, maxAttempts: 3, invokeRetries: 3 },
    );

    await queue.handle(
      makeMessage<Payload>({ id: "f", payload: { value: 1 } }),
    );
    await new Promise((r) => setTimeout(r, 30));

    // 2 failures + 1 success = 3 total invoke calls.
    expect(invoker.invoked).toHaveLength(3);
  });

  it("gives up after all invokeRetries are exhausted", async () => {
    const invoker = new SpyInvoker<Payload>().failTimes(999);
    const action = new SpyAction<Payload>().failAlways("f");
    const strategy = new SpyRetryStrategy<Payload>().alwaysRetry();
    const queue = new MessageQueue<Payload>(
      new InMemoryStorage(),
      action,
      strategy,
      invoker,
      { ...BASE_CONFIG, maxAttempts: 3, invokeRetries: 2 },
    );

    await queue.handle(
      makeMessage<Payload>({ id: "f", payload: { value: 1 } }),
    );
    await new Promise((r) => setTimeout(r, 30));

    // invokeRetries=2 → 1 initial + 2 retries = 3 total attempts.
    expect(invoker.invoked).toHaveLength(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// handle never throws
// ═════════════════════════════════════════════════════════════════════════════

describe("handle — never throws", () => {
  it("resolves even if storage.writeMessage throws", async () => {
    const storage = new InMemoryStorage();
    storage.writeMessage = async () => {
      throw new Error("DB offline");
    };
    const { action, strategy, invoker } = setup();
    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      invoker,
      BASE_CONFIG,
    );

    await expect(
      queue.handle(makeMessage<Payload>({ payload: { value: 1 } })),
    ).resolves.toBeUndefined();
  });

  it("resolves even if storage.updateMessage throws", async () => {
    const storage = new InMemoryStorage();
    storage.updateMessage = async () => {
      throw new Error("DB offline");
    };
    const { action, strategy, invoker } = setup();
    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      invoker,
      BASE_CONFIG,
    );

    await expect(
      queue.handle(makeMessage<Payload>({ payload: { value: 1 } })),
    ).resolves.toBeUndefined();
  });

  it("resolves even if the action throws", async () => {
    const action = new SpyAction<Payload>().failAlways("boom");
    const strategy = new SpyRetryStrategy<Payload>().neverRetry();
    const { storage, invoker } = setup();
    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      invoker,
      BASE_CONFIG,
    );

    await expect(
      queue.handle(
        makeMessage<Payload>({ id: "boom", payload: { value: 1 } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves even if storage.readLastMessageByQueue throws", async () => {
    const storage = new InMemoryStorage();
    storage.readLastMessageByQueue = async () => {
      throw new Error("DB offline");
    };
    const { action, strategy, invoker } = setup();
    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      invoker,
      BASE_CONFIG,
    );

    await expect(
      queue.handle(makeMessage<Payload>({ payload: { value: 1 } })),
    ).resolves.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 100 simultaneous messages — in-memory self-invoking
// ═════════════════════════════════════════════════════════════════════════════

describe("100 simultaneous messages — different queues (in-memory loopback)", () => {
  it("processes all 100 messages to 'done'", async () => {
    const { queue, storage } = makeSelfInvokingQueue({ batchSize: 10 });

    const messages = makeMessages<Payload>(100, { value: 0 }).map((m, i) => ({
      ...m,
      queueId: `q-${i}`, // each message on its own isolated queue
    }));

    await Promise.all(messages.map((msg) => queue.handle(msg)));

    expect(storage.countByState("done")).toBe(100);
    expect(storage.countByState("pending")).toBe(0);
    expect(storage.countByState("processing")).toBe(0);
  });
});

describe("100 simultaneous messages — same queue with batch draining (in-memory loopback)", () => {
  it("eventually processes all 100 messages", async () => {
    // batchSize=5 so the drain cycles process messages 5 at a time.
    const { queue, storage } = makeSelfInvokingQueue({ batchSize: 5 });

    const messages = makeMessages<Payload>(100, { value: 0 }, "q-serial");

    await Promise.all(messages.map((msg) => queue.handle(msg)));

    // Self-invocations are fire-and-forget — wait until all settle.
    await waitFor(
      () =>
        storage.countByState("pending") === 0 &&
        storage.countByState("processing") === 0,
    );

    expect(storage.countByState("done")).toBe(100);
    expect(storage.countByState("failed")).toBe(0);
  });
});

describe("100 simultaneous messages — with failures and retries (in-memory loopback)", () => {
  it("retries failed messages and completes all 100", async () => {
    const storage = new InMemoryStorage();
    const action = new SpyAction<Payload>();
    const strategy = new SpyRetryStrategy<Payload>().alwaysRetry();

    let queue!: MessageQueue<Payload>;
    class LoopbackInvoker extends MessageInvoker<Payload> {
      async invoke(msg: QueueMessage<Payload>) {
        await queue.handle(msg);
      }
    }

    queue = new MessageQueue<Payload>(storage, action, strategy, new LoopbackInvoker(), {
      batchSize: 10,
      maxAttempts: 3,
      invokeRetries: 0,
    });

    const messages = makeMessages<Payload>(100, { value: 0 }, "q-retry");

    // Every 5th message fails on first attempt only — will be retried.
    messages
      .filter((_, i) => i % 5 === 0)
      .forEach((m) => action.failFirst(m.id));

    await Promise.all(messages.map((msg) => queue.handle(msg)));

    await waitFor(
      () =>
        storage.countByState("pending") === 0 &&
        storage.countByState("processing") === 0,
    );

    expect(storage.countByState("failed")).toBe(0);
    expect(storage.countByState("done")).toBe(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Bun HTTP server — 100 concurrent real HTTP requests
// ═════════════════════════════════════════════════════════════════════════════

describe("Bun HTTP server — 100 concurrent requests", () => {
  it("handles 100 concurrent HTTP self-invocations and processes all messages", async () => {
    const storage = new InMemoryStorage();
    const action = new SpyAction<Payload>();
    const strategy = new SpyRetryStrategy<Payload>();

    // Placeholder — URL assigned once the server is bound.
    let serverUrl = "";

    class HttpInvoker extends MessageInvoker<Payload> {
      async invoke(message: QueueMessage<Payload>): Promise<void> {
        const res = await fetch(serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
      }
    }

    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      new HttpInvoker(),
      { batchSize: 5, maxAttempts: 3, invokeRetries: 2 },
    );

    const server = Bun.serve({
      port: 0, // random available port
      async fetch(req) {
        const body = (await req.json()) as QueueMessage<Payload>;
        await queue.handle(body);
        return new Response("ok", { status: 200 });
      },
    });

    serverUrl = `http://localhost:${server.port}`;

    // Each message on its own queue — avoids storage race conditions while
    // still exercising the full HTTP → handle → selfInvoke → HTTP path.
    const messages = Array.from({ length: 100 }, (_, i) => {
      const base = makeMessage<Payload>({ payload: { value: i } });
      return { ...base, queueId: `q-http-${i}` };
    });

    // Fire 100 concurrent HTTP POST requests.
    const responses = await Promise.all(
      messages.map((msg) =>
        fetch(serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg),
        }),
      ),
    );

    // Every response must be 200 — handle never throws.
    expect(responses.every((r) => r.status === 200)).toBe(true);

    // Wait for any in-flight self-invocations to complete.
    await waitFor(
      () =>
        storage.countByState("pending") === 0 &&
        storage.countByState("processing") === 0,
      10_000,
    );

    server.stop(true);

    expect(storage.countByState("done")).toBe(100);
    expect(storage.countByState("failed")).toBe(0);
  });

  it("retries failed self-invocations and still returns 200 for each request", async () => {
    const storage = new InMemoryStorage();
    const action = new SpyAction<Payload>();
    const strategy = new SpyRetryStrategy<Payload>().neverRetry();

    let serverUrl = "";
    let failCount = 0;

    class FlakyHttpInvoker extends MessageInvoker<Payload> {
      async invoke(message: QueueMessage<Payload>): Promise<void> {
        // First 10 self-invocations fail to exercise invokeWithRetry.
        if (failCount < 10) {
          failCount++;
          throw new Error("Flaky network");
        }
        const res = await fetch(serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
      }
    }

    const queue = new MessageQueue<Payload>(
      storage,
      action,
      strategy,
      new FlakyHttpInvoker(),
      { batchSize: 5, maxAttempts: 1, invokeRetries: 3 },
    );

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as QueueMessage<Payload>;
        await queue.handle(body);
        return new Response("ok", { status: 200 });
      },
    });

    serverUrl = `http://localhost:${server.port}`;

    const messages = Array.from({ length: 20 }, (_, i) => {
      const base = makeMessage<Payload>({ payload: { value: i } });
      return { ...base, queueId: `q-flaky-${i}` };
    });

    const responses = await Promise.all(
      messages.map((msg) =>
        fetch(serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg),
        }),
      ),
    );

    // All requests must resolve 200 regardless of invoker flakiness.
    expect(responses.every((r) => r.status === 200)).toBe(true);

    server.stop(true);
  });
});
