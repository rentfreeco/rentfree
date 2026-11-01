import { z } from "zod";
import { timestamp } from "./common";

export const DEVICE_SESSION_STATUSES = [
  "pending",
  "approved",
  "denied",
  "claimed",
  "expired",
] as const;

export const startLoginBody = z.object({
  /** What the key will be called, such as "CLI on laptop". */
  name: z.string().trim().min(1).max(100),
});

export const pollLoginBody = z.object({
  deviceCode: z.string().min(1),
});

export const approveLoginBody = z.object({
  userCode: z.string().min(1).max(20),
  decision: z.enum(["approve", "deny"]),
});

export const userCodeParams = z.object({ userCode: z.string().min(1) });

/** A login just started: show `userCode`, open `verifyUrl`, poll with `deviceCode`. */
export const loginStarted = z
  .strictObject({
    deviceCode: z.string(),
    userCode: z.string(),
    verifyUrl: z.string(),
    /** Seconds until the codes stop working. */
    expiresIn: z.number().int(),
    /** Seconds to wait between polls. */
    interval: z.number().int(),
  })
  .meta({ id: "LoginStarted" });

/** Still waiting, or approved with the key, handed out exactly once. */
export const loginPoll = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("pending") }),
    z.strictObject({
      status: z.literal("approved"),
      apiKey: z.string(),
      keyPrefix: z.string(),
      user: z.strictObject({ id: z.string(), email: z.string().nullable() }),
      defaultCollectionId: z.string().nullable(),
    }),
  ])
  .meta({ id: "LoginPoll" });

/** What the approval page shows about a login. */
export const deviceSession = z
  .strictObject({
    userCode: z.string(),
    name: z.string(),
    status: z.enum(DEVICE_SESSION_STATUSES),
    createdAt: timestamp,
    expiresAt: timestamp,
  })
  .meta({ id: "DeviceSession" });

export const loginAnswered = z.strictObject({
  status: z.enum(["approved", "denied"]),
  name: z.string(),
});

export const health = z
  .strictObject({ ok: z.boolean(), db: z.enum(["up", "down"]) })
  .meta({ id: "Health" });

export type LoginStarted = z.infer<typeof loginStarted>;
export type LoginPoll = z.infer<typeof loginPoll>;

/** The OpenAPI 3.1 document, as `GET /openapi.json` serves it. */
export const openApiDocument = z
  .looseObject({
    openapi: z.literal("3.1.0"),
    info: z.looseObject({ title: z.string(), version: z.string() }),
    paths: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "OpenApiDocument" });
