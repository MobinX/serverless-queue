// Types
export type {
  MessageType,
  MessageState,
  QueueMessage,
  StoredMessage,
  QueueConfig,
} from "./types.ts";

// Abstract base classes
export { MessageStorage } from "./abstracts/MessageStorage.ts";
export { MessageAction } from "./abstracts/MessageAction.ts";
export { RetryStrategy } from "./abstracts/RetryStrategy.ts";
export { MessageInvoker } from "./abstracts/MessageInvoker.ts";

// Orchestrator
export { MessageQueue } from "./MessageQueue.ts";

// Drizzle storage (optional — requires drizzle-orm)
export {
  DrizzlePgStorage,
  DrizzleSqliteStorage,
  pgQueueMessages,
  sqliteQueueMessages,
  MIGRATION_SQL,
} from "./drizzle/index.ts";
export type { PgQueueTable, SqliteQueueTable } from "./drizzle/index.ts";

// Pre-built strategies
export { SimpleRetryStrategy } from "./SimpleRetryStrategy.ts";
export type { SimpleRetryStrategyOptions } from "./SimpleRetryStrategy.ts";
