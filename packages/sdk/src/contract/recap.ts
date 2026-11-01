import { z } from "zod";
import { metadata, timestamp } from "./common";

export const listRecapRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** One recap run: which events it read, what it decided, what it cost. */
export const recapRun = z
  .strictObject({
    id: z.string(),
    /** `manual`, `session_end`, `threshold`, or `schedule`. */
    trigger: z.string(),
    status: z.string(),
    /** The run read events with ids above this... */
    eventsFromId: z.number().int(),
    /** ...up to and including this. */
    eventsToId: z.number().int(),
    extractModel: z.string().nullable(),
    reconcileModel: z.string().nullable(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    costUsd: z.number().nullable(),
    /** Candidates, created, updated, confirmed, invalidated, skipped. */
    stats: metadata,
    error: z.string().nullable(),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .meta({ id: "RecapRun" });

/** What asking for a run did: one is going already, there is nothing to read, or one is starting. */
export const recapRunStarted = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("running"), run: recapRun }),
    z.strictObject({ status: z.literal("idle") }),
    z.strictObject({ status: z.literal("started"), unread: z.number().int() }),
  ])
  .meta({ id: "RecapRunAnswer" });

export const recapRuns = z.strictObject({ runs: z.array(recapRun) });

/** How much of the caller's content is still waiting to be embedded. */
export const indexStatus = z
  .strictObject({
    waiting: z.number().int(),
    /** Rows that failed eight times and need someone to look. */
    failed: z.number().int(),
    oldestWaitingAt: timestamp.nullable(),
  })
  .meta({ id: "IndexStatus" });

export type RecapRun = z.infer<typeof recapRun>;
export type IndexStatus = z.infer<typeof indexStatus>;
