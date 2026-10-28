import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), externalId: text("external_id").notNull(), channel: text("channel").notNull(), body: text("body").notNull(), bodyHash: text("body_hash").notNull(), createdAt: integer("created_at").notNull(), result: text("result"), resultAt: integer("result_at"),
  replyTo: text("reply_to"),
}, t => [uniqueIndex("message_owner_external").on(t.owner, t.externalId), uniqueIndex("message_owner_reply").on(t.owner, t.replyTo), index("message_owner_time").on(t.owner, t.createdAt)]);
export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), channel: text("channel").notNull(), callback: text("callback").notNull(), secret: text("secret").notNull(), oldSecret: text("old_secret"), rotationUntil: integer("rotation_until"), expiresAt: integer("expires_at").notNull(), verifiedAt: integer("verified_at").notNull(), active: integer("active").notNull(),
}, t => [index("subscription_owner").on(t.owner, t.active)]);
export const deliveries = sqliteTable("deliveries", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), messageId: text("message_id").notNull(), subscriptionId: text("subscription_id").notNull(), state: text("state").notNull(), attempts: integer("attempts").notNull(), nextAt: integer("next_at").notNull(), leaseUntil: integer("lease_until").notNull(), status: integer("status"), reason: text("reason"),
}, t => [index("delivery_owner_due").on(t.owner, t.state, t.nextAt)]);
export const rateBuckets = sqliteTable("rate_buckets", { id: text("id").primaryKey(), count: integer("count").notNull(), expiresAt: integer("expires_at").notNull() });
export const protocolLog = sqliteTable("protocol_log", { id: text("id").primaryKey(), owner: text("owner").notNull(), method: text("method").notNull(), outcome: text("outcome").notNull(), createdAt: integer("created_at").notNull() });
export const grokOutbox = sqliteTable("grok_outbox", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), externalId: text("external_id").notNull(), channel: text("channel").notNull(), destinationHash: text("destination_hash").notNull(), body: text("body").notNull(), state: text("state").notNull(), attempts: integer("attempts").notNull(), nextAt: integer("next_at").notNull(), leaseUntil: integer("lease_until").notNull(), claimToken: text("claim_token"), status: integer("status"), reason: text("reason"), createdAt: integer("created_at").notNull(), acceptedAt: integer("accepted_at"),
}, t => [uniqueIndex("grok_owner_message").on(t.owner, t.externalId), index("grok_owner_due").on(t.owner, t.state, t.nextAt)]);
