import { describe, it, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as pgDrizzle } from 'drizzle-orm/pglite'
import { Database } from 'bun:sqlite'
import { drizzle as sqliteDrizzle } from 'drizzle-orm/bun-sqlite'
import { MessageInvoker } from '../abstracts/MessageInvoker.ts'
import { MessageQueue } from '../MessageQueue.ts'
import { DrizzlePgStorage } from '../drizzle/DrizzlePgStorage.ts'
import { DrizzleSqliteStorage } from '../drizzle/DrizzleSqliteStorage.ts'
import { MIGRATION_SQL, pgQueueMessages, sqliteQueueMessages } from '../drizzle/schema.ts'
import { SimpleRetryStrategy } from '../SimpleRetryStrategy.ts'
import type { MessageStorage } from '../abstracts/MessageStorage.ts'
import type { QueueMessage, StoredMessage } from '../types.ts'
import { SpyAction, flushMicrotasks } from './helpers.ts'

// ── Async poll helper (storage reads are async) ────────────────────────────

async function pollUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (await condition()) return
    if (Date.now() > deadline)
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 20))
  }
}

// ── Factory helpers ────────────────────────────────────────────────────────

async function makePgStorage(): Promise<DrizzlePgStorage> {
  const client = new PGlite()
  await client.exec(MIGRATION_SQL)
  return new DrizzlePgStorage(pgDrizzle(client), pgQueueMessages)
}

function makeSqliteStorage(): DrizzleSqliteStorage {
  const sqlite = new Database(':memory:')
  sqlite.exec(MIGRATION_SQL)
  return new DrizzleSqliteStorage(sqliteDrizzle(sqlite), sqliteQueueMessages)
}

// ── Seed helper ────────────────────────────────────────────────────────────

function makeStored(overrides: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    queueId: 'q-default',
    message: JSON.stringify({ id: overrides.id, payload: {}, attempt: 0 }),
    timestamp: 1_000_000,
    state: 'pending',
    ...overrides,
  }
}

// ── Shared storage contract suite ─────────────────────────────────────────

