import { z } from "zod";
import { id, timestamp } from "./common";

export const SEARCH_KINDS = ["memory", "chunk"] as const;
export const CONTEXT_BUDGET = { min: 200, max: 16_000, default: 2000 } as const;

const question = z.string().trim().min(1).max(2000);

export const searchBody = z.object({
  query: question,
  /** Defaults to every collection the key may read. */
  collectionIds: z.array(id).min(1).max(50).optional(),
  kinds: z.array(z.enum(SEARCH_KINDS)).min(1).default(["memory", "chunk"]),
  types: z.array(z.string().min(1)).min(1).max(20).optional(),
  tiers: z.array(z.string().min(1)).min(1).max(20).optional(),
  /** What was true at this moment; defaults to now. */
  asOf: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const contextBody = z.object({
  collectionId: id,
  /** Without one, the pack is the profile and the most important memories. */
  query: question.optional(),
  tokenBudget: z
    .number()
    .int()
    .min(CONTEXT_BUDGET.min)
    .max(CONTEXT_BUDGET.max)
    .default(CONTEXT_BUDGET.default),
});

/** How an item ranked. Only the order of `score` means anything. */
const ranking = {
  score: z.number(),
  /** Rank by meaning, from 1, or null if it was not among those candidates. */
  vectorRank: z.number().int().nullable(),
  /** Rank by words in common, likewise. */
  textRank: z.number().int().nullable(),
};

const memoryHitFields = {
  id: z.string(),
  collectionId: z.string(),
  type: z.string(),
  tier: z.string(),
  subject: z.string().nullable(),
  content: z.string(),
  importance: z.number(),
  validFrom: timestamp,
  createdAt: timestamp,
};

const chunkHitFields = {
  id: z.string(),
  text: z.string(),
  headingPath: z.string().nullable(),
  source: z.strictObject({
    id: z.string(),
    title: z.string().nullable(),
    uri: z.string().nullable(),
    collectionId: z.string(),
  }),
};

export const memoryHit = z
  .strictObject({ ...memoryHitFields, ...ranking })
  .meta({ id: "MemoryHit" });

export const chunkHit = z
  .strictObject({ ...chunkHitFields, ...ranking })
  .meta({ id: "ChunkHit" });

export const searchResult = z
  .strictObject({
    /** `text` when the question could not be embedded, so only words were matched. */
    mode: z.enum(["hybrid", "text"]),
    memories: z.array(memoryHit),
    chunks: z.array(chunkHit),
  })
  .meta({ id: "SearchResult" });

/**
 * A memory in a context pack. With a query it carries its ranking; without
 * one, memories are chosen by importance and carry none.
 */
const packedMemory = z.strictObject({
  ...memoryHitFields,
  score: ranking.score.optional(),
  vectorRank: ranking.vectorRank.optional(),
  textRank: ranking.textRank.optional(),
});

/** Text for a prompt, within a token budget, and what went into it. */
export const contextPack = z
  .strictObject({
    /** The pack rendered for a model: profile, memories, then passages. */
    text: z.string(),
    /** Tokens in `text`; never more than `tokenBudget`. */
    tokenCount: z.number().int(),
    tokenBudget: z.number().int(),
    mode: z.enum(["hybrid", "text", "importance"]),
    profile: z
      .strictObject({
        version: z.number().int(),
        tokenCount: z.number().int(),
        truncated: z.boolean(),
      })
      .nullable(),
    memories: z.array(packedMemory),
    chunks: z.array(chunkHit),
  })
  .meta({ id: "ContextPack" });

/** A collection's standing summary, rewritten by recap. */
export const profile = z
  .strictObject({
    collectionId: z.string(),
    version: z.number().int(),
    content: z.string(),
    tokenCount: z.number().int(),
    generatedAt: timestamp,
  })
  .meta({ id: "Profile" });

export type SearchResult = z.infer<typeof searchResult>;
export type ContextPack = z.infer<typeof contextPack>;
export type Profile = z.infer<typeof profile>;
