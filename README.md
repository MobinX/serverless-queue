# serverless-queue

[![npm version](https://img.shields.io/npm/v/serverless-queue.svg)](https://www.npmjs.com/package/serverless-queue)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> Ship durable background jobs on serverless without Redis, RabbitMQ, or a worker fleet.

`serverless-queue` is a TypeScript library that turns a Next.js route, Vercel Function, Cloudflare Worker, or Node.js endpoint into a durable background job system using only your existing database and HTTP self-invocation. Messages are persisted before execution, processed in order per `queueId`, retried in your own application code, and drained automatically as each invocation completes.

It is built for teams that want real queue behavior for emails, webhooks, sync jobs, image processing, and rate-limited API work without provisioning extra infrastructure.

**Start here:** [Quickstart](#quickstart-in-3-files) · [Next.js guide](docs/platforms/nextjs.mdx) · [Cloudflare Workers guide](docs/platforms/cloudflare-workers.mdx)

## Why it stands out

| | | |
|---|---|---|
| **No broker to manage** | **Ordered per tenant** | **Serverless-safe retries** |
| Use your existing Postgres or SQLite database instead of Redis or RabbitMQ | `queueId` gives FIFO execution per user, tenant, or resource | Fire-and-forget self-invocation keeps each run short and timeout-friendly |
| **Durable by default** | **Drizzle-ready** | **Works where you deploy** |
| Messages are stored before processing starts | Built-in storage for Postgres and SQLite via Drizzle ORM | First-class fit for Next.js, Vercel, Cloudflare Workers, Lambda, and Node.js |

## Built for serverless platforms

| Platform | How it fits |
|---|---|
| **Next.js App Router** | Use `app/api/queue/route.ts` as the queue endpoint |
| **Vercel Functions** | Works with Route Handlers and your existing Postgres setup |
| **Vercel Edge** | Pair with `waitUntil()` and a serverless-friendly DB like Neon |
| **Cloudflare Workers** | Use `env.SELF.fetch()` for self-invocation and D1/Turso for storage |
| **Node.js / Express** | Same API, same queue model, full control over transport |
| **AWS Lambda** | Works as long as your handler can accept HTTP-triggered queue requests |

## Why not Redis or RabbitMQ?

For many web apps, the hardest part of background jobs is not job execution. It is operating the infrastructure around them.

| | Redis/BullMQ | RabbitMQ | `serverless-queue` |
|---|---|---|---|
| Extra service to provision | Yes | Yes | No |
| Persistent worker process | Usually | Yes | No |
| Fits short-lived serverless runtimes | With workarounds | With workarounds | Yes |
| Retry logic lives in app code | Partly | Partly | Yes |
| Ordering per tenant/user | Manual | Manual | Built in via `queueId` |
| Reuses your existing database | No | No | Yes |

If your team already runs a broker at large scale, keep using it. But if your application is already built around HTTP + database + serverless functions, `serverless-queue` is often the simpler and cheaper fit.

## Install

```bash
npm install serverless-queue drizzle-orm
# or
bun add serverless-queue drizzle-orm
# or
pnpm add serverless-queue drizzle-orm
```

`drizzle-orm` is only required if you use the built-in `DrizzlePgStorage` or `DrizzleSqliteStorage`. The core queue abstractions do not require it.

## Quickstart in 3 files

### 1) Create the queue table

Run this once in your database:

```sql
CREATE TABLE IF NOT EXISTS queue_messages (
  id        TEXT   NOT NULL PRIMARY KEY,
  queue_id  TEXT   NOT NULL,
  message   TEXT   NOT NULL,
  timestamp BIGINT NOT NULL,
  state     TEXT   NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_queue_messages_queue_id_timestamp
  ON queue_messages (queue_id, timestamp);
```

You can also import `MIGRATION_SQL` from `serverless-queue` and execute it programmatically.

### 2) `lib/queue/action.ts` - your business logic

```ts
import { MessageAction } from 'serverless-queue'
import type { QueueMessage } from 'serverless-queue'
import { Resend } from 'resend'

interface EmailPayload {
  to: string
  subject: string
  html: string
}

const resend = new Resend(process.env.RESEND_API_KEY!)

export class EmailAction extends MessageAction<EmailPayload> {
  async execute(messages: QueueMessage<EmailPayload>[]) {
    for (const message of messages) {
      await resend.emails.send({
        from: 'noreply@yourapp.com',
        ...message.payload,
      })
    }
  }
}
```

### 3) `lib/queue/index.ts` - wire the queue

```ts
import {
  DrizzlePgStorage,
  MessageInvoker,
  MessageQueue,
  SimpleRetryStrategy,
  pgQueueMessages,
} from 'serverless-queue'
import type { QueueMessage } from 'serverless-queue'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { EmailAction } from './action'

const db = drizzle(neon(process.env.DATABASE_URL!))

class FetchInvoker extends MessageInvoker {
  async invoke(messages: QueueMessage[]) {
    const response = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/queue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-queue-secret': process.env.QUEUE_SECRET!,
      },
      body: JSON.stringify(messages),
    })

    if (!response.ok) {
      throw new Error(`Invoke failed: ${response.status}`)
    }
  }
}

export const queue = new MessageQueue(
  new DrizzlePgStorage(db, pgQueueMessages),
  new EmailAction(),
  new SimpleRetryStrategy({
    shouldRetry: (_message, error) => {
      return !(error instanceof Error && error.message.includes('validation'))
    },
    onExhausted: async (message) => {
      console.error('[queue] exhausted', message.id)
    },
  }),
  new FetchInvoker(),
  {
    batchSize: 10,
    maxAttempts: 3,
    drainMode: 'individual',
  },
)

export async function enqueueEmail(payload: EmailPayload) {
  await queue.handle([
    {
      id: crypto.randomUUID(),
      queueId: 'email',
      payload,
      attempt: 0,
      createdAt: Date.now(),
      type: 'new',
    },
  ])
}
```

### 4) `app/api/queue/route.ts` - the queue endpoint

```ts
import { queue } from '@/lib/queue'
import type { QueueMessage } from 'serverless-queue'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  if (req.headers.get('x-queue-secret') !== process.env.QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const messages = (await req.json()) as QueueMessage[]

  await queue.handle(messages)

  return NextResponse.json({ ok: true })
}
```

That is the full loop:

1. Your app enqueues a message
2. The queue writes it to the database
3. The queue endpoint processes it
4. On success, pending messages are drained automatically
5. On failure, retries are scheduled without blocking the current invocation

## How it works

```text
new message -> write to DB -> process -> done
                      |
                      +-> busy queue? keep as pending
                      |
                      +-> failure? retry or mark failed
                      |
                      +-> success? drain next pending messages
```

A few important behaviors make this work well on serverless platforms:

- `handle()` never throws, so your hosting platform does not start its own retry storm
- Self-invocation is fire-and-forget, so the current function can finish quickly
- The latest message state acts as the queue lock for a given `queueId`
- `drainMode` lets you process follow-up work one message at a time or in batches

## Core building blocks

| API | Purpose |
|---|---|
| `MessageQueue<T>` | The orchestrator that receives and processes messages |
| `MessageAction<T>` | Your business logic for executing queued work |
| `MessageInvoker<T>` | The transport that re-invokes your endpoint |
| `RetryStrategy<T>` | The policy that decides what to retry |
| `SimpleRetryStrategy<T>` | A ready-made retry strategy with `shouldRetry` and `onExhausted` hooks |
| `DrizzlePgStorage` | Prebuilt storage for Postgres Drizzle adapters |
| `DrizzleSqliteStorage` | Prebuilt storage for SQLite Drizzle adapters |
| `MIGRATION_SQL` | SQL for creating the default queue table |

## Best fit

Choose `serverless-queue` if:

- Your app already has Postgres or SQLite
- You want background jobs without running extra infrastructure
- You need per-tenant or per-resource ordering
- You want queueing, retry, and failure behavior to live in your application code
- You deploy on Next.js, Vercel, Cloudflare Workers, or similar serverless platforms

A traditional broker may be a better fit if you need fan-out to many consumer services, extremely high throughput across multiple languages, or advanced broker-native routing patterns.

## Documentation

Start here:

- [Getting Started](docs/getting-started.mdx)
- [Concepts](docs/concepts.mdx)
- [Configuration](docs/configuration.mdx)
- [Drizzle Storage](docs/drizzle-storage.mdx)

More guides:

- [Storage](docs/storage.mdx)
- [Action](docs/action.mdx)
- [Retry Strategy](docs/retry-strategy.mdx)
- [Invoker](docs/invoker.mdx)
- [LLM Context](docs/llm-context.mdx)

Platforms:

- [Next.js App Router](docs/platforms/nextjs.mdx)
- [Cloudflare Workers](docs/platforms/cloudflare-workers.mdx)
- [Node.js / Express](docs/platforms/nodejs.mdx)

Recipes:

- [Drain Modes](docs/recipes/drain-modes.mdx)
- [Dead-Letter Queue](docs/recipes/dead-letter-queue.mdx)
- [Recovery Cron](docs/recipes/recovery-cron.mdx)

## License

MIT

If this project saves you from provisioning a broker for simple background jobs, consider starring the repo.
