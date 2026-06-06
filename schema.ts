// REG AI — Drizzle schema (v1, lean MVP)
//
// Every table traces to an MVP functional requirement (see docs/product-spec.md).
// If a future table doesn't trace to an FR, question whether it belongs in v1.
//
// pgvector note: `CREATE EXTENSION IF NOT EXISTS vector;` must run BEFORE this
// schema applies. It lives in the first migration (Phase 0) — drizzle-kit won't add it.
//
// DB-review fixes applied (round 1):
//   - updated_at now uses $onUpdate (defaultNow only fires on INSERT)
//   - FK indexes added where cascades/reads need them (chunks.document_id, etc.)
//   - CHECK constraints for non-negative counts and bounded score
//   - allergens promoted to a controlled enum array (safety-critical field)
//   - message_sources.similarity -> real (sort key, never summed)
//   - usage_events index made composite (restaurant_id, created_at) for rollups
//   - unique(document_id, chunk_index) on chunks (chunk-level dedup safety)
// Deferred by decision (see docs/architecture.md):
//   - Row-Level Security as defense-in-depth -> implemented in Phase 1 (needs the
//     per-request session GUC that the auth/tenancy layer sets)
//   - filtered-HNSW recall tuning (ef_search / iterative scans) -> docs/rag.md, Phase 3/7
//   - partitioning usage_events / chunks -> post-MVP

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  numeric,
  real,
  jsonb,
  timestamp,
  vector,
  index,
  unique,
  check,
  customType,
} from "drizzle-orm/pg-core";

// ---- Enums: make invalid states unrepresentable at the DB level -------------
export const userRole = pgEnum("user_role", ["owner", "manager", "trainee"]);
export const docSourceType = pgEnum("doc_source_type", ["pdf", "docx", "text"]);
export const docStatus = pgEnum("doc_status", ["pending", "processing", "done", "failed"]);
export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const usageKind = pgEnum("usage_kind", ["embedding", "completion"]);
export const progressStatus = pgEnum("progress_status", ["not_started", "in_progress", "completed"]);

// Safety-critical: the standard major allergens. Stable, regulated list — exactly
// what an enum is for. A typo on a free-text allergen field is a wrong safety answer.
export const allergen = pgEnum("allergen", [
  "milk", "eggs", "fish", "shellfish", "tree_nuts", "peanuts", "wheat", "soy", "sesame",
]);

// ---- restaurants (tenants) — FR-001 -----------------------------------------
export const restaurants = pgTable("restaurants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("standard"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ---- users — FR-002 / FR-003 ------------------------------------------------
// email is globally unique: valid because v1 scopes OUT multi-restaurant chains,
// so one user belongs to exactly one restaurant. KNOWN DOOR: supporting chains
// later means dropping this for unique(restaurant_id, email) — a painful migration,
// documented in the spec so it's a known door, not a surprise wall.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(), // argon2/bcrypt output — never plaintext
    role: userRole("role").notNull().default("trainee"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("users_restaurant_idx").on(t.restaurantId)], // tenant-scoped lookups
);

// ---- sessions — FR-002 ------------------------------------------------------
// Opaque-token server-side sessions. id = SHA-256(token) hex (NOT the raw token),
// so a DB leak can't be replayed as live sessions. No restaurant_id, no RLS:
// resolved BEFORE the tenant GUC is set (the login bootstrap).
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ---- documents — FR-005 / FR-008 / FR-009 -----------------------------------
// Unique (restaurant_id, content_hash) is the document-level dedup guarantee.
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceType: docSourceType("source_type").notNull(),
    contentHash: text("content_hash").notNull(), // SHA-256 over raw uploaded file bytes (computed at upload, pre-parse — see Phase 2 spec §2.3)
    status: docStatus("status").notNull().default("pending"),
    error: text("error"), // populated on status = failed
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    unique("documents_tenant_hash_uq").on(t.restaurantId, t.contentHash),
    index("documents_restaurant_idx").on(t.restaurantId),
  ],
);

