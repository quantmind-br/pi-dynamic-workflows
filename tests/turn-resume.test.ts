/**
 * Unit tests for T2.1 — turn-level session checkpoint (src/agent.ts).
 *
 * These drive the REAL WorkflowAgent.run() session-lifecycle logic (reopen vs.
 * create vs. in-memory, the mid-turn PROVIDER_USAGE_LIMIT checkpoint attach, and
 * the success-path unlink) while replacing the pi SDK's SessionManager /
 * createAgentSession with in-memory fakes via `mock.module`. The fakes write and
 * remove REAL files under a temp dir, so `partialSessionFile` existence and the
 * success cleanup are asserted against the actual filesystem — the branch chosen
 * and the prompt text handed to the model are run()'s own behavior, not the fake's.
 *
 * Requires `--experimental-test-module-mocks` (enabled on the test:unit script):
 *   npx tsx --experimental-test-module-mocks --test tests/turn-resume.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import * as realPi from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** The verbatim shape a provider buries a quota exhaustion in (stopReason "error"). */
const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

type TurnOutcome = "limit" | "success";

/**
 * Cross-call recorder the fakes write into and each test reads. Reset in
 * beforeEach so assertions never see a prior test's session/manager.
 */
interface TurnRecorder {
  /** Outcome baked into the next FakeSession at creation time. */
  outcome: TurnOutcome;
  /** Every file path handed to SessionManager.open (the reopen branch). */
  openedFiles: string[];
  /** The most recently constructed manager (its getSessionFile() is the checkpoint). */
  lastManager?: FakeSessionManager;
  /** The most recently constructed session (its prompts[] are what run() sent the model). */
  lastSession?: FakeSession;
}

const rec: TurnRecorder = { outcome: "limit", openedFiles: [] };

/**
 * In-memory stand-in for the SDK session. `prompt()` records the exact text run()
 * sent and appends the assistant message that decides the turn: a stopReason
 * "error" usage-limit message (so throwIfProviderLimit fires) or a normal text
 * turn. Records are what the tests assert against.
 */
class FakeSession {
  readonly messages: unknown[] = [];
  readonly prompts: string[] = [];
  disposed = false;
  aborted = false;

