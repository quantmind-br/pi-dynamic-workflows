/**
 * Per-stage model routing for workflows.
 * Allows different phases to use different models.
 */

export interface ModelRoute {
  /** Phase name pattern (regex or exact match). */
  phasePattern: string;
  /** Model to use for this phase. Optional so a phase can supply only a fallback chain. */
  model?: string;
  /** Whether to use regex matching. */
  useRegex?: boolean;
  /** Fallback model chain for this phase, tried on PROVIDER_USAGE_LIMIT. */
  fallbackModels?: string[];
}

export interface ModelRoutingConfig {
  /** Default model for all phases. */
  defaultModel?: string;
  /** Per-phase model overrides. */
  routes: ModelRoute[];
  /** Run-level default fallback chain when a phase route has none. */
  defaultFallbackModels?: string[];
}

/**
 * Resolve which model to use for a given phase.
 */
export function resolveModelForPhase(phase: string | undefined, config: ModelRoutingConfig): string | undefined {
  if (!phase || !config.routes.length) {
    return config.defaultModel;
  }

  for (const route of config.routes) {
    if (!route.model) continue; // fallback-only route; can't provide a model
    if (route.useRegex) {
      try {
        const regex = new RegExp(route.phasePattern, "i");
        if (regex.test(phase)) {
          return route.model;
        }
      } catch {
        // Invalid regex, skip
      }
    } else if (phase === route.phasePattern) {
      // Exact, case-sensitive match — phase titles are author-controlled literals,
      // so fuzzy substring matching only caused mis-routes (e.g. "analyze" matching
      // "analyze-deep" or vice-versa). Use the regex branch for fuzzy needs.
      return route.model;
    }
  }

  return config.defaultModel;
}

/**
 * Resolve the fallback model chain for a given phase, mirroring resolveModelForPhase.
 * Returns the matched route's fallbackModels, else the config default, else [].
 */
export function resolveFallbackModelsForPhase(phase: string | undefined, config: ModelRoutingConfig): string[] {
  if (phase && config.routes.length) {
    for (const route of config.routes) {
      if (!route.fallbackModels?.length) continue;
      if (route.useRegex) {
        try {
          if (new RegExp(route.phasePattern, "i").test(phase)) return route.fallbackModels;
        } catch {
          // Invalid regex, skip
        }
      } else if (phase === route.phasePattern) {
        return route.fallbackModels;
      }
    }
  }
  return config.defaultFallbackModels ?? [];
}

/**
 * Parse model routing from workflow meta: per-phase models from meta.phases[].model
 * and a top-level default from meta.model (used when no phase route matches).
 */
export function parseModelRoutingFromMeta(
  phases?: Array<{ title: string; model?: string; fallbackModels?: string[] }>,
  defaultModel?: string,
  defaultFallbackModels?: string[],
): ModelRoutingConfig {
  const routes: ModelRoute[] = [];

  if (phases) {
    for (const phase of phases) {
      // A route carries a phase's model and/or its fallback chain. Push when either
      // is present so a fallback-only phase still resolves its chain.
      if (phase.model || phase.fallbackModels?.length) {
        routes.push({
          phasePattern: phase.title,
          model: phase.model,
          fallbackModels: phase.fallbackModels,
        });
      }
    }
  }

  return { defaultModel, routes, defaultFallbackModels };
}
