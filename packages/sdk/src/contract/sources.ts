import { z } from "zod";
import {
  id,
  metadata,
  metadataField,
  page,
  timestamp,
  utf8Bytes,
} from "./common";

export const SOURCE_KINDS = ["text", "url", "file"] as const;
/** `pending` and `processing` belong to the ingest job; text sources are born `ready`. */
export const SOURCE_STATUSES = [
  "pending",
  "processing",
  "ready",
  "failed",
] as const;
export const SOURCE_FORMATS = ["markdown", "text"] as const;
export const CHUNK_LEVELS = ["document", "section", "paragraph"] as const;

export const SOURCE_CONTENT_MAX_BYTES = 1024 * 1024;
export const SOURCE_METADATA_MAX_BYTES = 16 * 1024;

/** What a file source can be made from. */
export const UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "text/markdown",
  "text/plain",
] as const;
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const documentFields = {
  content: z
    .string()
    .refine((content) => content.trim().length > 0, {
      message: "content is empty",
    })
    .refine((content) => utf8Bytes(content) <= SOURCE_CONTENT_MAX_BYTES, {
      message: "content must be 1 MB or less",
    }),
  title: z.string().min(1).max(500).nullish(),
  format: z.enum(SOURCE_FORMATS).optional(),
};

/** A fetchable address. The fetcher applies the real network checks later. */
const httpUrl = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        const web = url.protocol === "http:" || url.protocol === "https:";
        return web && url.username === "" && url.password === "";
      } catch {
        return false;
      }
    },
    { message: "Must be an http or https URL without credentials" },
  );

const metadataBody = metadataField(SOURCE_METADATA_MAX_BYTES);

/**
 * The client's own name for a document, such as `file:/home/me/notes.md`.
 * Adding a source under a name its collection already has updates that
 * source: unchanged text is a no-op, changed text a new version, and a URL
 * or a file is fetched or read again.
 */
const externalIdField = z.string().min(1).max(500).optional();

export const textSourceBody = z.object({
  kind: z.literal("text"),
  ...documentFields,
  collectionId: id.optional(),
  uri: z.string().min(1).max(2000).optional(),
  externalId: externalIdField,
  metadata: metadataBody,
});

export const urlSourceBody = z.object({
  kind: z.literal("url"),
  url: httpUrl,
  title: z.string().min(1).max(500).nullish(),
  collectionId: id.optional(),
  externalId: externalIdField,
  metadata: metadataBody,
});

export const fileSourceBody = z.object({
  kind: z.literal("file"),
  /** From `POST /uploads`, after the file has been sent to the URL it returned. */
  blobKey: z.string().min(1).max(1000),
  title: z.string().min(1).max(500).nullish(),
  collectionId: id.optional(),
  externalId: externalIdField,
  metadata: metadataBody,
});

/** `kind` defaults to text, so a plain `{ content }` body keeps working. */
export const createSourceBody = z.preprocess(
  (body) =>
    typeof body === "object" && body !== null && !("kind" in body)
      ? { ...body, kind: "text" }
      : body,
  z.discriminatedUnion("kind", [textSourceBody, urlSourceBody, fileSourceBody]),
);

export const replaceSourceBody = z.object(documentFields);

export const listSourcesQuery = z.object({
  collectionId: id,
  /** Only the source with this external id, if the collection has one. */
  externalId: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export const listChunksQuery = z.object({
  level: z.enum(CHUNK_LEVELS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

export const createUploadBody = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  size: z.number().int().min(1).max(UPLOAD_MAX_BYTES),
});

/** A document handed to rentfree, without its content. */
export const source = z
  .strictObject({
    id: z.string(),
    collectionId: z.string(),
    kind: z.enum(SOURCE_KINDS),
    status: z.enum(SOURCE_STATUSES),
    title: z.string().nullable(),
    /** Where the document came from. Informational. */
    uri: z.string().nullable(),
    /** The client's own name for it; unique among the collection's live sources. */
    externalId: z.string().nullable(),
    format: z.enum(SOURCE_FORMATS),
    metadata,
    /** Why ingest failed, when it did. */
    error: z.string().nullable(),
    version: z.number().int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: "Source" });

/**
 * A source just added, and the live source in its collection that already
 * holds exactly the same text, if there is one. Nothing is merged: both are
 * kept, and this is only a note.
 */
export const addedSource = source
  .extend({
    duplicateOf: z
      .strictObject({
        id: z.string(),
        externalId: z.string().nullable(),
        title: z.string().nullable(),
      })
      .optional(),
  })
  .meta({ id: "AddedSource" });

/** One piece of a chunked source. */
export const chunk = z
  .strictObject({
    id: z.string(),
    parentId: z.string().nullable(),
    level: z.enum(CHUNK_LEVELS),
    ordinal: z.number().int(),
    headingPath: z.string().nullable(),
    contextHeader: z.string().nullable(),
    text: z.string(),
    tokenCount: z.number().int(),
    charStart: z.number().int(),
    charEnd: z.number().int(),
  })
  .meta({ id: "Chunk" });

export const sourcePage = page(source).meta({ id: "SourcePage" });
export const chunkPage = page(chunk).meta({ id: "ChunkPage" });
export const sourceContent = z.strictObject({ content: z.string() });

/** Where to send a file's bytes before making a source of it. */
export const upload = z
  .strictObject({
    blobKey: z.string(),
    uploadUrl: z.string(),
    method: z.literal("PUT"),
    headers: z.strictObject({ "content-type": z.enum(UPLOAD_CONTENT_TYPES) }),
    expiresAt: timestamp,
  })
  .meta({ id: "Upload" });

export type Source = z.infer<typeof source>;
export type AddedSource = z.infer<typeof addedSource>;
export type Chunk = z.infer<typeof chunk>;
export type Upload = z.infer<typeof upload>;