// ---- chunks — FR-006 / FR-007 / FR-010 --------------------------------------
// restaurant_id DENORMALIZED so the hot-path retrieval is one filtered vector scan,
// no join:  WHERE restaurant_id = $1 ORDER BY embedding <=> $2 LIMIT k
// (Also the enabler for hash-partitioning by tenant later — see architecture.md.)
// embedding dimension 1536 = OpenAI text-embedding-3-small; changing the model
// changes this and requires a migration — intentionally not "flexible."
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(), // position within the document
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chunks_restaurant_idx").on(t.restaurantId),
    index("chunks_document_idx").on(t.documentId), // cascade deletes + "chunks of doc X" reads
    unique("chunks_document_index_uq").on(t.documentId, t.chunkIndex), // no two chunks at same position
    // HNSW + cosine: strong recall, no training step (unlike IVFFlat). Cosine matches
    // normalized text-embedding-3 vectors. (ef_search / iterative-scan tuning: rag.md.)
    index("chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check("chunks_index_nonneg", sql`${t.chunkIndex} >= 0`),
    check("chunks_tokens_pos", sql`${t.tokenCount} > 0`),
  ],
);

// bytea column type (drizzle pg-core has no built-in bytea). node-postgres maps
// bytea <-> Buffer natively, so no toDriver/fromDriver is needed.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// ---- document_blobs — FR-005 ------------------------------------------------
// Raw uploaded file, held between upload (202) and the worker parsing it. Separate
// table so the hot status/list reads of `documents` never drag MB of binary.
// restaurant_id is DENORMALIZED so the same tenant_isolation RLS policy applies here,
// making the privileged claim UPDATE the ONLY cross-tenant op in the pipeline.
// Dropped on successful processing; kept on failure so a re-upload retry reuses it.
export const documentBlobs = pgTable("document_blobs", {
  documentId:   uuid("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
  restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
  bytes:        bytea("bytes").notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- menu_items — FR-015 ----------------------------------------------------
// allergens: controlled enum array (safety-critical). dietary_flags: text[] on
// purpose — preference/marketing labels vary by restaurant and aren't a safety
// hazard, so they get app-level validation rather than a DB enum lock.
export const menuItems = pgTable(
  "menu_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    ingredients: text("ingredients").array(),
    allergens: allergen("allergens").array(),     // controlled vocabulary — drives safety answers
    dietaryFlags: text("dietary_flags").array(),  // e.g. vegetarian, vegan, gluten_free (app-validated)
    price: numeric("price", { precision: 10, scale: 2 }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("menu_items_restaurant_idx").on(t.restaurantId)],
);

// ---- conversations + messages — FR-013 --------------------------------------
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // $onUpdate so "recent conversations" (ORDER BY updated_at DESC) actually bumps.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("conversations_user_idx").on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId),
    index("messages_restaurant_idx").on(t.restaurantId),
  ],
);

// ---- message_sources — FR-011 / FR-014 --------------------------------------
// The grounding trail: which chunks (and how similar) produced each answer.
export const messageSources = pgTable(
  "message_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    similarity: real("similarity"), // cosine similarity at retrieval time — a sort key, never summed
  },
  (t) => [
    index("message_sources_message_idx").on(t.messageId),
    index("message_sources_chunk_idx").on(t.chunkId), // "which answers cited this chunk?" + cascade
    index("message_sources_restaurant_idx").on(t.restaurantId),
  ],
);

// ---- modules + module_progress — FR-018 / FR-019 ----------------------------
export const modules = pgTable(
  "modules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    content: jsonb("content").$type<unknown>().notNull().default([]), // structure firmed up in Phase 5
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("modules_restaurant_idx").on(t.restaurantId)],
);

export const moduleProgress = pgTable(
  "module_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    moduleId: uuid("module_id").notNull().references(() => modules.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: progressStatus("status").notNull().default("not_started"),
    score: integer("score"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("module_progress_uq").on(t.moduleId, t.userId),  // one progress row per (module, user)
    index("module_progress_user_idx").on(t.userId),         // "my progress across modules" (WHERE user_id=$1)
    check("module_progress_score_range", sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 100)`),
  ],
);

// ---- usage_events — FR-023 --------------------------------------------------
// One row per billable model call. Highest write volume; powers $/answer.
// Composite (restaurant_id, created_at) serves the Phase 6 time-windowed rollups.
// First candidate for monthly range-partitioning post-MVP.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: usageKind("kind").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_restaurant_created_idx").on(t.restaurantId, t.createdAt),
    check("usage_events_tokens_nonneg", sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0`),
    check("usage_events_cost_nonneg", sql`${t.costUsd} >= 0`),
  ],
);
