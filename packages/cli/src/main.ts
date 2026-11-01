import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { runCli } from "./cli";
import { Fetch } from "./client";
import { Platform } from "./platform";

// The entry point the bin runs. Everything else is testable without it.
runCli(process.argv.slice(2)).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, Fetch.live, Platform.live)),
  NodeRuntime.runMain,
);
