import { pgTable, text, bigint } from 'drizzle-orm/pg-core'
import { sqliteTable, text as sqliteText, integer } from 'drizzle-orm/sqlite-core'

export const pgQueueMessages = pgTable('queue_messages', {
  id: text('id').primaryKey(),
  queueId: text('queue_id').notNull(),
  message: text('message').notNull(),
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  state: text('state').$type<'pending' | 'processing' | 'done' | 'failed'>().notNull(),
})

export const sqliteQueueMessages = sqliteTable('queue_messages', {
  id: sqliteText('id').primaryKey(),
  queueId: sqliteText('queue_id').notNull(),
  message: sqliteText('message').notNull(),
  timestamp: integer('timestamp').notNull(),
  state: sqliteText('state').$type<'pending' | 'processing' | 'done' | 'failed'>().notNull(),
})

export type PgQueueTable = typeof pgQueueMessages
export type SqliteQueueTable = typeof sqliteQueueMessages

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS queue_messages (
  id          TEXT        NOT NULL PRIMARY KEY,
  queue_id    TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  timestamp   BIGINT      NOT NULL,
  state       TEXT        NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_queue_messages_queue_id_timestamp
  ON queue_messages (queue_id, timestamp);
`.trim()
