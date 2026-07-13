/**
 * Standing `/effort` opt-in (pi's answer to CC's ultracode): a session toggle that
 * auto-arms a workflow for substantive interactive messages, with effort-tier
 * guidance nudging fan-out breadth (reviewers/judges, verify()/judgePanel(),
 * loopUntilDry / completenessCheck, big-tier synthesis).
 *
 * Honest scope: the runtime cannot enforce "reviewer N / loop K" — those live in
 * the script the model writes — so the tiers are guidance only. The pre-flight
 * ceiling-confirm dialog (roadmap P1-5 #4) is a downscope point: an `input` hook
 * transforms synchronously and can't await a confirm, so it is left to a
 * follow-up; `/effort` is explicit opt-in, which is the safety valve.
 *
 * HIGH_DIRECTIVE / ULTRA_DIRECTIVE are the embedded default directive strings;
 * users can override them via ~/.pi/workflows/prompts.json (see loadEffortPrompts).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { EFFORT_PROMPTS_FILE } from "./config.js";

export type EffortLevel = "off" | "high" | "ultra";

export interface EffortState {
  level: EffortLevel;
}

export function createEffortState(): EffortState {
  return { level: "off" };
}

export const HIGH_DIRECTIVE =
  "Effort: HIGH. Be thorough — use a few parallel reviewers/perspectives and an adversarial verify pass (see verify()/judgePanel()).";
export const ULTRA_DIRECTIVE =
  "Effort: ULTRA. Be exhaustive — fan out widely (more reviewers/judges, deeper loopUntilDry rounds, a completenessCheck at the end), and prefer the big tier for synthesis.";

export interface EffortPrompts {
  high?: string;
  ultra?: string;
}

/** Path to the effort directive prompts config file (~/.pi/workflows/prompts.json). */
export function getEffortPromptsPath(): string {
  return join(homedir(), EFFORT_PROMPTS_FILE);
}

/**
 * Load user-customized effort directives. Missing, corrupt, or invalid files
 * resolve to {} so callers fall back to HIGH_DIRECTIVE / ULTRA_DIRECTIVE.
 * Only non-empty string entries for "high"/"ultra" are honored.
 */
export function loadEffortPrompts(promptsPath?: string): EffortPrompts {
  const path = promptsPath ?? getEffortPromptsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: EffortPrompts = {};
    if (typeof parsed.high === "string" && parsed.high.trim()) out.high = parsed.high;
    if (typeof parsed.ultra === "string" && parsed.ultra.trim()) out.ultra = parsed.ultra;
    return out;
  } catch {
    return {};
  }
}

/** The extra directive appended to the forced-workflow prompt for an effort level. */
export function effortDirective(level: EffortLevel, promptsPath?: string): string | undefined {
  if (level === "off") return undefined;
  const custom = loadEffortPrompts(promptsPath);
  if (level === "high") return custom.high ?? HIGH_DIRECTIVE;
  return custom.ultra ?? ULTRA_DIRECTIVE;
}

/**
 * Whether a message should auto-arm under effort mode: a real interactive request,
 * not a terse acknowledgement or a slash command. (hasTrigger handles the explicit
 * "workflow(s)" keyword separately.)
 */
export function isSubstantive(text: string): boolean {
  const t = text.trim();
  return t.length >= 16 && !t.startsWith("/");
}

export function registerEffortCommand(pi: ExtensionAPI, state: EffortState): void {
  pi.registerCommand("effort", {
    description: "Standing workflow effort: off | high | ultra — auto-arms a workflow for substantive messages",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off" || arg === "high" || arg === "ultra") {
        state.level = arg;
        await say(
          arg === "off"
            ? "Effort off — messages are no longer auto-armed as workflows."
            : `Effort ${arg} — substantive messages now auto-arm a workflow (${arg === "ultra" ? "exhaustive" : "thorough"} fan-out). Use /effort off to stop.`,
        );
        return;
      }
      await say(`Effort is currently "${state.level}". Usage: /effort off | high | ultra`);
    },
  });

  // `/ultracode` — the headline name for the maximal-effort mode (Pi's ultracode):
  // `/ultracode` turns it on, `/ultracode off` turns it off. Alias for /effort ultra.
  pi.registerCommand("ultracode", {
    description:
      "Ultracode: standing maximal-effort mode (this session only, never persisted) — auto-arms an exhaustive workflow for substantive messages. /ultracode off to stop.",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off") {
        state.level = "off";
        await say("Ultracode off — messages are no longer auto-armed as workflows.");
        return;
      }
      state.level = "ultra";
      await say(
        "Ultracode ON — substantive messages now auto-arm an exhaustive workflow (wide fan-out, big-tier synthesis). Use /ultracode off to stop.",
      );
    },
  });
}
