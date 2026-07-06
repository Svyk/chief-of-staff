/**
 * plan-mode.js — `/plan` command support (roadmap #128, Phase 1).
 *
 * Pure leaf module (no DOM, no Roam API, no injected deps) so it can be
 * imported directly and unit-tested in isolation, mirroring parse-utils.js.
 *
 * Responsibilities:
 *   - Detect and strip the `/plan` flag from a raw prompt.
 *   - Extract the `## Plan` structure from a read-only plan-pass response.
 *   - Hold the single pending plan in module state with a lazy 15-minute TTL
 *     and a monotonic id so stale UI buttons can detect supersession.
 */

// 15-minute TTL — matches the tool-approval TTL documented in tool-execution.js.
export const PENDING_PLAN_TTL_MS = 15 * 60 * 1000;

/**
 * System-prompt addendum for the read-only plan pass. Future tense only, so it
 * doesn't trip the claimed-action / hallucination guards (which match past-tense
 * action claims), and instructs the model to close with a parseable `## Plan`.
 */
export function buildPlanModeAddendum() {
  return `\n\nIMPORTANT: You are in PLAN MODE. You are running read-only: you can search, read, and gather information to ground your plan in the actual graph, but you CANNOT create, update, move, or delete anything, send emails, or perform any mutating action in this turn. Do NOT claim to have done anything — describe only what you WILL do. Finish your response with a section headed "## Plan" containing: (1) numbered steps, each naming the specific tool you will call; (2) a "Writes:" line listing every page or block you will create or modify (or "none"); (3) a "Mutations:" line with the total count of mutating tool calls. Be specific — the user will approve this plan verbatim before you execute it.`;
}

/**
 * System-prompt addendum for the execution pass. Empty string when no approved
 * plan is supplied, so it composes cleanly.
 */
export function buildExecutionAddendum(approvedPlan) {
  if (typeof approvedPlan !== "string" || !approvedPlan.trim()) return "";
  return `\n\nThe user has ALREADY approved the following plan via the approval UI. Do NOT ask for confirmation again and do NOT re-present the plan — begin executing it immediately using the appropriate tools. If reality diverges from the plan (a page is missing, a tool fails, the graph state is not what the plan assumed), stop and explain the divergence rather than improvising unlisted mutations.\n\n--- APPROVED PLAN ---\n${approvedPlan.trim()}\n--- END PLAN ---`;
}

let pendingPlan = null;      // { id, originalPrompt, planText, createdAt } | null
let planIdCounter = 0;

/**
 * True if the raw prompt carries a `/plan` flag (start, end, or surrounded by
 * whitespace). Does not match substrings like "/planning".
 */
export function detectPlanFlag(rawPrompt) {
  if (!rawPrompt || typeof rawPrompt !== "string") return false;
  return /(?:^|\s)\/plan(?:\s|$)/i.test(rawPrompt);
}

/**
 * Remove the `/plan` flag from a raw prompt, collapsing the surrounding
 * whitespace to a single space and trimming. Mirrors the flag-strip chain in
 * askChiefOfStaff.
 */
export function stripPlanFlag(rawPrompt) {
  if (!rawPrompt || typeof rawPrompt !== "string") return "";
  return rawPrompt.replace(/(?:^|\s)\/plan(?:\s|$)/i, " ").trim();
}

/**
 * Parse the `## Plan` section out of a plan-pass response.
 * Lenient by design: the presence of a `## Plan` (or `# Plan`) heading is the
 * only hard requirement. Sub-fields (steps, writes, mutations) are best-effort.
 *
 * @returns {{ planText, steps, writeTargets, mutationCount } | null}
 */
export function extractPlanStructure(responseText) {
  const text = String(responseText || "");
  // Find a "Plan" heading (## Plan / # Plan / ### Plan), case-insensitive.
  const headingMatch = text.match(/^#{1,4}\s+plan\b.*$/im);
  if (!headingMatch) return null;

  const headingIndex = text.indexOf(headingMatch[0]);
  const planText = text.slice(headingIndex).trim();
  if (!planText) return null;

  // Numbered steps: lines beginning with "1." / "2)" etc.
  const steps = [];
  const stepPattern = /^\s*(\d+)[.)]\s+(.*)$/gm;
  let m;
  while ((m = stepPattern.exec(planText)) !== null) {
    const step = m[2].trim();
    if (step) steps.push(step);
  }

  // Writes: line — comma / bracket separated page targets. The label may be
  // bolded either as `**Writes:**` (stars after the colon) or `Writes:`.
  let writeTargets = [];
  const writesMatch = planText.match(/^\s*(?:[-*]\s*)?\*{0,2}writes\*{0,2}\s*:\s*\*{0,2}\s*(.+?)\s*\*{0,2}$/im);
  if (writesMatch) {
    const raw = writesMatch[1].trim();
    if (!/^(none|n\/?a|-)$/i.test(raw)) {
      writeTargets = raw
        .split(/,|;/)
        .map((s) => s.trim().replace(/^\[\[|\]\]$/g, "").trim())
        .filter(Boolean);
    }
  }

  // Mutations: N — tolerate `**Mutations:**` bolding around the colon.
  let mutationCount = null;
  const mutMatch = planText.match(/^\s*(?:[-*]\s*)?\*{0,2}mutations\*{0,2}\s*:\s*\*{0,2}\s*(\d+)/im);
  if (mutMatch) mutationCount = Number(mutMatch[1]);

  return { planText, steps, writeTargets, mutationCount };
}

/**
 * Store a new pending plan, superseding any prior one. Stamps a monotonic id
 * and creation time. Returns the stored record (including its id).
 */
export function setPendingPlan({ originalPrompt, planText }, now = Date.now()) {
  planIdCounter += 1;
  pendingPlan = {
    id: planIdCounter,
    originalPrompt: String(originalPrompt || ""),
    planText: String(planText || ""),
    createdAt: Number.isFinite(now) ? now : Date.now(),
  };
  return pendingPlan;
}

/**
 * Return the current pending plan, or null if none is set or it has expired.
 * Expiry is checked lazily on read (no timers); an expired plan is cleared as
 * a side effect so callers never see stale state.
 */
export function getPendingPlan(now = Date.now()) {
  if (!pendingPlan) return null;
  const age = (Number.isFinite(now) ? now : Date.now()) - pendingPlan.createdAt;
  if (age >= PENDING_PLAN_TTL_MS) {
    pendingPlan = null;
    return null;
  }
  return pendingPlan;
}

/** Clear any pending plan. */
export function clearPendingPlan() {
  pendingPlan = null;
}
