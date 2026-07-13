import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEffortState,
  effortDirective,
  HIGH_DIRECTIVE,
  isSubstantive,
  loadEffortPrompts,
  registerEffortCommand,
  ULTRA_DIRECTIVE,
} from "../src/effort-command.js";
import { buildForcedWorkflowPrompt } from "../src/workflow-editor.js";

test("effortDirective returns a tier nudge for high/ultra, nothing for off", () => {
  assert.equal(effortDirective("off"), undefined);
  assert.match(effortDirective("high") ?? "", /HIGH/);
  assert.match(effortDirective("ultra") ?? "", /ULTRA/);
  assert.doesNotMatch(effortDirective("high") ?? "", /tokenBudget|maxAgents/i);
  assert.doesNotMatch(effortDirective("ultra") ?? "", /tokenBudget|maxAgents/i);
});

test("isSubstantive accepts real requests, rejects terse text and slash commands", () => {
  assert.equal(isSubstantive("audit the auth module for race conditions"), true);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("/workflows"), false);
  assert.equal(isSubstantive("    "), false);
});

test("buildForcedWorkflowPrompt appends the extra directive only when provided", () => {
  const base = buildForcedWorkflowPrompt("do X");
  assert.ok(!/ULTRA/.test(base), "no directive by default");
  assert.ok(base.startsWith("do X"));
  const ultra = buildForcedWorkflowPrompt("do X", effortDirective("ultra"));
  assert.match(ultra, /ULTRA/, "ultra directive appended");
  assert.ok(ultra.startsWith("do X"));
});

type CmdDef = { handler: (a: string, c: unknown) => Promise<void> };

function registerAndCapture(state: ReturnType<typeof createEffortState>) {
  const cmds = new Map<string, CmdDef>();
  const pi = {
    registerCommand: (name: string, d: unknown) => cmds.set(name, d as CmdDef),
    sendMessage: () => {},
  };
  registerEffortCommand(pi as never, state);
  return cmds;
}

test("registerEffortCommand: /effort toggles the shared state", async () => {
  const state = createEffortState();
  const effort = registerAndCapture(state).get("effort");
  assert.ok(effort, "/effort registered");
  assert.equal(state.level, "off");

  await effort?.handler("ultra", {});
  assert.equal(state.level, "ultra");
  await effort?.handler("high", {});
  assert.equal(state.level, "high");
  await effort?.handler("off", {});
  assert.equal(state.level, "off");
  await effort?.handler("bogus", {});
  assert.equal(state.level, "off", "unknown arg leaves the level unchanged");
});

test("registerEffortCommand: /ultracode turns ultra on, /ultracode off turns it off", async () => {
  const state = createEffortState();
  const ultracode = registerAndCapture(state).get("ultracode");
  assert.ok(ultracode, "/ultracode registered");

  await ultracode?.handler("", {});
  assert.equal(state.level, "ultra", "/ultracode (no arg) sets ultra");
  await ultracode?.handler("off", {});
  assert.equal(state.level, "off", "/ultracode off turns it off");
  await ultracode?.handler("anything", {});
  assert.equal(state.level, "ultra", "/ultracode <anything-but-off> sets ultra");
});

test("loadEffortPrompts returns {} for missing, corrupt, array, or non-object files", () => {
  const dir = mkdtempSync(join(tmpdir(), "effort-prompts-"));
  try {
    assert.deepEqual(loadEffortPrompts(join(dir, "nope.json")), {});

    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    assert.deepEqual(loadEffortPrompts(corrupt), {});

    const arr = join(dir, "array.json");
    writeFileSync(arr, "[]");
    assert.deepEqual(loadEffortPrompts(arr), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effortDirective honors prompts.json overrides and falls back per entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "effort-prompts-"));
  try {
    const both = join(dir, "both.json");
    writeFileSync(both, JSON.stringify({ high: "CUSTOM-HIGH", ultra: "CUSTOM-ULTRA" }));
    assert.equal(effortDirective("high", both), "CUSTOM-HIGH");
    assert.equal(effortDirective("ultra", both), "CUSTOM-ULTRA");

    const missing = join(dir, "missing.json");
    assert.equal(effortDirective("high", missing), HIGH_DIRECTIVE);
    assert.equal(effortDirective("ultra", missing), ULTRA_DIRECTIVE);

    const onlyHigh = join(dir, "only-high.json");
    writeFileSync(onlyHigh, JSON.stringify({ high: "ONLY-HIGH" }));
    assert.equal(effortDirective("high", onlyHigh), "ONLY-HIGH");
    assert.equal(effortDirective("ultra", onlyHigh), ULTRA_DIRECTIVE);

    const blankHigh = join(dir, "blank-high.json");
    writeFileSync(blankHigh, JSON.stringify({ high: "   ", ultra: "X" }));
    assert.equal(effortDirective("high", blankHigh), HIGH_DIRECTIVE);
    assert.equal(effortDirective("ultra", blankHigh), "X");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
