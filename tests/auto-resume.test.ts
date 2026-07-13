// T1.2 coverage: the reset-hint parser and the manager's auto-resume machinery.
//
// parseResetHintMs is a pure table. The manager tests drive a real usage-limit
// pause through an injected agent runner and observe real resume invocation,
// attempt-count progression, exhaustion, manual reset, and timer cancellation.
// The manager's cooldown is a setTimeout; we fake it with node:test mock.timers
// and advance it deterministically, awaiting the real events the run emits — no
// wall-clock sleeps, so nothing races on a loaded machine.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { AUTO_RESUME_MAX_ATTEMPTS } from "../src/config.js";
import { parseResetHintMs, WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// Advance far past any pending auto-resume timer; the exact backoff (±20% jitter)
// is irrelevant because we only need the single pending timer to fire.
const TICK_MS = 60_000;

/** A manager test with an isolated cwd + HOME and deterministic (faked) timers. */
function managerTest(name: string, fn: (cwd: string) => Promise<void>) {
  test(name, { timeout: 10_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ar-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      mock.timers.reset();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
}

/**
 * Agent runner that reports a provider usage limit for its first `throwTimes`
 * calls, then succeeds. Exposes a live call counter so tests can prove the agent
 * was actually re-invoked (not merely that a resume method exists).
 */
function limitAgent(opts: { throwTimes: number; resetHint?: string; result?: unknown }) {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(_prompt: string, _options: { onUsage?: (u: AgentUsage) => void }): Promise<unknown> {
        state.calls++;
        if (state.calls <= opts.throwTimes) {
          throw new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: opts.resetHint,
          });
        }
        return opts.result ?? "ok";
      },
    },
  };
}

const oneAgentScript = `export const meta = { name: 'auto_resume_demo', description: 'one agent' }
const a = await agent('do it', { label: 'a' })
return { a }`;

// ─── parseResetHintMs ────────────────────────────────────────────────────────

test("parseResetHintMs converts relative reset hints to ms and rejects unparseable forms", () => {
  const cases: Array<[string | undefined, number | undefined]> = [
    ["Resets in ~3h", 10_800_000],
    ["resets in 45m", 2_700_000],
    ["resets in 90 seconds", 90_000],
    ["resets in 2 hours", 7_200_000],
    // Unparseable: no number+unit, empty, or an absolute clock the backoff must cover.
    [undefined, undefined],
    ["", undefined],
    ["soon", undefined],
    ["resets at 3pm", undefined],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseResetHintMs(input), expected, `parseResetHintMs(${JSON.stringify(input)})`);
  }
});

// ─── Auto-resume: recovery, boundedness, reset, cancellation ─────────────────

managerTest("a usage-limit pause auto-resumes after cooldown and completes once the limit clears", async (cwd) => {
  // Over quota for the first two runs, recovers on the third.
  const agent = limitAgent({ throwTimes: 2, result: "recovered" });
  const manager = new WorkflowManager({ cwd, agent: agent.runner, autoResume: { baseMs: 5, maxMs: 20 } });
  manager.on("error", () => {}); // usage-limit uses "paused"; guard against a stray 'error' throw

  const resumed: string[] = [];
  manager.on("resumed", (e: { runId: string }) => resumed.push(e.runId));
  const scheduled: number[] = [];
  manager.on("autoResumeScheduled", (e: { attempt: number }) => scheduled.push(e.attempt));

  const { runId, promise } = manager.startInBackground(oneAgentScript);
  await promise.catch(() => {}); // initial run rejects with PROVIDER_USAGE_LIMIT (pause #1, timer #1 armed)

  // Fire the first cooldown -> auto-resume #1 -> the run re-pauses (still over quota).
  const paused2 = once(manager, "paused");
  mock.timers.tick(TICK_MS);
  await paused2;

  // Fire the second cooldown -> auto-resume #2 -> the agent now succeeds -> completion.
  const completed = once(manager, "complete");
  mock.timers.tick(TICK_MS);
  await completed;

  const run = manager.getRun(runId);
  assert.equal(run?.status, "completed", "run completes after the limit clears");
  assert.equal(run?.result?.result?.a, "recovered", "the agent's real result flows through on resume");
  assert.equal(agent.state.calls, 3, "the agent was re-invoked twice by auto-resume, then succeeded");
  assert.equal(resumed.length, 2, "exactly two auto-resumes fired");
  assert.deepEqual(scheduled, [1, 2], "each pause scheduled the next attempt with an increasing attempt number");
});