  constructor(private readonly outcome: TurnOutcome) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (this.outcome === "limit") {
      this.messages.push({ role: "assistant", stopReason: "error", errorMessage: USAGE_LIMIT_MSG, content: [] });
    } else {
      this.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "task complete" }] });
    }
  }

  subscribe(): () => void {
    return () => {};
  }

  abort(): void {
    this.aborted = true;
  }

  getSessionStats(): {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
  } {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * In-memory SessionManager. `create` writes a REAL empty JSONL under the given
 * dir (so `partialSessionFile` genuinely exists on disk and the success path has
 * something to unlink); `open` records the reopened path; `inMemory` has no file.
 * getSessionFile() returns the backing file (undefined for in-memory) — the flag
 * run() keys "checkpointable" on.
 */
class FakeSessionManager {
  readonly session: FakeSession;

  constructor(readonly file: string | undefined) {
    this.session = new FakeSession(rec.outcome);
    rec.lastManager = this;
    rec.lastSession = this.session;
  }

  static create(_cwd: string, dir: string): FakeSessionManager {
    const file = join(dir, "faux-session.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session_start" })}\n`);
    return new FakeSessionManager(file);
  }

  static open(file: string): FakeSessionManager {
    rec.openedFiles.push(file);
    return new FakeSessionManager(file);
  }

  static inMemory(): FakeSessionManager {
    return new FakeSessionManager(undefined);
  }

  getSessionFile(): string | undefined {
    return this.file;
  }
}

/** Hands run() the session bound to the SessionManager it just built. */
async function fakeCreateAgentSession(options: { sessionManager?: unknown }): Promise<{ session: FakeSession }> {
  const sm = options.sessionManager;
  if (sm instanceof FakeSessionManager) return { session: sm.session };
  throw new Error("fakeCreateAgentSession: expected a FakeSessionManager to be passed in");
}

/** SettingsManager is passed to (and ignored by) the faked createAgentSession. */
const fakeSettingsManager = {
  create(): Record<string, never> {
    return {};
  },
};

// Register BEFORE agent.js loads: keep every real export (defineTool,
// parseFrontmatter, ModelRegistry, …) and swap only the session seam.
const sdkMock = mock.module("@earendil-works/pi-coding-agent", {
  exports: {
    ...realPi,
    SessionManager: FakeSessionManager,
    createAgentSession: fakeCreateAgentSession,
    SettingsManager: fakeSettingsManager,
  },
});

// Module-loading boundary: WorkflowAgent must be imported AFTER mock.module so its
// pi-coding-agent bindings resolve to the fakes above. A static import would hoist
// above the mock and capture the real SDK, so a dynamic import is required here.
const { WorkflowAgent } = await import("../src/agent.js");

after(() => {
  sdkMock.restore();
  mock.restoreAll();
});

beforeEach(() => {
  rec.outcome = "limit";
  rec.openedFiles.length = 0;
  rec.lastManager = undefined;
  rec.lastSession = undefined;
});

/**
 * Isolated env for one test: a fake HOME (so model-tier resolution finds no config
 * and no real credentials are touched), a throwaway agent cwd, and a session dir.
 * Everything is torn down afterward. Used by every test here in lockstep.
 */
async function withTurnResumeEnv(
  fn: (ctx: { agent: InstanceType<typeof WorkflowAgent>; sessionDir: string }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-t21-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-t21-cwd-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-dw-t21-sess-"));
  const agent = new WorkflowAgent({ cwd, tools: [] });
  try {
    await withFakeHomeAsync(home, () => fn({ agent, sessionDir }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

test("a mid-turn usage limit on a file-backed session throws PROVIDER_USAGE_LIMIT carrying a partialSessionFile that exists on disk", () =>
  withTurnResumeEnv(async ({ agent, sessionDir }) => {
    rec.outcome = "limit";
    let captured: WorkflowError | undefined;
    await assert.rejects(
      () => agent.run("do the task", { label: "probe", sessionDir }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowError, "throws a WorkflowError");
        captured = err;
        return true;
      },
    );
    assert.equal(captured?.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, "classified as a provider usage limit");
    assert.equal(captured?.recoverable, false, "non-recoverable so the run checkpoints (paused) rather than retries");
    assert.equal(typeof captured?.partialSessionFile, "string", "the paused agent's session file is attached");
    assert.equal(captured?.partialSessionFile, rec.lastManager?.getSessionFile(), "it is the created session's file");
    assert.equal(existsSync(captured?.partialSessionFile ?? ""), true, "the checkpoint persists on disk for resume");
  }));

test("an in-memory session (no sessionDir) surfaces the usage limit WITHOUT a partialSessionFile", () =>
  withTurnResumeEnv(async ({ agent }) => {
    rec.outcome = "limit";
    await assert.rejects(
      () => agent.run("do the task", { label: "probe" }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowError);
        assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
        assert.equal(err.partialSessionFile, undefined, "an in-memory turn has no checkpoint to reopen");
        return true;
      },
    );
    assert.equal(rec.lastManager?.getSessionFile(), undefined, "the session was in-memory (no backing file)");
  }));

test("resuming from the checkpoint reopens that file and drives the continuation prompt, not the full task prompt", () =>
  withTurnResumeEnv(async ({ agent, sessionDir }) => {
    const originalTask = "ORIGINAL-TASK-MARKER-do-the-big-thing";

    // Step 1: a limit run produces a real checkpoint file.
    rec.outcome = "limit";
    let checkpoint: string | undefined;
    await assert.rejects(
      () => agent.run(originalTask, { label: "step", sessionDir }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowError);
        checkpoint = err.partialSessionFile;
        return true;
      },
    );
    assert.equal(typeof checkpoint, "string");
    assert.equal(existsSync(checkpoint ?? ""), true, "checkpoint written before resume");

    // Step 2: resume — the budget refilled, so this turn succeeds.
    rec.openedFiles.length = 0;
    rec.lastSession = undefined;
    rec.outcome = "success";
    const result = await agent.run(originalTask, { label: "step", resumeSessionFile: checkpoint });

    assert.equal(result, "task complete", "the reopened turn completes");
    assert.deepEqual(rec.openedFiles, [checkpoint], "SessionManager.open was called with the checkpoint file");
    const sent = rec.lastSession?.prompts ?? [];
    assert.equal(sent.length, 1, "the reopened turn is prompted exactly once");
    assert.ok(
      sent[0].startsWith("Continue the previous task from exactly where it stopped."),
      `expected the continuation prompt, got: ${sent[0]}`,
    );
    assert.ok(!sent[0].includes(originalTask), "the full task prompt is NOT restated on resume");
  }));

test("a successful file-backed turn unlinks its checkpoint (no leftover session file)", () =>
  withTurnResumeEnv(async ({ agent, sessionDir }) => {
    rec.outcome = "success";
    const result = await agent.run("do the task", { label: "ok", sessionDir });

    assert.equal(result, "task complete", "the turn returns the assistant text");
    const file = rec.lastManager?.getSessionFile();
    assert.equal(typeof file, "string", "the turn ran on a file-backed session");
    assert.equal(existsSync(file ?? ""), false, "a completed turn drops its persisted session file");
  }));

test("a schema agent's continuation prompt still carries the structured-output contract", () =>
  withTurnResumeEnv(async ({ agent, sessionDir }) => {
    const originalTask = "ORIGINAL-SCHEMA-TASK-MARKER";
    // A pre-existing checkpoint file to reopen (content is irrelevant to run()).
    const checkpoint = join(sessionDir, "prior-schema-session.jsonl");
    writeFileSync(checkpoint, `${JSON.stringify({ type: "session_start" })}\n`);

    rec.outcome = "limit"; // re-hit the limit so we assert the prompt before schema resolution
    await assert.rejects(
      () =>
        agent.run(originalTask, {
          label: "schema-step",
          schema: Type.Object({ answer: Type.String() }),
          resumeSessionFile: checkpoint,
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowError);
        assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
        return true;
      },
    );

    assert.deepEqual(rec.openedFiles, [checkpoint], "reopened the provided checkpoint");
    const prompt = rec.lastSession?.prompts[0] ?? "";
    assert.ok(
      prompt.startsWith("Continue the previous task from exactly where it stopped."),
      `expected the continuation prompt, got: ${prompt}`,
    );
    assert.ok(prompt.includes("Final output contract:"), "the structured-output contract header is re-appended");
    assert.ok(
      prompt.includes("Your final action MUST be a structured_output tool call."),
      "the structured_output requirement survives the continuation path",
    );
    assert.ok(!prompt.includes(originalTask), "still not restating the full task prompt");
  }));
