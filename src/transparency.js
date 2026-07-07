/**
 * transparency.js — /why, /status, /verify formatters (roadmap #134).
 *
 * Pure leaf module (no DOM, no Roam API, no injected deps) so it can be
 * imported directly and unit-tested in isolation, mirroring plan-mode.js.
 *
 * Responsibilities:
 *   - Hold the single last-ask metadata slot (what kind of run produced the
 *     most recent response, which tier and why, the prompt/response pair for
 *     on-demand verification).
 *   - Format the /why report from that metadata + the agent run trace.
 *   - Format the /status report from a state snapshot assembled in index.js.
 *   - Format the /verify report from an eval-judge result.
 *
 * All three commands are read-only: they render existing state and never
 * mutate anything.
 */

// ── Last-ask metadata (single slot) ─────────────────────────────────────────

let lastAskMeta = null;

/**
 * Record how the most recent response was produced. Two shapes:
 *   { kind: "deterministic", at, promptPreview }
 *   { kind: "agent", at, promptPreview, responseText, tier, baseTier,
 *     flags: { power, ludicrous, plan, approvedPlan, providerOverride },
 *     escalation: { mcpRouted, routingReason, intentEscalated } }
 */
export function setLastAskMeta(meta) {
  lastAskMeta = meta && typeof meta === "object" ? { at: Date.now(), ...meta } : null;
}

export function getLastAskMeta() {
  return lastAskMeta;
}