function storageContractTests(
  label: string,
  factory: () => Promise<MessageStorage> | MessageStorage,
) {
  describe(`${label} — storage contract`, () => {
    let storage: MessageStorage

    beforeEach(async () => {
      storage = await factory()
    })

    // ── readMessage ──────────────────────────────────────────────────────

    it('readMessage returns null for unknown id', async () => {
      expect(await storage.readMessage('nope')).toBeNull()
    })

    it('writeMessage + readMessage round-trips all fields', async () => {
      const msg = makeStored({ id: 'rt-1', queueId: 'q-rt', timestamp: 42_000, state: 'processing' })
      await storage.writeMessage(msg)
      expect(await storage.readMessage('rt-1')).toEqual(msg)
    })

    // ── writeMessage ─────────────────────────────────────────────────────

    it('writeMessage throws on duplicate id', async () => {
      const msg = makeStored({ id: 'dup-1' })
      await storage.writeMessage(msg)
      await expect(storage.writeMessage(msg)).rejects.toThrow()
    })

    // ── updateMessage ─────────────────────────────────────────────────────

    it('updateMessage changes state', async () => {
      await storage.writeMessage(makeStored({ id: 'upd-1', state: 'pending' }))
      await storage.updateMessage(makeStored({ id: 'upd-1', state: 'done' }))
      expect((await storage.readMessage('upd-1'))?.state).toBe('done')
    })

    it('updateMessage changes message payload', async () => {
      await storage.writeMessage(makeStored({ id: 'upd-2' }))
      await storage.updateMessage(makeStored({ id: 'upd-2', message: '{"updated":true}' }))
      expect((await storage.readMessage('upd-2'))?.message).toBe('{"updated":true}')
    })

    // ── deleteMessage ─────────────────────────────────────────────────────

    it('deleteMessage removes the row', async () => {
      await storage.writeMessage(makeStored({ id: 'del-1' }))
      await storage.deleteMessage('del-1')
      expect(await storage.readMessage('del-1')).toBeNull()
    })

    it('deleteMessage on non-existent id does not throw', async () => {
      await expect(storage.deleteMessage('ghost')).resolves.toBeUndefined()
    })

    // ── readLastMessageByQueue ────────────────────────────────────────────

    it('readLastMessageByQueue returns null for empty queue', async () => {
      expect(await storage.readLastMessageByQueue('empty-q')).toBeNull()
    })

    it('readLastMessageByQueue returns the row with the highest timestamp', async () => {
      await storage.writeMessage(makeStored({ id: 'old', queueId: 'q-last', timestamp: 100 }))
      await storage.writeMessage(makeStored({ id: 'mid', queueId: 'q-last', timestamp: 500 }))
      await storage.writeMessage(makeStored({ id: 'new', queueId: 'q-last', timestamp: 999 }))
      const result = await storage.readLastMessageByQueue('q-last')
      expect(result?.id).toBe('new')
    })

    it('readLastMessageByQueue is scoped to queueId', async () => {
      await storage.writeMessage(makeStored({ id: 'a1', queueId: 'qa', timestamp: 9999 }))
      await storage.writeMessage(makeStored({ id: 'b1', queueId: 'qb', timestamp: 1 }))
      expect((await storage.readLastMessageByQueue('qb'))?.id).toBe('b1')
    })

    // ── readMessagesByQueue ───────────────────────────────────────────────

    it('readMessagesByQueue returns all messages FIFO-ordered', async () => {
      await storage.writeMessage(makeStored({ id: 'm2', queueId: 'q-fifo', timestamp: 200 }))
      await storage.writeMessage(makeStored({ id: 'm1', queueId: 'q-fifo', timestamp: 100 }))
      await storage.writeMessage(makeStored({ id: 'm3', queueId: 'q-fifo', timestamp: 300 }))
      const rows = await storage.readMessagesByQueue('q-fifo')
      expect(rows.map(r => r.id)).toEqual(['m1', 'm2', 'm3'])
    })

    it('readMessagesByQueue filters by state', async () => {
      await storage.writeMessage(makeStored({ id: 'pend', queueId: 'q-state', state: 'pending', timestamp: 1 }))
      await storage.writeMessage(makeStored({ id: 'done', queueId: 'q-state', state: 'done', timestamp: 2 }))
      await storage.writeMessage(makeStored({ id: 'fail', queueId: 'q-state', state: 'failed', timestamp: 3 }))
      const pending = await storage.readMessagesByQueue('q-state', 'pending')
      expect(pending).toHaveLength(1)
      expect(pending[0]!.id).toBe('pend')
    })

    it('readMessagesByQueue respects limit', async () => {
      for (let i = 1; i <= 6; i++)
        await storage.writeMessage(makeStored({ id: `lim-${i}`, queueId: 'q-limit', timestamp: i * 100 }))
      const rows = await storage.readMessagesByQueue('q-limit', undefined, 4)
      expect(rows).toHaveLength(4)
      expect(rows.map(r => r.id)).toEqual(['lim-1', 'lim-2', 'lim-3', 'lim-4'])
    })

    it('readMessagesByQueue is scoped to queueId', async () => {
      await storage.writeMessage(makeStored({ id: 'x1', queueId: 'qx', timestamp: 1 }))
      await storage.writeMessage(makeStored({ id: 'y1', queueId: 'qy', timestamp: 2 }))
      expect(await storage.readMessagesByQueue('qx')).toHaveLength(1)
    })

    // ── readPendingMessages ───────────────────────────────────────────────

    it('readPendingMessages returns only pending rows', async () => {
      await storage.writeMessage(makeStored({ id: 'p1', queueId: 'q-pend', state: 'pending', timestamp: 1 }))
      await storage.writeMessage(makeStored({ id: 'p2', queueId: 'q-pend', state: 'pending', timestamp: 2 }))
      await storage.writeMessage(makeStored({ id: 'd1', queueId: 'q-pend', state: 'done', timestamp: 3 }))
      const rows = await storage.readPendingMessages('q-pend', 10)
      expect(rows).toHaveLength(2)
      expect(rows.every(r => r.state === 'pending')).toBe(true)
    })

    it('readPendingMessages respects limit', async () => {
      for (let i = 1; i <= 5; i++)
        await storage.writeMessage(makeStored({ id: `pp${i}`, queueId: 'q-plim', state: 'pending', timestamp: i }))
      expect(await storage.readPendingMessages('q-plim', 3)).toHaveLength(3)
    })
  })
}

// ── Shared MessageQueue integration suite ─────────────────────────────────

