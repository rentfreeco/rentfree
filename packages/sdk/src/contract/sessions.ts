import { z } from "zod";
import {
  id,
  metadata,
  metadataField,
  page,
  pageQuery,
  timestamp,
} from "./common";

/** What may be logged. Recap reads these, so the vocabulary is closed. */
export const EVENT_TYPES = [
  "message.user",
  "message.assistant",
  "tool.call",
  "tool.result",
  "note",
] as const;

export const EVENT_METADATA_MAX_BYTES = 16 * 1024;
export const EVENT_CONTENT_MAX_CHARS = 100_000;
export const EVENT_BATCH_MAX = 100;

export const createSessionBody = z.object({
  collectionId: id.optional(),
  /** The client's own id for this run: the same one always finds the same session. */
  externalId: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(500).optional(),
});

export const updateSessionBody = z
  .object({
    title: z.string().min(1).max(500).nullable().optional(),
    ended: z.literal(true).optional(),
  })
  .refine((body) => body.title !== undefined || body.ended !== undefined, {
    message: "Nothing to change; pass title or ended",
  });

export const eventBody = z.object({
  type: z.enum(EVENT_TYPES),
  content: z.string().min(1).max(EVENT_CONTENT_MAX_CHARS),
  metadata: metadataField(EVENT_METADATA_MAX_BYTES),
});

export const eventBatchBody = z.object({
  events: z.array(eventBody).min(1).max(EVENT_BATCH_MAX),
});

/** One event, or `{ events: [...] }` for an atomic batch. */
export const appendEventsBody = z.union([eventBatchBody, eventBody]);

export const listSessionsQuery = z.object({
  collectionId: id,
  /** Only the session with this external id, if the collection has one. */
  externalId: z.string().min(1).max(200).optional(),
  ...pageQuery({ max: 100, default: 20 }),
});

export const listEventsQuery = z.object(pageQuery({ max: 100, default: 20 }));

/** One continuous run of an agent. */
export const session = z
  .strictObject({
    id: z.string(),
    collectionId: z.string().nullable(),
    /** The agent that started it; null for a user-level key. */
    agentId: z.string().nullable(),
    externalId: z.string().nullable(),
    title: z.string().nullable(),
    startedAt: timestamp,
    endedAt: timestamp.nullable(),
  })
  .meta({ id: "Session" });

/** One thing that happened in a session. Immutable once written. */
export const event = z
  .strictObject({
    /** Increases with every event a user logs; recap reads in this order. */
    id: z.number().int(),
    sessionId: z.string(),
    agentId: z.string().nullable(),
    type: z.enum(EVENT_TYPES),
    content: z.string(),
    metadata,
    createdAt: timestamp,
  })
  .meta({ id: "Event" });

export const sessionPage = page(session).meta({ id: "SessionPage" });
export const eventPage = page(event).meta({ id: "EventPage" });
export const appendedEvents = z.strictObject({ events: z.array(event) });

export type Session = z.infer<typeof session>;
export type SessionEvent = z.infer<typeof event>;