export function clearLastAskMeta() {
  lastAskMeta = null;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function formatRelativeTime(timestampMs, now = Date.now()) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "never";
  const deltaMs = now - timestampMs;
  if (deltaMs < 0) {
    // Future timestamp (e.g. a scheduled run)
    const ahead = -deltaMs;
    if (ahead < 60_000) return "in under a minute";
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)}m`;
    if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)}h`;
    return `in ${Math.round(ahead / 86_400_000)}d`;
  }
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.round(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
  return `${Math.round(deltaMs / 86_400_000)}d ago`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUsd(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? (usd * 100).toFixed(2) + "¢" : "$" + usd.toFixed(2);
}

// ── /why ─────────────────────────────────────────────────────────────────────

const GUARD_DESCRIPTIONS = {
  gathering: "gathering-completeness guard (a required data source hadn't been read yet)",
  claimedAction: "claimed-action guard (the model said it did something without calling a tool — retried)",
  fabrication: "MCP fabrication guard (long answer with no tool calls in an MCP session — retried)",
  toolErrorNudge: "tool-error nudge (an external tool failed — retried with guidance)",
  liveData: "live-data guard (answer needed fresh tool data that hadn't been fetched — retried)",
  deferralNudge: "deferral nudge (the model deferred after successful tool calls — retried)",
};

/** Human explanation for why the run landed on its tier. */
export function describeTierReason(meta) {
  if (!meta || meta.kind !== "agent") return "";
  const flags = meta.flags || {};
  const esc = meta.escalation || {};
  if (flags.providerOverride) return `You forced the ${flags.providerOverride} provider for this message.`;
  if (flags.ludicrous) return "You asked for the strongest model (/ludicrous).";
  if (flags.power) return "You asked for a stronger model (/power).";
  if (flags.plan || flags.approvedPlan) return "Plan mode always uses at least the power tier — multi-step planning is unreliable on mini.";
  if (meta.tier !== meta.baseTier) {
    if (esc.routingReason) return `Auto-escalated from mini: ${esc.routingReason}`;
    if (esc.mcpRouted) return "Auto-escalated from mini: your message mentioned an MCP server that uses two-stage routing, which mini-tier models handle poorly.";
    if (esc.intentEscalated) return "Auto-escalated from mini: the intent classifier estimated this needs many tool calls.";
    return "Auto-escalated from mini based on request complexity.";
  }
  return "Default mini tier — the request looked routine (fast and cheap).";
}

/**
 * Build the /why report. `meta` is the last-ask metadata; `trace` is the
 * agent-loop run trace (may be stale or null — e.g. after a Roam reload or
 * when the last answer was deterministic).
 */
export function buildWhyReport(meta, trace) {
  if (!meta && !trace) {
    return "I haven't answered anything in this session yet — ask me something first, then `/why` will explain how I handled it.";
  }

  if (meta?.kind === "deterministic") {
    return [
      `Here's how I handled: **"${meta.promptPreview}"**`,
      "",
      "**Instant answer — no model call.** Your message matched one of my built-in patterns (task queries, memory saves, navigation, tool lists, and similar), so I answered directly from your graph. No tokens were used and nothing left your browser.",
    ].join("\n");
  }

  // Agent run: prefer meta (has tier reasoning), fall back to trace alone.
  const lines = [];
  const promptPreview = meta?.promptPreview || trace?.promptPreview || "";
  lines.push(`Here's how I handled: **"${promptPreview}"**`);
  lines.push("");

  const model = trace?.model || "unknown model";
  const provider = trace?.provider || "unknown provider";
  const tierLabel = meta?.tier ? ` at **${meta.tier}** tier` : "";
  lines.push(`**Model:** ${model} (${provider})${tierLabel}`);
  const tierReason = describeTierReason(meta);
  if (tierReason) lines.push(`**Why this tier:** ${tierReason}`);

  if (trace) {
    const toolCalls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
    const durationMs = trace.finishedAt && trace.startedAt ? trace.finishedAt - trace.startedAt : null;
    lines.push(`**Work:** ${trace.iterations || 0} iteration${(trace.iterations || 0) === 1 ? "" : "s"}, ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}${durationMs != null ? `, ${formatDurationMs(durationMs)}` : ""}`);
    if (toolCalls.length) {
      const shown = toolCalls.slice(0, 15);
      for (const call of shown) {
        const status = call.error ? ` — failed: ${String(call.error).slice(0, 80)}` : "";
        const dur = Number.isFinite(call.durationMs) ? ` (${formatDurationMs(call.durationMs)})` : "";
        lines.push(`- \`${call.name}\`${dur}${status}`);
      }
      if (toolCalls.length > shown.length) lines.push(`- …and ${toolCalls.length - shown.length} more`);
    }

    const guards = Array.isArray(trace.guardsFired) ? trace.guardsFired : [];
    if (guards.length) {
      lines.push("");
      lines.push("**Guards fired:**");
      for (const g of [...new Set(guards)]) {
        lines.push(`- ${GUARD_DESCRIPTIONS[g] || g}`);
      }
    }

    const context = trace.priorContextTurns;
    if (Number.isFinite(context)) {
      lines.push("");
      lines.push(`**Context:** ${context === 0 ? "fresh conversation (no prior turns)" : `${context} prior conversation turn${context === 1 ? "" : "s"}`}`);
    }
    const breakdown = trace.inputBreakdown;
    if (breakdown?.estInputTokens) {
      lines.push(`**Input size:** ~${breakdown.estInputTokens.toLocaleString()} tokens (${breakdown.toolPct || 0}% tool definitions, ${breakdown.toolCount || 0} tools offered)`);
    }
    if (trace.error) {
      lines.push("");
      lines.push(`**Error:** ${String(trace.error).slice(0, 200)}`);
    }
  }

  return lines.join("\n");
}

// ── /status ──────────────────────────────────────────────────────────────────

function describeCronSchedule(job, now) {
  if (job.type === "interval") return `every ${job.intervalMinutes}m`;
  if (job.type === "once" || job.type === "reminder") {
    return job.runAt ? `once, ${formatRelativeTime(job.runAt, now)}` : "once";
  }
  return `\`${job.expression}\``;
}

/**
 * Build the /status report from a snapshot assembled by index.js:
 * { now, provider, session, cronJobs, idle, pendingPlan, undoBatch,
 *   composio: { connected, installedCount, pendingCount },
 *   localMcp: [{ name, tools }], remoteMcp: [{ name, tools }] }
 */
export function buildStatusReport(snapshot) {
  const s = snapshot || {};
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  const lines = ["**Current status**", ""];

  // Connections
  lines.push("**Connections**");
  const composio = s.composio || {};
  if (composio.connected) {
    lines.push(`- Composio: connected (${composio.installedCount || 0} tool${(composio.installedCount || 0) === 1 ? "" : "s"} installed${composio.pendingCount ? `, ${composio.pendingCount} pending auth` : ""})`);
  } else {
    lines.push("- Composio: not connected");
  }
  const localMcp = Array.isArray(s.localMcp) ? s.localMcp : [];
  const remoteMcp = Array.isArray(s.remoteMcp) ? s.remoteMcp : [];
  if (localMcp.length) {
    for (const server of localMcp) lines.push(`- Local MCP: ${server.name} (${server.tools} tools)`);
  } else {
    lines.push("- Local MCP: none connected");
  }
  if (remoteMcp.length) {
    for (const server of remoteMcp) lines.push(`- Remote MCP: ${server.name} (${server.tools} tools)`);
  } else {
    lines.push("- Remote MCP: none connected");
  }

  // Scheduled jobs
  lines.push("");
  lines.push("**Scheduled jobs**");
  const jobs = Array.isArray(s.cronJobs) ? s.cronJobs : [];
  const enabled = jobs.filter((j) => j.enabled !== false);
  const disabledCount = jobs.length - enabled.length;
  if (!enabled.length) {
    lines.push(disabledCount ? `- None active (${disabledCount} disabled)` : "- None");
  } else {
    for (const job of enabled) {
      const lastRun = job.lastRun ? `last ran ${formatRelativeTime(job.lastRun, now)}` : "never run";
      const errorNote = job.lastRunError ? ` ⚠️ last run failed: ${job.lastRunError.slice(0, 60)}` : "";
      lines.push(`- ${job.name} — ${describeCronSchedule(job, now)}, ${lastRun}${errorNote}`);
    }
    if (disabledCount) lines.push(`- (${disabledCount} more disabled)`);
  }

  // Background (idle) tasks
  lines.push("");
  lines.push("**Background tasks**");
  const idle = s.idle || {};
  if (!idle.running) {
    lines.push("- Idle scheduler not running (no background features enabled)");
  } else {
    const tasks = Array.isArray(idle.registeredTasks) ? idle.registeredTasks : [];
    const role = idle.isCoordinator ? "this tab coordinates" : "another tab coordinates";
    lines.push(`- Idle scheduler active (${role}): ${tasks.length ? tasks.join(", ") : "no tasks registered"}`);
    if (idle.activeTaskId) lines.push(`- Currently running: ${idle.activeTaskId}`);
  }

  // Pending plan / undoable batch
  lines.push("");
  lines.push("**Pending**");
  if (s.pendingPlan) {
    lines.push(`- Plan awaiting approval: "${String(s.pendingPlan.originalPrompt || "").slice(0, 80)}" (${formatRelativeTime(s.pendingPlan.createdAt, now)}) — Run plan or type \`go\``);
  } else {
    lines.push("- No plan awaiting approval");
  }
  if (s.undoBatch) {
    const creates = s.undoBatch.creates?.length || 0;
    const updates = s.undoBatch.updates?.length || 0;
    lines.push(`- Undoable: my last run ("${String(s.undoBatch.prompt || "").slice(0, 60)}") — ${creates} created, ${updates} edited. \`/undo\` to review.`);
  } else {
    lines.push("- Nothing to undo");
  }

  // Session cost
  const session = s.session || {};
  lines.push("");
  lines.push(`**This session:** ${session.totalRequests || 0} request${(session.totalRequests || 0) === 1 ? "" : "s"}, ${((session.totalInputTokens || 0) + (session.totalOutputTokens || 0)).toLocaleString()} tokens, ${formatUsd(session.totalCostUsd)}`);

  return lines.join("\n");
}

// ── /verify ──────────────────────────────────────────────────────────────────

const VERIFY_DIMENSION_LABELS = {
  task_completion: "Task completion",
  factual_grounding: "Factual grounding",
  safety: "Safety",
};

function scoreBadge(score) {
  if (!Number.isFinite(score)) return "?";
  return `${score}/5${score <= 2 ? " ⚠️" : ""}`;
}

/**
 * Build the /verify report from an evaluateAgentRun result
 * ({ scores, concern, queued } | null).
 */
export function buildVerifyReport(evalResult) {
  if (!evalResult || !evalResult.scores) {
    return "I couldn't score the last response — the evaluation call failed or no judge provider is available. Check that at least one API key is configured.";
  }
  const { scores, queued } = evalResult;
  const lines = ["**Verification of my last response** (scored by an independent judge model)", ""];
  for (const [key, label] of Object.entries(VERIFY_DIMENSION_LABELS)) {
    if (Number.isFinite(scores[key])) lines.push(`- ${label}: ${scoreBadge(scores[key])}`);
  }
  const checks = Array.isArray(scores.checks) ? scores.checks : [];
  if (checks.length) {
    lines.push("");
    lines.push("**Checks:**");
    for (const check of checks) {
      lines.push(`- ${check.pass ? "✅" : "❌"} ${check.id}${!check.pass && check.reason ? ` — ${check.reason}` : ""}`);
    }
  }
  if (scores.concern) {
    lines.push("");
    lines.push(`**Judge's concern:** ${scores.concern}`);
  }
  if (queued) {
    lines.push("");
    lines.push("This run was added to `[[Chief of Staff/Review Queue]]` for your review.");
  }
  return lines.join("\n");
}