function integrationTests(
  label: string,
  factory: () => Promise<MessageStorage> | MessageStorage,
) {
  describe(`${label} — MessageQueue integration`, () => {
    function newMsg(queueId = 'q-int', extra: Partial<QueueMessage> = {}): QueueMessage {
      return {
        id: crypto.randomUUID(),
        queueId,
        payload: { value: 1 },
        attempt: 0,
        createdAt: Date.now(),
        type: 'new',
        ...extra,
      }
    }

    function makeQueue(storage: MessageStorage, action: SpyAction) {
      let queue!: MessageQueue
      class LoopbackInvoker extends MessageInvoker {
        async invoke(messages: QueueMessage[]): Promise<void> {
          await queue.handle(messages)
        }
      }
      queue = new MessageQueue(
        storage,
        action,
        new SimpleRetryStrategy(),
        new LoopbackInvoker(),
        { batchSize: 5, maxAttempts: 3, invokeRetries: 0 },
      )
      return queue
    }

    it('processes a new message and marks it done', async () => {
      const storage = await factory()
      const action = new SpyAction()
      const queue = makeQueue(storage, action)
      const msg = newMsg()

      await queue.handle([msg])

      expect((await storage.readMessage(msg.id))?.state).toBe('done')
      expect(action.executed[0]?.id).toBe(msg.id)
    })

    it('defers a new message when the queue is busy', async () => {
      const storage = await factory()
      const action = new SpyAction()
      const queue = makeQueue(storage, action)
      const queueId = 'q-busy'

      // Seed a processing row — simulates a busy queue
      await storage.writeMessage(makeStored({ id: 'blocker', queueId, state: 'processing', timestamp: 1 }))

      const msg = newMsg(queueId)
      await queue.handle([msg])

      expect((await storage.readMessage(msg.id))?.state).toBe('pending')
      expect(action.executed).toHaveLength(0)
    })

    it('drains pending messages after success', async () => {
      const storage = await factory()
      const action = new SpyAction()
      const queue = makeQueue(storage, action)
      const queueId = 'q-drain'

      // Pre-seed a pending message (simulates a message that arrived while queue was busy)
      const pending = newMsg(queueId, { id: 'pend-1', createdAt: Date.now() + 1 })
      await storage.writeMessage(makeStored({ id: pending.id, queueId, state: 'pending', timestamp: pending.createdAt, message: JSON.stringify(pending) }))

      // Trigger message — when done, should drain and process pending
      const trigger = newMsg(queueId, { type: 'flush', createdAt: Date.now() - 1 })
      await storage.writeMessage(makeStored({ id: trigger.id, queueId, state: 'pending', timestamp: trigger.createdAt, message: JSON.stringify(trigger) }))
      await queue.handle([{ ...trigger, type: 'flush' }])
      await flushMicrotasks()

      await pollUntil(async () => (await storage.readMessage(pending.id))?.state === 'done')
      expect((await storage.readMessage(pending.id))?.state).toBe('done')
    })

    it('retries a failing message and marks it failed after maxAttempts', async () => {
      const storage = await factory()
      const msgId = crypto.randomUUID()
      const action = new SpyAction().failAlways(msgId)
      const exhausted: QueueMessage[] = []
      const strategy = new SimpleRetryStrategy({
        onExhausted: async msg => { exhausted.push(msg) },
      })
      let queue!: MessageQueue
      class LoopbackInvoker extends MessageInvoker {
        async invoke(messages: QueueMessage[]): Promise<void> { await queue.handle(messages) }
      }
      queue = new MessageQueue(storage, action, strategy, new LoopbackInvoker(), {
        batchSize: 5, maxAttempts: 2, invokeRetries: 0,
      })

      await queue.handle([newMsg('q-retry', { id: msgId })])
      await pollUntil(async () => (await storage.readMessage(msgId))?.state === 'failed')

      expect((await storage.readMessage(msgId))?.state).toBe('failed')
      expect(exhausted).toHaveLength(1)
      expect(exhausted[0]!.id).toBe(msgId)
    })

    it('SimpleRetryStrategy.shouldRetry can suppress retries', async () => {
      const storage = await factory()
      const msgId = crypto.randomUUID()
      const action = new SpyAction().failAlways(msgId)
      const strategy = new SimpleRetryStrategy({
        shouldRetry: () => false,
      })
      let queue!: MessageQueue
      class LoopbackInvoker extends MessageInvoker {
        async invoke(messages: QueueMessage[]): Promise<void> { await queue.handle(messages) }
      }
      queue = new MessageQueue(storage, action, strategy, new LoopbackInvoker(), {
        batchSize: 5, maxAttempts: 3, invokeRetries: 0,
      })

      await queue.handle([newMsg('q-no-retry', { id: msgId })])

      // First attempt fails, shouldRetry=false → straight to failed, no retry invocation
      expect((await storage.readMessage(msgId))?.state).toBe('failed')
      // Action was called exactly once (no retries)
      expect(action.executed.filter(m => m.id === msgId)).toHaveLength(1)
    })

    it('handle never throws even if storage.writeMessage fails', async () => {
      const storage = await factory()
      const action = new SpyAction()
      const queue = makeQueue(storage, action)

      // Corrupt the writeMessage method mid-flight
      storage.writeMessage = async () => { throw new Error('DB offline') }

      const msg = newMsg()
      await expect(queue.handle([msg])).resolves.toBeUndefined()
    })
  })
}

// ── Run suites against both backends ──────────────────────────────────────

storageContractTests('DrizzlePgStorage (PGlite in-memory)', makePgStorage)
integrationTests('DrizzlePgStorage (PGlite in-memory)', makePgStorage)

storageContractTests('DrizzleSqliteStorage (bun:sqlite in-memory)', makeSqliteStorage)
integrationTests('DrizzleSqliteStorage (bun:sqlite in-memory)', makeSqliteStorage)
