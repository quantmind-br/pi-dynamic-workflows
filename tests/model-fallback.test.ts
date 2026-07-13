/**
 * T1.1 — model fallback chain + phase-level fallback routing.
 *
 * Two layers are covered:
 *   1. Pure resolution — resolveFallbackModelsForPhase / parseModelRoutingFromMeta
 *      (mirrors tests/model-routing.test.ts): which fallback chain a phase gets,
 *      and that a fallback-only route never hijacks MODEL resolution.
 *   2. The real chain inside WorkflowAgent.run — driven end-to-end against the pi
 *      SDK's faux provider (same seam as tests/usage-limit-integration.test.ts):
 *      the primary model's turn ends in a provider usage-limit error, and the run
 *      must retry the SAME prompt on the next resolvable model before the limit
 *      propagates. No network call is made and no quota is consumed.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  type ModelRoutingConfig,
  parseModelRoutingFromMeta,
  resolveFallbackModelsForPhase,
  resolveModelForPhase,
} from "../src/model-routing.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// ═══════════════════════════════════════════════════════════════════════════
// resolveFallbackModelsForPhase — which fallback chain a phase resolves to
// ═══════════════════════════════════════════════════════════════════════════

test("resolveFallbackModelsForPhase: a matching phase route's chain wins over the config default", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "Review", fallbackModels: ["prov/review-fb"] }],
    defaultFallbackModels: ["prov/global-fb"],
  };
  assert.deepEqual(resolveFallbackModelsForPhase("Review", config), ["prov/review-fb"]);
});

test("resolveFallbackModelsForPhase: a regex (useRegex) route matches and supplies its chain", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "^rev", useRegex: true, fallbackModels: ["prov/rx-fb"] }],
    defaultFallbackModels: ["prov/global-fb"],
  };
  // "Review" matches ^rev (case-insensitive); an unrelated phase falls to default.
  assert.deepEqual(resolveFallbackModelsForPhase("Review", config), ["prov/rx-fb"]);
  assert.deepEqual(resolveFallbackModelsForPhase("Discovery", config), ["prov/global-fb"]);
});

test("resolveFallbackModelsForPhase: no matching route returns the config default chain", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "Review", fallbackModels: ["prov/review-fb"] }],
    defaultFallbackModels: ["prov/global-fb"],
  };
  assert.deepEqual(resolveFallbackModelsForPhase("Implement", config), ["prov/global-fb"]);
});

test("resolveFallbackModelsForPhase: no route and no default resolves to an empty chain (not undefined)", () => {
  // The workflow layer spreads this into [modelSpec, ...chain]; undefined would throw.
  const result = resolveFallbackModelsForPhase("Anything", { routes: [] });
  assert.deepEqual(result, []);
});

test("resolveFallbackModelsForPhase: a route matching the phase but with an EMPTY chain is skipped, falling to default", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "Review", fallbackModels: [] }],
    defaultFallbackModels: ["prov/global-fb"],
  };
  // The empty-chain route must not shadow the default (guards the `.length` check).
  assert.deepEqual(resolveFallbackModelsForPhase("Review", config), ["prov/global-fb"]);
});

test("resolveFallbackModelsForPhase: a route matching the phase with NO chain field is skipped, falling to default", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "Review", model: "prov/reviewer" }],
    defaultFallbackModels: ["prov/global-fb"],
  };
  assert.deepEqual(resolveFallbackModelsForPhase("Review", config), ["prov/global-fb"]);
});

test("resolveFallbackModelsForPhase: an undefined phase resolves to the default chain", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "Review", fallbackModels: ["prov/review-fb"] }],
    defaultFallbackModels: ["prov/global-fb"],
  };
  assert.deepEqual(resolveFallbackModelsForPhase(undefined, config), ["prov/global-fb"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// parseModelRoutingFromMeta — a fallback-only phase carries a chain WITHOUT
// hijacking model resolution; the default chain flows through to resolution.
// ═══════════════════════════════════════════════════════════════════════════

test("parseModelRoutingFromMeta: a phase with fallbackModels but no model carries the chain yet leaves MODEL resolution on the default", () => {
  const config = parseModelRoutingFromMeta([{ title: "Review", fallbackModels: ["prov/review-fb"] }], "prov/default");
  // The fallback-only phase resolves its chain...
  assert.deepEqual(resolveFallbackModelsForPhase("Review", config), ["prov/review-fb"]);
  // ...but must NOT hijack model resolution to `undefined` — the default model still wins.
  assert.equal(resolveModelForPhase("Review", config), "prov/default");
});

test("parseModelRoutingFromMeta: a phase with both model and fallbackModels resolves each independently", () => {
  const config = parseModelRoutingFromMeta(
    [{ title: "Review", model: "prov/reviewer", fallbackModels: ["prov/review-fb"] }],
    "prov/default",
  );
  assert.equal(resolveModelForPhase("Review", config), "prov/reviewer");
  assert.deepEqual(resolveFallbackModelsForPhase("Review", config), ["prov/review-fb"]);
});

test("parseModelRoutingFromMeta: the defaultFallbackModels arg flows through and serves phases with no matching route", () => {
  const config = parseModelRoutingFromMeta(undefined, "prov/default", ["prov/global-fb"]);
  assert.deepEqual(resolveFallbackModelsForPhase("Whatever", config), ["prov/global-fb"]);
});

test("parseModelRoutingFromMeta: a phase with an empty fallbackModels array and no model creates NO route", () => {
  // Boundary on `phase.fallbackModels?.length`: an empty array must not mint a route.
  const config = parseModelRoutingFromMeta([{ title: "Scan", fallbackModels: [] }], "prov/default", ["prov/global-fb"]);
  assert.deepEqual(config.routes, []);
  // With no route, the phase falls to the default chain.
  assert.deepEqual(resolveFallbackModelsForPhase("Scan", config), ["prov/global-fb"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent.run — the model fallback chain, driven against the faux provider
// ═══════════════════════════════════════════════════════════════════════════

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

/** Minimal faux Model shape we read back off a registration to re-register in a ModelRegistry. */
interface FauxModel {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface FauxRegistration {
  api: string;
  models: FauxModel[];
  setResponses(steps: AssistantMessage[]): void;
  getPendingResponseCount(): number;
  unregister(): void;
}

interface FauxModule {
  registerFauxProvider(options: {
    provider?: string;
    models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>;
  }): FauxRegistration;
  fauxAssistantMessage(
    content: string,
    options?: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string },
  ): AssistantMessage;
}

