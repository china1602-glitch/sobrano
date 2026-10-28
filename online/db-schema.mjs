import { sqliteTable, text, integer, primaryKey, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const catalogEntries = sqliteTable('catalog_entries', {
  kind: text('kind').notNull(), position: integer('position').notNull(), rowJson: text('row_json').notNull(),
}, t => [primaryKey({ columns:[t.kind,t.position] }),
  check('catalog_kind', sql`${t.kind} IN ('product','build','offer')`), check('catalog_position',sql`${t.position} >= 0`)]);
export const catalogMetadata = sqliteTable('catalog_metadata', { key:text('key').primaryKey(),value:text('value').notNull() });
export const visitorSessions = sqliteTable('visitor_sessions', {
  ownerId:text('owner_id').primaryKey(), tokenHash:text('token_hash').notNull().unique(),
  csrfToken:text('csrf_token').notNull(), createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),
},t=>[index('visitor_sessions_expiry').on(t.expiresAt)]);
export const savedBuilds = sqliteTable('saved_builds', {
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull().references(()=>visitorSessions.ownerId),
  name:text('name').notNull(),partsJson:text('parts_json').notNull(),createdAt:text('created_at').notNull(),
  updatedAt:text('updated_at').notNull(),version:integer('version').notNull().default(1),
  requestId:text('request_id').notNull(),requestHash:text('request_hash').notNull(),
},t=>[uniqueIndex('saved_builds_owner_request').on(t.ownerId,t.requestId),
  index('saved_builds_owner_updated').on(t.ownerId,t.updatedAt),
  check('build_name',sql`length(${t.name}) BETWEEN 1 AND 80`),check('build_version',sql`${t.version}>0`)]);

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().unique().references(()=>visitorSessions.ownerId),
  username: text('username').notNull().unique(), displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(), createdAt: text('created_at').notNull(),
});
export const accountSessions = sqliteTable('account_sessions', {
  tokenHash:text('token_hash').primaryKey(),accountId:text('account_id').notNull().references(()=>accounts.id),
  csrfToken:text('csrf_token').notNull(),createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),
},t=>[index('account_sessions_expiry').on(t.expiresAt),index('account_sessions_account').on(t.accountId)]);
export const authRateLimits = sqliteTable('auth_rate_limits', {
  bucketKey:text('bucket_key').primaryKey(),windowStart:integer('window_start').notNull(),attempts:integer('attempts').notNull(),
});
