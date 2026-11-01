import type { Memory, RecapRun, Session, Source } from "../contract";

/** Records shaped as the api sends them, for canned answers. */
const at = "2026-10-19T12:00:00.000Z";

export const memory = (over: Partial<Memory> = {}): Memory => ({
  id: "mem_1",
  collectionId: "col_1",
  type: "fact",
  tier: "long",
  origin: "agent",
  status: "active",
  subject: null,
  content: "The team ships on Fridays.",
  confidence: 1,
  importance: 0.5,
  importanceNow: 0.5,
  version: 1,
  validFrom: at,
  validTo: null,
  supersedesId: null,
  accessCount: 0,
  lastAccessedAt: null,
  createdAt: at,
  updatedAt: at,
  expiresAt: null,
  ...over,
});

export const session = (over: Partial<Session> = {}): Session => ({
  id: "ses_1",
  collectionId: "col_1",
  agentId: "agent_1",
  externalId: null,
  title: null,
  startedAt: at,
  endedAt: null,
  ...over,
});

export const source = (over: Partial<Source> = {}): Source => ({
  id: "src_1",
  collectionId: "col_1",
  kind: "text",
  status: "ready",
  title: "Notes",
  uri: null,
  externalId: null,
  format: "markdown",
  metadata: {},
  error: null,
  version: 1,
  createdAt: at,
  updatedAt: at,
  ...over,
});

export const recapRun = (over: Partial<RecapRun> = {}): RecapRun => ({
  id: "run_1",
  trigger: "manual",
  status: "succeeded",
  eventsFromId: 0,
  eventsToId: 10,
  extractModel: "m",
  reconcileModel: "m",
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.001,
  stats: { created: 2 },
  error: null,
  startedAt: at,
  finishedAt: at,
  ...over,
});