/**
 * Load the faux provider from the SAME pi-ai instance pi-coding-agent's
 * createAgentSession dispatches through — its nested copy when present, else the
 * bare specifier (which resolves to the shared copy when npm deduped). A model
 * routed here only reaches the faux stream if it was registered on that instance.
 * The specifier is chosen at runtime, so a static import cannot express it — the
 * one documented exception to static-only imports.
 */
async function loadFaux(): Promise<FauxModule> {
  const nested = fileURLToPath(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js",
      import.meta.url,
    ),
  );
  const entry = existsSync(nested) ? nested : "@earendil-works/pi-ai/dist/providers/faux.js";
  // Runtime-selected specifier: cast the module to the tiny surface we use.
  return (await import(entry)) as unknown as FauxModule;
}

interface ChainCtx {
  agent: WorkflowAgent;
  faux: FauxRegistration;
  /** An assistant turn that ended in a provider usage-limit error. */
  limit: () => AssistantMessage;
  /** A normal assistant turn producing the given text. */
  ok: (text: string) => AssistantMessage;
}

/**
 * Register a faux "deepseek" provider with two models (faux-primary / faux-fallback),
 * expose them through an injected ModelRegistry so the chain's specs resolve, and
 * hand a WorkflowAgent bound to that registry. Fully hermetic: fake HOME, in-memory
 * auth, temp cwd; the provider registration and temp dirs are torn down after.
 */
