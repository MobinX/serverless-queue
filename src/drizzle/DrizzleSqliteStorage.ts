import { eq, and, desc, asc } from 'drizzle-orm'
import { MessageStorage } from '../abstracts/MessageStorage.ts'
import type { StoredMessage, MessageState } from '../types.ts'
import { sqliteQueueMessages, type SqliteQueueTable } from './schema.ts'

export class DrizzleSqliteStorage extends MessageStorage {
  constructor(
    private readonly db: {
      select: (...args: any[]) => any
      insert: (...args: any[]) => any
      update: (...args: any[]) => any
      delete: (...args: any[]) => any
    },
    private readonly table: SqliteQueueTable = sqliteQueueMessages,
  ) {
    super()
  }

  async readMessage(id: string): Promise<StoredMessage | null> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(eq(this.table.id, id))
      .limit(1)
    return rows[0] ? this.toStoredMessage(rows[0]) : null
  }

  async writeMessage(msg: StoredMessage): Promise<void> {
    await this.db.insert(this.table).values({
      id: msg.id,
      queueId: msg.queueId,
      message: msg.message,
      timestamp: msg.timestamp,
      state: msg.state,
    })
  }

  async updateMessage(msg: StoredMessage): Promise<void> {
    await this.db
      .update(this.table)
      .set({ message: msg.message, state: msg.state })
      .where(eq(this.table.id, msg.id))
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.delete(this.table).where(eq(this.table.id, id))
  }

  async readLastMessageByQueue(queueId: string): Promise<StoredMessage | null> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(eq(this.table.queueId, queueId))
      .orderBy(desc(this.table.timestamp))
      .limit(1)
    return rows[0] ? this.toStoredMessage(rows[0]) : null
  }

  async readMessagesByQueue(
    queueId: string,
    state?: MessageState,
    limit?: number,
  ): Promise<StoredMessage[]> {
    let q = this.db
      .select()
      .from(this.table)
      .where(
        state
          ? and(eq(this.table.queueId, queueId), eq(this.table.state, state))
          : eq(this.table.queueId, queueId),
      )
      .orderBy(asc(this.table.timestamp))
    if (limit !== undefined) q = q.limit(limit)
    const rows = await q
    return rows.map((r: any) => this.toStoredMessage(r))
  }

  async readPendingMessages(queueId: string, limit: number): Promise<StoredMessage[]> {
    return this.readMessagesByQueue(queueId, 'pending', limit)
  }

  private toStoredMessage(row: {
    id: string
    queueId: string
    message: string
    timestamp: number
    state: StoredMessage['state']
  }): StoredMessage {
    return {
      id: row.id,
      queueId: row.queueId,
      message: row.message,
      timestamp: Number(row.timestamp),
      state: row.state,
    }
  }
}
