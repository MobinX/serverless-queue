# serverless-queue

[![npm version](https://img.shields.io/npm/v/serverless-queue.svg)](https://www.npmjs.com/package/serverless-queue)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> **Your serverless function already has a database. Stop paying for a message broker.**

---

## The problem every serverless developer hits

You build a feature — send a welcome email, process a webhook, resize an image, sync to a third-party API. It works in development. Then in production:

- The function **times out** at 30 seconds on heavy load
- The platform **retries the request** and the job runs twice
- A downstream API **rate-limits you** and you have no retry logic
- You need jobs to run **in order per user** — but functions are stateless

The standard answer is *"add a message broker"* — Redis, RabbitMQ, SQS. But that means:

| What you need | What you end up with |
|---|---|
| Background job processing | A Redis/RabbitMQ server running 24/7 |
| Retry on failure | Broker-level config in YAML or admin UI |
| Per-user job ordering | Manual queue namespacing |
| Zero extra infra | $20–50/month for an always-on broker |
| Works within 30s time limit | A separate long-running worker process |

There's a simpler way.

---

## The insight

You already have a database. A database can store job state. A serverless function can call itself over HTTP. That's all you need.

```
message arrives → write to DB → function invokes itself → processes → done
                                         ↑
                               fire-and-forget HTTP POST
                               exits immediately (no timeout)
```

No broker. No worker. No new infrastructure. **Your existing database is the queue.**

---

## By the numbers

| | Redis + BullMQ | RabbitMQ | **serverless-queue** |
|---|---|---|---|
| Extra services to deploy | 1 (Redis) | 1 (AMQP broker) | **0** |
| Monthly cost at low traffic | ~$25/mo | ~$25/mo | **$0** |
| Time to production-ready | ~2 days | ~2 days | **~30 min** |
| Works within 30s time limit | ❌ needs workers | ❌ needs workers | ✅ |
| Retry logic location | Broker YAML/config | Broker exchange config | **Your TypeScript** |
| Per-tenant job ordering | Manual namespacing | Manual routing | **Built-in** |
| Cold-start safe | ⚠️ connection overhead | ⚠️ connection overhead | ✅ stateless HTTP |
| Cost at zero traffic | Paying | Paying | **$0** |

---

## What it does

`serverless-queue` turns any serverless function into a durable, self-orchestrating queue:

- **Persists every message** to your DB before touching it — zero message loss
- **Serialises per `queueId`** — user-123's jobs run in order; user-456 runs in parallel
- **Invokes itself** over HTTP, fire-and-forget — never blocks, never times out
- **Retries failures** with your logic — inspect the error, the payload, the attempt count
- **Drains pending** jobs automatically after each success — backpressure built-in
- **`handle()` never throws** — your platform never sees a 500, never triggers its own retry loop

---

## How it works

```
POST /api/queue  ← new message arrives
        │
        ▼
  isBusy(queueId)?
      │         │
     YES        NO
      │          │
  write as   write as 'pending'
  'pending'  → 'processing'
  return 200  execute action()
                    │
               ┌────┴────┐
             done       error
               │          │
           mark 'done'  shouldRetry()?──YES──► selfInvoke (fire-and-forget)
               │          │
          drainPending    NO
               │          │
          selfInvoke   onExhausted()
          (fire-and-   mark 'failed'
           forget)     drainPending
```

`handle()` **always returns 200** — the platform never retries on its own.

---

## Install

```bash
npm install serverless-queue drizzle-orm
# or
bun add serverless-queue drizzle-orm
# or
pnpm add serverless-queue drizzle-orm
```

> `drizzle-orm` is only needed for the built-in `DrizzlePgStorage` / `DrizzleSqliteStorage`. The core library has zero required dependencies.

---

## Quickstart — 3 files

### `lib/queue/action.ts` — your business logic

```ts
import { MessageAction } from 'serverless-queue'
import type { QueueMessage } from 'serverless-queue'
import { Resend } from 'resend'

interface EmailPayload { to: string; subject: string; html: string }

const resend = new Resend(process.env.RESEND_API_KEY!)

export class EmailAction extends MessageAction<EmailPayload> {
  async execute(messages: QueueMessage<EmailPayload>[]) {
    for (const msg of messages) {
      await resend.emails.send({ from: 'noreply@yourapp.com', ...msg.payload })
    }
  }
}
```

### `lib/queue/index.ts` — wire everything together

```ts
import {
  MessageQueue, MessageInvoker, SimpleRetryStrategy, DrizzlePgStorage, pgQueueMessages,
} from 'serverless-queue'
import type { QueueMessage } from 'serverless-queue'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { EmailAction } from './action'

const db = drizzle(neon(process.env.DATABASE_URL!))

class FetchInvoker extends MessageInvoker {
  async invoke(messages: QueueMessage[]) {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-queue-secret': process.env.QUEUE_SECRET! },
      body: JSON.stringify(messages),
    })
    if (!res.ok) throw new Error(`Invoke failed: ${res.status}`)
  }
}

export const queue = new MessageQueue(
  new DrizzlePgStorage(db, pgQueueMessages),
  new EmailAction(),
  new SimpleRetryStrategy({
    shouldRetry: (_msg, err) => !(err instanceof Error && err.message.includes('validation')),
    onExhausted: async (msg) => console.error('[queue] exhausted', msg.id),
  }),
  new FetchInvoker(),
  { batchSize: 10, maxAttempts: 3, drainMode: 'individual' },
)

export async function enqueue(payload: { to: string; subject: string; html: string }) {
  await queue.handle([{
    id: crypto.randomUUID(),
    queueId: 'email',
    payload,
    attempt: 0,
    createdAt: Date.now(),
    type: 'new',
  }])
}
```

### `app/api/queue/route.ts` — the HTTP handler

```ts
import { queue } from '@/lib/queue'
import type { QueueMessage } from 'serverless-queue'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  if (req.headers.get('x-queue-secret') !== process.env.QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const messages = await req.json() as QueueMessage[]
  await queue.handle(messages)
  return NextResponse.json({ ok: true })
}
```

---

## Migration

Run once against your database:

```sql
CREATE TABLE IF NOT EXISTS queue_messages (
  id          TEXT    NOT NULL PRIMARY KEY,
  queue_id    TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  timestamp   BIGINT  NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_queue_messages_queue_id_timestamp
  ON queue_messages (queue_id, timestamp);
```

Or import `MIGRATION_SQL` and run it programmatically:

```ts
import { MIGRATION_SQL } from 'serverless-queue'
await db.execute(MIGRATION_SQL)
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Zero infrastructure** | No message broker — uses your existing database |
| **DrizzleStorage built-in** | `DrizzlePgStorage` and `DrizzleSqliteStorage` ready to use |
| **SimpleRetryStrategy built-in** | Configure retry predicate and `onExhausted` in one line |
| **Durable** | Messages persisted before any processing begins — no loss on crash |
| **Per-queue serialisation** | Partition by `queueId`; queues run independently in parallel |
| **Never times out** | Fire-and-forget self-invoke — each invocation finishes fast |
| **handle() never throws** | Platform never sees a 500; no runaway platform retries |
| **Drain modes** | `individual` (parallel per-message) or `bulk` (single batch call) |
| **Dead-letter support** | `onExhausted` hook for DLQ, Slack alerts, logging |
| **Platform-agnostic** | Vercel, Cloudflare Workers, AWS Lambda, Node.js |
| **Fully typed** | Generic over payload `T`; end-to-end TypeScript inference |
| **No required deps** | `drizzle-orm` only needed for built-in storage |

---

## API

| Class | Purpose |
|-------|---------|
| `MessageQueue<T>` | Core orchestrator — call `queue.handle(messages)` from your route handler |
| `DrizzlePgStorage` | Ready-made Postgres storage (Neon, Vercel, Supabase, Railway, pg) |
| `DrizzleSqliteStorage` | Ready-made SQLite storage (Cloudflare D1, Turso, Bun, better-sqlite3) |
| `SimpleRetryStrategy<T>` | Ready-made retry strategy with configurable predicate and `onExhausted` hook |
| `MessageStorage` | Abstract persistence layer — implement for any database |
| `MessageAction<T>` | Abstract business logic — implement the work to be done |
| `RetryStrategy<T>` | Abstract retry policy — decide when to retry and what to do on exhaustion |
| `MessageInvoker<T>` | Abstract transport — implement HTTP self-invocation |

| Export | Description |
|--------|-------------|
| `pgQueueMessages` | Drizzle Postgres table definition |
| `sqliteQueueMessages` | Drizzle SQLite table definition |
| `MIGRATION_SQL` | Raw SQL to create the `queue_messages` table and index |
| `QueueMessage<T>` | The message envelope that travels between invocations |
| `StoredMessage` | The database row format |
| `QueueConfig` | Configuration (`batchSize`, `maxAttempts`, `invokeRetries`, `drainMode`) |
| `MessageState` | `'pending' \| 'processing' \| 'done' \| 'failed'` |
| `MessageType` | `'new' \| 'retry' \| 'flush'` |

---

## Documentation

- **[Getting Started](docs/getting-started.mdx)** — 3-file quickstart using DrizzlePgStorage + SimpleRetryStrategy
- **[Concepts](docs/concepts.mdx)** — message lifecycle, busy-lock, fire-and-forget, drain cycles
- **[Drizzle Storage](docs/drizzle-storage.mdx)** — all supported Drizzle adapters, migration, Drizzle Kit
- **[Configuration](docs/configuration.mdx)** — `batchSize`, `maxAttempts`, `invokeRetries`, `drainMode`
- **[Storage](docs/storage.mdx)** — custom implementations: Postgres, Redis, Cloudflare D1, DynamoDB
- **[Action](docs/action.mdx)** — implement business logic; batch semantics; idempotency
- **[Retry Strategy](docs/retry-strategy.mdx)** — error filtering, `onExhausted`, DLQ push
- **[Invoker](docs/invoker.mdx)** — self-invocation patterns; `fetch`, `env.SELF.fetch`, stubs

**Platforms:**
- [Next.js App Router](docs/platforms/nextjs.mdx)
- [Cloudflare Workers](docs/platforms/cloudflare-workers.mdx)
- [Node.js / Express](docs/platforms/nodejs.mdx)

**Recipes:**
- [Drain Modes](docs/recipes/drain-modes.mdx) — `individual` vs `bulk` with trade-offs
- [Dead-Letter Queue](docs/recipes/dead-letter-queue.mdx) — DLQ table, Slack alerts, replay script
- [Recovery Cron](docs/recipes/recovery-cron.mdx) — detect and re-queue stuck messages

---

## License

MIT


`serverless-queue` solves the classic serverless dilemma: you need background job processing, but you can't run a long-lived worker and you don't want to provision a message broker. The solution: write jobs to your existing database, then have the function invoke *itself* over HTTP. The database row is the lock. The function is the worker. No SQS, no RabbitMQ, no Redis streams required.

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
npm install serverless-queue drizzle-orm
# or
bun add serverless-queue drizzle-orm
# or
pnpm add serverless-queue drizzle-orm
```

`drizzle-orm` is only needed if you use the built-in `DrizzlePgStorage` or `DrizzleSqliteStorage`. The core library has zero required dependencies.

---

## Quickstart — 3 files

### `lib/queue/action.ts` — your business logic

```ts
import { MessageAction } from 'serverless-queue'
import type { QueueMessage } from 'serverless-queue'
import { Resend } from 'resend'

interface EmailPayload { to: string; subject: string; html: string }

const resend = new Resend(process.env.RESEND_API_KEY!)

export class EmailAction extends MessageAction<EmailPayload> {
  async execute(messages: QueueMessage<EmailPayload>[]) {
    for (const msg of messages) {
      await resend.emails.send({ from: 'noreply@yourapp.com', ...msg.payload })
    }
  }
}
```

### `lib/queue/index.ts` — wire everything together

```ts
import {
  MessageQueue, MessageInvoker, SimpleRetryStrategy, DrizzlePgStorage, pgQueueMessages,
} from 'serverless-queue'
import type { QueueMessage } from 'serverless-queue'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { EmailAction } from './action'

const db = drizzle(neon(process.env.DATABASE_URL!))

class FetchInvoker extends MessageInvoker {
  async invoke(messages: QueueMessage[]) {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-queue-secret': process.env.QUEUE_SECRET! },
      body: JSON.stringify(messages),
    })
    if (!res.ok) throw new Error(`Invoke failed: ${res.status}`)
  }
}

export const queue = new MessageQueue(
  new DrizzlePgStorage(db, pgQueueMessages),
  new EmailAction(),
  new SimpleRetryStrategy({
    shouldRetry: (_msg, err) => !(err instanceof Error && err.message.includes('validation')),
    onExhausted: async (msg) => console.error('[queue] exhausted', msg.id),
  }),
  new FetchInvoker(),
  { batchSize: 10, maxAttempts: 3, drainMode: 'individual' },
)

export async function enqueue(payload: { to: string; subject: string; html: string }) {
  await queue.handle([{
    id: crypto.randomUUID(),
    queueId: 'email',
    payload,
    attempt: 0,
    createdAt: Date.now(),
    type: 'new',
  }])
}
```

### `app/api/queue/route.ts` — the HTTP handler

```ts
import { queue } from '@/lib/queue'
import type { QueueMessage } from 'serverless-queue'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  if (req.headers.get('x-queue-secret') !== process.env.QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const messages = await req.json() as QueueMessage[]
  await queue.handle(messages)
  return NextResponse.json({ ok: true })
}
```

---

## Migration

Run once against your Postgres database:

```sql
CREATE TABLE IF NOT EXISTS queue_messages (
  id          TEXT    NOT NULL PRIMARY KEY,
  queue_id    TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  timestamp   BIGINT  NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_queue_messages_queue_id_timestamp
  ON queue_messages (queue_id, timestamp);
```

Or import `MIGRATION_SQL` from `serverless-queue` and run it programmatically.

---

## Features

| Feature | Description |
|---------|-------------|
| **DrizzleStorage built-in** | `DrizzlePgStorage` and `DrizzleSqliteStorage` — no storage code needed |
| **SimpleRetryStrategy built-in** | Configure retry predicate and `onExhausted` callback in one line |
| **Zero infrastructure** | No message broker required — uses your existing database |
| **Durable** | Messages are persisted before any processing begins |
| **Per-queue serialisation** | Partition by `queueId`; queues are independent |
| **Configurable retries** | Plug in any retry policy — error filtering, back-off hints |
| **Dead-letter support** | `onExhausted` hook when retries run out |
| **Drain modes** | `individual` (parallel per-message) or `bulk` (single batch call) |
| **Platform-agnostic** | Vercel, Cloudflare Workers, AWS Lambda, Node.js, any serverless |
| **Fully typed** | Generic over payload type; end-to-end TypeScript inference |
| **No required deps** | Bring your own DB client; `drizzle-orm` only needed for built-in storage |

---

## API

| Class | Purpose |
|-------|---------|
| `MessageQueue<T>` | Core orchestrator — call `queue.handle(messages)` from your route handler |
| `DrizzlePgStorage` | Ready-made storage for Drizzle Postgres (Neon, Vercel, Supabase, Railway, pg) |
| `DrizzleSqliteStorage` | Ready-made storage for Drizzle SQLite (Cloudflare D1, Turso, Bun, better-sqlite3) |
| `SimpleRetryStrategy<T>` | Ready-made retry strategy with configurable predicate and `onExhausted` hook |
| `MessageStorage` | Abstract persistence layer — implement for any database |
| `MessageAction<T>` | Abstract business logic — implement the work to be done |
| `RetryStrategy<T>` | Abstract retry policy — decide when to retry and what to do on exhaustion |
| `MessageInvoker<T>` | Abstract transport — implement HTTP self-invocation |

| Export | Description |
|--------|-------------|
| `pgQueueMessages` | Drizzle Postgres table definition |
| `sqliteQueueMessages` | Drizzle SQLite table definition |
| `MIGRATION_SQL` | Raw SQL string to create the `queue_messages` table and index |
| `QueueMessage<T>` | The message envelope that travels between invocations |
| `StoredMessage` | The database row format |
| `QueueConfig` | Static configuration (`batchSize`, `maxAttempts`, `invokeRetries`, `drainMode`) |
| `MessageState` | `'pending' \| 'processing' \| 'done' \| 'failed'` |
| `MessageType` | `'new' \| 'retry' \| 'flush'` |

---

## Documentation

- **[Getting Started](docs/getting-started.mdx)** — 3-file quickstart using DrizzlePgStorage + SimpleRetryStrategy
- **[Drizzle Storage](docs/drizzle-storage.mdx)** — all supported Drizzle adapters, migration options, Drizzle Kit
- **[Concepts](docs/concepts.mdx)** — message lifecycle, busy-lock, fire-and-forget, drain cycles
- **[Configuration](docs/configuration.mdx)** — `batchSize`, `maxAttempts`, `invokeRetries`, `drainMode`
- **[Storage](docs/storage.mdx)** — custom implementations: Postgres, Redis, Cloudflare D1, SQLite, DynamoDB
- **[Action](docs/action.mdx)** — implement business logic; batch semantics; idempotency
- **[Retry Strategy](docs/retry-strategy.mdx)** — error filtering, `onExhausted`, DLQ push
- **[Invoker](docs/invoker.mdx)** — self-invocation patterns; `fetch`, `env.SELF.fetch`, stubs

**Platforms:**
- [Next.js App Router](docs/platforms/nextjs.mdx)
- [Cloudflare Workers](docs/platforms/cloudflare-workers.mdx)
- [Node.js / Express](docs/platforms/nodejs.mdx)

**Recipes:**
- [Drain Modes](docs/recipes/drain-modes.mdx) — `individual` vs `bulk` with trade-offs table
- [Dead-Letter Queue](docs/recipes/dead-letter-queue.mdx) — DLQ table, Slack alerts, replay script
- [Recovery Cron](docs/recipes/recovery-cron.mdx) — detect and re-queue stuck messages

---

## License

MIT