managerTest(
  "auto-resume increments resumeAttempts and stops after AUTO_RESUME_MAX_ATTEMPTS, emitting autoResumeExhausted",
  async (cwd) => {
    const agent = limitAgent({ throwTimes: Number.POSITIVE_INFINITY }); // provider never refills
    const manager = new WorkflowManager({ cwd, agent: agent.runner, autoResume: { baseMs: 5, maxMs: 20 } });
    manager.on("error", () => {});

    let resumeCount = 0;
    manager.on("resumed", () => resumeCount++);
    const scheduledAttempts: number[] = [];
    manager.on("autoResumeScheduled", (e: { attempt: number }) => scheduledAttempts.push(e.attempt));

    const exhausted = once(manager, "autoResumeExhausted");
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise.catch(() => {}); // pause #1, first cooldown armed

    // Each tick fires exactly one pending cooldown -> one auto-resume -> one re-pause.
    for (let i = 0; i < AUTO_RESUME_MAX_ATTEMPTS; i++) {
      const paused = once(manager, "paused");
      mock.timers.tick(TICK_MS);
      await paused;
    }
    const [payload] = (await exhausted) as [{ runId: string }];
    assert.equal(payload.runId, runId, "exhaustion is reported for this run");

    const run = manager.getRun(runId);
    assert.equal(run?.status, "paused", "run stays paused after the auto-resume budget is spent");
    assert.equal(run?.resumeAttempts, AUTO_RESUME_MAX_ATTEMPTS, "attempts stop exactly at the configured maximum");
    assert.equal(resumeCount, AUTO_RESUME_MAX_ATTEMPTS, "exactly maxAttempts auto-resumes fired, no more");
    assert.deepEqual(
      scheduledAttempts,
      Array.from({ length: AUTO_RESUME_MAX_ATTEMPTS }, (_, i) => i + 1),
      "each pause scheduled the next attempt: 1..maxAttempts",
    );
    assert.equal(
      agent.state.calls,
      AUTO_RESUME_MAX_ATTEMPTS + 1,
      "the agent ran once initially plus once per auto-resume, then stopped",
    );

    // Advancing further must not resurrect the exhausted run.
    mock.timers.tick(TICK_MS);
    assert.equal(resumeCount, AUTO_RESUME_MAX_ATTEMPTS, "no auto-resume fires past exhaustion");
  },
);

managerTest("a manual resume resets resumeAttempts to 0, refreshing the auto-resume budget", async (cwd) => {
  const agent = limitAgent({ throwTimes: 0, result: "manual-ok" }); // succeeds on resume
  const manager = new WorkflowManager({ cwd, agent: agent.runner, autoResume: { baseMs: 5, maxMs: 20 } });
  manager.on("error", () => {});

  const runId = "manual-reset-run";
  // Cold-persist a usage-limit-paused run that already burned 3 auto-resume attempts.
  manager.getPersistence().save({
    runId,
    workflowName: "manual_reset",
    script: oneAgentScript,
    args: undefined,
    status: "paused",
    pauseReason: "usage_limit",
    resetHint: "Resets in ~3h",
    resumeAttempts: 3,
    phases: [],
    agents: [],
    logs: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(manager.getPersistence().load(runId)?.resumeAttempts, 3, "setup: the paused run had burned 3 attempts");

  const completed = once(manager, "complete");
  const ok = await manager.resume(runId); // manual: no { auto: true }
  assert.equal(ok, true, "manual resume of a persisted paused run succeeds");
  assert.equal(manager.getRun(runId)?.resumeAttempts, 0, "manual resume zeroes the burned attempt count");

  await completed;
  assert.equal(manager.getRun(runId)?.status, "completed", "the resumed run runs to completion");
  const persisted = manager.listRuns().find((r) => r.runId === runId);
  assert.equal(persisted?.resumeAttempts, 0, "the reset count is persisted");
});

managerTest("deleteRun cancels a pending auto-resume timer so no resume fires afterward", async (cwd) => {
  // "resets in 1s" makes the provider reset hint govern the cooldown (~1000ms).
  const agent = limitAgent({ throwTimes: Number.POSITIVE_INFINITY, resetHint: "resets in 1s" });
  const manager = new WorkflowManager({ cwd, agent: agent.runner, autoResume: { baseMs: 5, maxMs: 20 } });
  manager.on("error", () => {});
  let resumeCount = 0;
  manager.on("resumed", () => resumeCount++);

  const scheduledP = once(manager, "autoResumeScheduled");
  const { runId, promise } = manager.startInBackground(oneAgentScript);
  await promise.catch(() => {});

  const [sched] = (await scheduledP) as [{ delay: number }];
  // The reset hint (~1s), not the tiny backoff, drives the cooldown delay (±20% jitter).
  assert.ok(sched.delay >= 800 && sched.delay <= 1200, `resetHint should drive a ~1s cooldown, got ${sched.delay}`);

  assert.equal(manager.deleteRun(runId), true, "deleteRun succeeds on the paused run");
  const callsAtDelete = agent.state.calls;

  // Advance past the cancelled cooldown: nothing may fire.
  mock.timers.tick(TICK_MS);
  assert.equal(resumeCount, 0, "no auto-resume fired after deleteRun cancelled the timer");
  assert.equal(agent.state.calls, callsAtDelete, "the agent was not re-invoked");
  assert.equal(manager.getRun(runId), undefined, "the run is gone");
});

managerTest("stop cancels a pending auto-resume timer so a paused run is not auto-resumed", async (cwd) => {
  const agent = limitAgent({ throwTimes: Number.POSITIVE_INFINITY, resetHint: "resets in 1s" });
  const manager = new WorkflowManager({ cwd, agent: agent.runner, autoResume: { baseMs: 5, maxMs: 20 } });
  manager.on("error", () => {});
  let resumeCount = 0;
  manager.on("resumed", () => resumeCount++);

  const scheduledP = once(manager, "autoResumeScheduled");
  const { runId, promise } = manager.startInBackground(oneAgentScript);
  await promise.catch(() => {});
  await scheduledP; // a cooldown timer is now pending

  assert.equal(manager.stop(runId), true, "stop transitions the paused run to aborted");
  assert.equal(manager.getRun(runId)?.status, "aborted", "the run is aborted");
  const callsAtStop = agent.state.calls;

  // Advance past the cancelled cooldown: an aborted run must not be auto-resumed.
  mock.timers.tick(TICK_MS);
  assert.equal(resumeCount, 0, "no auto-resume fired after stop cancelled the timer");
  assert.equal(agent.state.calls, callsAtStop, "the agent was not re-invoked");
});
