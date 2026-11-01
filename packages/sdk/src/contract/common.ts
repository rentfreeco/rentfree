import { z } from "zod";

/**
 * Pieces every part of the contract shares. The contract runs in the api
 * and in any client, so nothing here may depend on Node: byte counts use
 * `TextEncoder`, not `Buffer`.
 */

/** Bytes in a string as UTF-8. */
export const utf8Bytes = (text: string) =>
  new TextEncoder().encode(text).length;

/** A timestamp as the api writes one: ISO 8601, in UTC. */
export const timestamp = z.iso.datetime({ offset: true });

/** An id the api made, or one a caller names. */
export const id = z.string().min(1);

/** A `jsonb` object a caller may attach, capped in size. */
export const metadataField = (maxBytes: number) =>
  z
    .record(z.string(), z.unknown())
    .default({})
    .refine((metadata) => utf8Bytes(JSON.stringify(metadata)) <= maxBytes, {
      message: `metadata must be ${maxBytes / 1024} KB or less`,
    });

/** Metadata as the api returns it. */
export const metadata = z.record(z.string(), z.unknown());

/** One problem with a request. `path` is dotted, empty for the request as a whole. */
export const issue = z.strictObject({ path: z.string(), message: z.string() });

/** Every error the api answers with. */
export const errorBody = z
  .strictObject({
    error: z.string(),
    issues: z.array(issue).optional(),
  })
  .meta({ id: "Error" });

export type ErrorBody = z.infer<typeof errorBody>;

/** A page of a keyset-paginated list. `nextCursor` is opaque; null on the last page. */
export const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });

/** The query a cursor-paginated list takes. */
export const pageQuery = (limit: { max: number; default: number }) => ({
  limit: z.coerce.number().int().min(1).max(limit.max).default(limit.default),
  cursor: z.string().min(1).optional(),
});

/** A path with one id in it. */
export const idParams = z.object({ id });