async function withFauxChainAgent(fn: (ctx: ChainCtx) => Promise<void>): Promise<void> {
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const home = mkdtempSync(join(tmpdir(), "pi-dw-fb-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-fb-cwd-"));
  const faux = registerFauxProvider({
    provider: "deepseek",
    models: [
      { id: "faux-primary", name: "Faux Primary", contextWindow: 128000, maxTokens: 4096 },
      { id: "faux-fallback", name: "Faux Fallback", contextWindow: 128000, maxTokens: 4096 },
    ],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const auth = AuthStorage.inMemory({ deepseek: { type: "api_key", key: "faux-dummy" } });
      const registry = ModelRegistry.inMemory(auth);
      // Surface the faux models to resolveModel()/find(); carry the faux `api` so a
      // resolved model dispatches to the faux stream registered above.
      registry.registerProvider("deepseek", {
        api: faux.api,
        baseUrl: faux.models[0].baseUrl,
        apiKey: "faux-dummy",
        models: faux.models.map((m) => ({
          id: m.id,
          name: m.name,
          api: faux.api,
          baseUrl: m.baseUrl,
          reasoning: m.reasoning,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        })),
      });
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      await fn({
        agent,
        faux,
        limit: () => fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG }),
        ok: (text) => fauxAssistantMessage(text, { stopReason: "stop" }),
      });
    });
  } finally {
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("run(): a PROVIDER_USAGE_LIMIT on the primary retries the next model and returns its result", () =>
  withFauxChainAgent(async ({ agent, faux, limit, ok }) => {
    // Primary turn hits the limit; the fallback turn succeeds.
    faux.setResponses([limit(), ok("fallback-produced-this")]);
    const fellBackTo: string[] = [];

    const result = await agent.run("do the task", {
      label: "fb",
      model: "deepseek/faux-primary",
      fallbackModels: ["deepseek/faux-fallback"],
      onModelFallback: (spec) => fellBackTo.push(spec),
    });

    assert.equal(result, "fallback-produced-this", "the fallback model's output is returned");
    assert.deepEqual(fellBackTo, ["deepseek/faux-fallback"], "the degrade to the fallback is signalled");
    assert.equal(faux.getPendingResponseCount(), 0, "both the primary and the fallback attempts actually ran");
  }));

test("run(): when EVERY candidate hits the usage limit, the last PROVIDER_USAGE_LIMIT propagates", () =>
  withFauxChainAgent(async ({ agent, faux, limit }) => {
    // Both the primary and the single fallback hit the limit.
    faux.setResponses([limit(), limit()]);

    await assert.rejects(
      () =>
        agent.run("do the task", {
          label: "fb",
          model: "deepseek/faux-primary",
          fallbackModels: ["deepseek/faux-fallback"],
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowError, "rejects with a WorkflowError");
        assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, `run pauses on the limit; got ${err.code}`);
        assert.equal(err.resetHint, "Resets in ~3h", "carries the provider reset hint from the final attempt");
        return true;
      },
    );
    // Proves the fallback WAS attempted before giving up — not an immediate primary rethrow.
    assert.equal(faux.getPendingResponseCount(), 0, "every candidate in the chain was attempted");
  }));

test("run(): an unresolvable fallback spec is skipped (still signalled) and the next resolvable model serves", () =>
  withFauxChainAgent(async ({ agent, faux, limit, ok }) => {
    // Only two turns are queued: the skipped spec must consume neither.
    faux.setResponses([limit(), ok("served-by-real-fallback")]);
    const fellBackTo: string[] = [];

    const result = await agent.run("do the task", {
      label: "fb",
      model: "deepseek/faux-primary",
      fallbackModels: ["ghost/not-a-real-model", "deepseek/faux-fallback"],
      onModelFallback: (spec) => fellBackTo.push(spec),
    });

    assert.equal(result, "served-by-real-fallback", "the real fallback served the turn after the ghost was skipped");
    assert.deepEqual(
      fellBackTo,
      ["ghost/not-a-real-model", "deepseek/faux-fallback"],
      "both the skipped ghost and the served fallback are signalled, in order",
    );
    assert.equal(
      faux.getPendingResponseCount(),
      0,
      "the ghost spec consumed no attempt — only the primary and the real fallback streamed",
    );
  }));
