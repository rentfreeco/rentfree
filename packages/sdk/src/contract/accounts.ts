import { z } from "zod";
import { id, timestamp } from "./common";

export const archivableQuery = z.object({
  status: z.enum(["active", "archived"]).default("active"),
});
export const revocableQuery = z.object({
  status: z.enum(["active", "revoked"]).default("active"),
});

const name = z.string().trim().min(1).max(100);
const ids = z.array(id).max(100);

export const patchMeBody = z.object({
  embedModel: z.string().min(1),
  embedDimensions: z.number().int().positive().nullable().optional(),
});

export const createCollectionBody = z.object({ name });

export const patchCollectionBody = z
  .object({ name: name.optional(), isDefault: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.isDefault !== undefined, {
    message: "Nothing to change; pass name or isDefault",
  });

const permissions = {
  canReadMemories: z.boolean(),
  canWriteMemories: z.boolean(),
  readCollectionIds: ids,
  writeCollectionIds: ids,
};

export const createAgentBody = z.object({ name, ...permissions });

export const patchAgentBody = z
  .object({
    name: name.optional(),
    canReadMemories: permissions.canReadMemories.optional(),
    canWriteMemories: permissions.canWriteMemories.optional(),
    readCollectionIds: ids.optional(),
    writeCollectionIds: ids.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "Nothing to change",
  });

export const createKeyBody = z.object({
  name,
  /** The agent the key acts as; without one the key is user-level. */
  agentId: id.optional(),
});

export const user = z
  .strictObject({
    id: z.string(),
    email: z.string().nullable(),
    embedModel: z.string(),
    embedDimensions: z.number().int().nullable(),
    createdAt: timestamp,
  })
  .meta({ id: "User" });

export const collection = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    isDefault: z.boolean(),
    createdAt: timestamp,
    archivedAt: timestamp.nullable(),
  })
  .meta({ id: "Collection" });

export const agent = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    canReadMemories: z.boolean(),
    canWriteMemories: z.boolean(),
    readCollectionIds: z.array(z.string()),
    writeCollectionIds: z.array(z.string()),
    createdAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .meta({ id: "Agent" });

const keyFields = {
  id: z.string(),
  name: z.string().nullable(),
  /** The first characters of the key, safe to show. */
  keyPrefix: z.string(),
  agentId: z.string().nullable(),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
};

export const key = z.strictObject(keyFields).meta({ id: "Key" });

/** A key just made: the record, and the secret this once. */
export const createdKey = z
  .strictObject({ ...keyFields, apiKey: z.string() })
  .meta({ id: "CreatedKey" });

/** The caller: the user, the key in use, and what it can see. */
export const me = z
  .strictObject({
    user,
    caller: z.strictObject({
      /** Null for a user-level key. */
      agentId: z.string().nullable(),
      apiKeyId: z.string(),
      keyPrefix: z.string().nullable(),
      keyName: z.string().nullable(),
    }),
    collections: z.array(collection),
    /** Present only for a user-level key. */
    agents: z.array(agent).optional(),
  })
  .meta({ id: "Me" });

export const deletedUser = z.strictObject({
  id: z.string(),
  deletedAt: timestamp,
});
export const collectionList = z.strictObject({
  collections: z.array(collection),
});
export const agentList = z.strictObject({ agents: z.array(agent) });
export const keyList = z.strictObject({ keys: z.array(key) });
export const revokedAgent = z.strictObject({
  agent,
  keysRevoked: z.number().int(),
});

export type User = z.infer<typeof user>;
export type Collection = z.infer<typeof collection>;
export type Agent = z.infer<typeof agent>;
export type Key = z.infer<typeof key>;
export type CreatedKey = z.infer<typeof createdKey>;
export type Me = z.infer<typeof me>;
