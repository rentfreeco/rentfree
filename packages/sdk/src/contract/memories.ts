import { z } from "zod";
import { id, metadata, page, timestamp } from "./common";

export const MEMORY_TIERS = ["working", "long"] as const;
export const MEMORY_STATUSES = ["active", "archived", "expired"] as const;
/** The types recap writes. `type` is free text; these are the documented vocabulary. */
export const MEMORY_TYPES = ["fact", "preference", "decision", "plan"] as const;
export const MEMORY_CONTENT_MAX_CHARS = 20_000;

export const createMemoryBody = z.object({
  collectionId: id,
  type: z.string().min(1),
  tier: z.enum(MEMORY_TIERS),
  content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS),
  subject: z.string().min(1).max(500).nullish(),
  importance: z.number().min(0).max(1).optional(),
  /** Only for a working memory: within thirty days. One without lasts a day. */
  expiresAt: z.iso.datetime().optional(),
});

export const patchMemoryBody = z
  .object({
    content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS).optional(),
    subject: z.string().min(1).max(500).nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Nothing to change; pass content, subject, importance, or status",
  })
  .refine(
    (body) => body.status === undefined || Object.keys(body).length === 1,
    {
      message: "Change status on its own",
      path: ["status"],
    },
  );

export const listMemoriesQuery = z.object({
  collectionId: id,
  status: z.enum(MEMORY_STATUSES).default("active"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Something the agent or the user should remember, with its lifecycle. */
export const memory = z
  .strictObject({
    id: z.string(),
    collectionId: z.string(),
    type: z.string(),
    tier: z.string(),
    /** Who made it: `agent`, `user`, or `recap`. */
    origin: z.string(),
    status: z.enum(MEMORY_STATUSES),
    subject: z.string().nullable(),
    content: z.string(),
    confidence: z.number(),
    importance: z.number(),
    /** What the memory is worth to a context pack today, after fading. */
    importanceNow: z.number(),
    version: z.number().int(),
    validFrom: timestamp,
    /** Set when recap superseded or invalidated it. */
    validTo: timestamp.nullable(),
    supersedesId: z.string().nullable(),
    accessCount: z.number().int(),
    lastAccessedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp.nullable(),
  })
  .meta({ id: "Memory" });

/** One row of a memory's history. */
export const memoryChange = z
  .strictObject({
    id: z.number().int(),
    op: z.string(),
    /** `user:<id>`, `agent:<id>`, `recap`, or `system`. */
    actor: z.string(),
    reason: z.string().nullable(),
    before: metadata.nullable(),
    after: metadata.nullable(),
    recapRunId: z.string().nullable(),
    createdAt: timestamp,
  })
  .meta({ id: "MemoryChange" });

/** Where a memory came from: a document chunk, an event in a session, or both. */
export const memorySource = z
  .strictObject({
    sourceId: z.string().nullable(),
    chunkId: z.string().nullable(),
    eventId: z.number().int().nullable(),
    sessionId: z.string().nullable(),
    quote: z.string().nullable(),
    createdAt: timestamp,
  })
  .meta({ id: "MemorySource" });

export const memoryPage = page(memory).meta({ id: "MemoryPage" });
export const memoryHistory = z.strictObject({ items: z.array(memoryChange) });
export const memorySources = z.strictObject({ items: z.array(memorySource) });

export type Memory = z.infer<typeof memory>;
export type MemoryChange = z.infer<typeof memoryChange>;
export type MemorySource = z.infer<typeof memorySource>;
