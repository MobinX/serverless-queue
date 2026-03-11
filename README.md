# serverless-queue

[![npm version](https://img.shields.io/npm/v/serverless-queue.svg)](https://www.npmjs.com/package/serverless-queue)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**Turn any serverless function into a durable, self-orchestrating queue — no broker, no infrastructure.**

`serverless-queue` solves the classic serverless dilemma: you need background job processing, but you can't run a long-lived worker, and you don't want to provision a message broker. The solution: write jobs to your existing database, then have the function invoke *itself* over HTTP. The database row is the lock. The function is the worker. No SQS, no RabbitMQ, no Redis streams required.

---

## How it works

```
New message arrives at POST /api/queue
          │
          ▼
  isBusy(queueId)?
      │         │
     YES        NO
      │          │
  write as   write as 'pending'
  'pending'  promote to 'processing'
  return 200 execute action
                  │
             ┌────┴────┐
           done       error
             │          │
         mark 'done'  retry?──YES──► selfInvoke (retry, fire-and-forget)
             │          │
        drainPending   NO
             │          │
        selfInvoke   onExhausted()
        (flush,      mark 'failed'
        fire-and-    drainPending
        forget)
```

`handle()` **never throws** — always returns 200, so the platform never retries on its own.

---

## Install

```bash
npm install serverless-queue
# or
bun add serverless-queue
# or
pnpm add serverless-queue
```

Zero runtime dependencies. Bring your own database client and HTTP transport.

---

## Quickstart

```ts
// lib/queue.ts
import { MessageQueue, MessageStorage, MessageAction, RetryStrategy, MessageInvoker } from 'serverless-queue';
import type { QueueMessage, StoredMessage, MessageState, QueueConfig } from 'serverless-queue';

// 1. Define your payload
interface EmailPayload { to: string; subject: string; html: string }

// 2. Implement storage (map to your DB)
class MyStorage extends MessageStorage {
  async readMessage(id: string) { /* SELECT by id */ return null; }
  async writeMessage(msg: StoredMessage) { /* INSERT */ }
  async updateMessage(msg: StoredMessage) { /* UPDATE */ }
  async deleteMessage(id: string) { /* DELETE */ }
  async readLastMessageByQueue(queueId: string) { /* SELECT ORDER BY timestamp DESC LIMIT 1 */ return null; }
  async readMessagesByQueue(queueId: string, state?: MessageState, limit?: number) { /* SELECT */ return []; }
  async readPendingMessages(queueId: string, limit: number) { return this.readMessagesByQueue(queueId, 'pending', limit); }
}

// 3. Implement your business logic
class SendEmail extends MessageAction<EmailPayload> {
  async execute(messages: QueueMessage<EmailPayload>[]) {
    for (const msg of messages) {
      await emailClient.send(msg.payload); // throw to trigger retry
    }
  }
}

// 4. Define retry behaviour
class RetryAll extends RetryStrategy<EmailPayload> {
  shouldRetry() { return true; }
  async onExhausted(msg: QueueMessage<EmailPayload>) {
    console.error('Exhausted', msg.id);
  }
}

// 5. Implement self-invocation
class SelfInvoker extends MessageInvoker<EmailPayload> {
  async invoke(messages: QueueMessage<EmailPayload>[]) {
    const res = await fetch(`${process.env.QUEUE_BASE_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.QUEUE_SECRET}` },
      body: JSON.stringify(messages),
    });
    if (!res.ok) throw new Error(`Self-invoke failed: ${res.status}`);
  }
}

// 6. Wire it all together
const config: QueueConfig = { batchSize: 5, maxAttempts: 3 };
export const queue = new MessageQueue<EmailPayload>(
  new MyStorage(), new SendEmail(), new RetryAll(), new SelfInvoker(), config
);
```

```ts
// app/api/queue/route.ts (Next.js App Router)
import { queue } from '@/lib/queue';

export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.QUEUE_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  await queue.handle(await req.json()); // never throws
  return new Response('ok');
}
```

```ts
// Enqueue a message from anywhere
await fetch('/api/queue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.QUEUE_SECRET}` },
  body: JSON.stringify([{
    id: crypto.randomUUID(),
    queueId: userId,           // serial queue per user
    payload: { to: email, subject: 'Welcome!', html: '<h1>Hello</h1>' },
    attempt: 0,
    createdAt: Date.now(),
    type: 'new',
  }]),
});
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Zero infrastructure** | No message broker required — uses your existing database |
| **Durable** | Messages are persisted before any processing begins |
| **Per-queue serialisation** | Partition by `queueId`; queues are independent |
| **Configurable retries** | Plug in any retry policy — error filtering, back-off hints |
| **Dead-letter support** | `onExhausted` hook when retries run out |
| **Drain modes** | `individual` (parallel per-message) or `bulk` (single batch call) |
| **Platform-agnostic** | Vercel, Cloudflare Workers, AWS Lambda, Node.js, any serverless |
| **Fully typed** | Generic over payload type; end-to-end TypeScript inference |
| **No runtime deps** | Bring your own DB client and HTTP transport |

---

## API

| Class | Purpose |
|-------|---------|
| `MessageQueue<T>` | Core orchestrator — call `queue.handle(messages)` from your route handler |
| `MessageStorage` | Abstract persistence layer — implement for your database |
| `MessageAction<T>` | Abstract business logic — implement the work to be done |
| `RetryStrategy<T>` | Abstract retry policy — decide when to retry and what to do on exhaustion |
| `MessageInvoker<T>` | Abstract transport — implement HTTP self-invocation |

| Type | Description |
|------|-------------|
| `QueueMessage<T>` | The message envelope that travels between invocations |
| `StoredMessage` | The database row format |
| `QueueConfig` | Static configuration (`batchSize`, `maxAttempts`, `invokeRetries`, `drainMode`) |
| `MessageState` | `'pending' \| 'processing' \| 'done' \| 'failed'` |
| `MessageType` | `'new' \| 'retry' \| 'flush'` |

---

## Documentation

- **[Getting Started](docs/getting-started.mdx)** — Install and wire up a queue in 5 minutes
- **[Concepts](docs/concepts.mdx)** — Message lifecycle, busy-lock, fire-and-forget, drain cycles
- **[Configuration](docs/configuration.mdx)** — `batchSize`, `maxAttempts`, `invokeRetries`, `drainMode`
- **[Storage](docs/storage.mdx)** — Postgres, Redis, Cloudflare D1, SQLite, DynamoDB
- **[Action](docs/action.mdx)** — Implement business logic; batch semantics; idempotency
- **[Retry Strategy](docs/retry-strategy.mdx)** — Error filtering, `onExhausted`, DLQ push
- **[Invoker](docs/invoker.mdx)** — Self-invocation patterns; `fetch`, `env.SELF.fetch`, stubs

**Platforms:**
- [Next.js App Router](docs/platforms/nextjs.mdx)
- [Cloudflare Workers](docs/platforms/cloudflare-workers.mdx)
- [Node.js / Express](docs/platforms/nodejs.mdx)

**Recipes:**
- [Drain Modes](docs/recipes/drain-modes.mdx) — `individual` vs `bulk` with trade-offs table
- [Dead-Letter Queue](docs/recipes/dead-letter-queue.mdx) — DLQ table, Slack alerts, replay script
- [Recovery Cron](docs/recipes/recovery-cron.mdx) — Detect and re-queue stuck messages

---

## License

MIT
