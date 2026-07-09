import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBalancedJsonObjects,
  extractMcpKeyReference,
  buildChatTranscriptBlocks,
  looksLikeRoamUid,
  buildRoamTagString,
  stripConversationalPrefix,
  extractSkillTriggerPhrases,
  matchSkillByTriggerPhrase,
  estimateTokens,
  extractAuditableSkillLines,
  summariseSkillTokens,
} from "../src/parse-utils.js";

// ═════════════════════════════════════════════════════════════════════════════
// extractBalancedJsonObjects
// ═════════════════════════════════════════════════════════════════════════════

test("extractBalancedJsonObjects extracts a single JSON object", () => {
  const result = extractBalancedJsonObjects('{"query":"test"}');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { query: "test" });
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 16);
});

test("extractBalancedJsonObjects extracts multiple concatenated objects", () => {
  const input = '{"a":1}{"b":2}{"c":3}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0].parsed, { a: 1 });
  assert.deepEqual(result[1].parsed, { b: 2 });
  assert.deepEqual(result[2].parsed, { c: 3 });
});

test("extractBalancedJsonObjects handles trailing non-JSON text (Gemini bug)", () => {
  const input = '{"query":"test"} I will now search for that.';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { query: "test" });
});

test("extractBalancedJsonObjects handles leading non-JSON text", () => {
  const input = 'Here is the data: {"key":"value"}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { key: "value" });
});

test("extractBalancedJsonObjects handles nested objects", () => {
  const input = '{"outer":{"inner":"value"}}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { outer: { inner: "value" } });
});

test("extractBalancedJsonObjects handles escaped quotes in strings", () => {
  const input = '{"text":"He said \\"hello\\""}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].parsed.text, 'He said "hello"');
});

test("extractBalancedJsonObjects handles braces inside strings", () => {
  const input = '{"text":"{ not a real object }"}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { text: "{ not a real object }" });
});

test("extractBalancedJsonObjects returns empty for invalid input", () => {
  assert.deepEqual(extractBalancedJsonObjects(""), []);
  assert.deepEqual(extractBalancedJsonObjects(null), []);
  assert.deepEqual(extractBalancedJsonObjects("no json here"), []);
  assert.deepEqual(extractBalancedJsonObjects("{incomplete"), []);
});

test("extractBalancedJsonObjects skips malformed JSON with balanced braces", () => {
  // Balanced braces but invalid JSON
  const input = '{not: valid json}{"valid":"json"}';
  const result = extractBalancedJsonObjects(input);
  // First object is malformed, should be skipped; second should parse
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { valid: "json" });
});

// ═════════════════════════════════════════════════════════════════════════════
// extractMcpKeyReference
// ═════════════════════════════════════════════════════════════════════════════

test("extractMcpKeyReference extracts Name (Key: XYZ) patterns", () => {
  const texts = ["**My Library** (Key: ABC123)"];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("My Library → ABC123"));
  assert.ok(result.startsWith("[Key reference:"));
});

test("extractMcpKeyReference extracts multiple keys from one text block", () => {
  const texts = [
    "**Library A** (Key: AAA)\n**Library B** (Key: BBB)\n**Library C** (Key: CCC)"
  ];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Library A → AAA"));
  assert.ok(result.includes("Library B → BBB"));
  assert.ok(result.includes("Library C → CCC"));
});

test("extractMcpKeyReference extracts Title/Key patterns", () => {
  const texts = [
    "**Title:** Research Paper on AI\n**Item Key:** `XYZABC`"
  ];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Research Paper on AI → XYZABC"));
});

test("extractMcpKeyReference deduplicates entries", () => {
  const texts = [
    "**My Lib** (Key: AAA)",
    "**My Lib** (Key: AAA)", // duplicate
  ];
  const result = extractMcpKeyReference(texts);
  // Should only appear once
  const count = (result.match(/My Lib → AAA/g) || []).length;
  assert.equal(count, 1);
});

test("extractMcpKeyReference returns empty string when no matches", () => {
  assert.equal(extractMcpKeyReference(["no keys here"]), "");
  assert.equal(extractMcpKeyReference([]), "");
  assert.equal(extractMcpKeyReference(null), "");
});

test("extractMcpKeyReference caps at 50 entries", () => {
  const texts = [];
  for (let i = 0; i < 60; i++) {
    texts.push(`**Item${i}** (Key: KEY${i})`);
  }
  const result = extractMcpKeyReference(texts);
  // Count entries by semicolons + 1
  const entries = result.replace("[Key reference: ", "").replace("]", "").split("; ");
  assert.equal(entries.length, 50);
});

test("extractMcpKeyReference combines results from multiple text blocks", () => {
  const texts = [
    "**Lib A** (Key: AAA)",
    "**Lib B** (Key: BBB)",
  ];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Lib A → AAA"));
  assert.ok(result.includes("Lib B → BBB"));
});

test("extractMcpKeyReference skips null entries in the array", () => {
  const texts = [null, "**Valid** (Key: VLD)", undefined, ""];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Valid → VLD"));
});

// ═════════════════════════════════════════════════════════════════════════════
// buildChatTranscriptBlocks
// ═════════════════════════════════════════════════════════════════════════════

test("buildChatTranscriptBlocks maps user and assistant messages with labels", () => {
  const history = [
    { role: "user", text: "What did I work on last week?" },
    { role: "assistant", text: "You worked on the roadmap." },
  ];
  const result = buildChatTranscriptBlocks(history, { assistantName: "Jeeves" });
  assert.deepEqual(result, [
    "**User:** What did I work on last week?",
    "**Jeeves:** You worked on the roadmap.",
  ]);
});

test("buildChatTranscriptBlocks defaults assistant name to Chief of Staff", () => {
  const result = buildChatTranscriptBlocks([{ role: "assistant", text: "Hello" }]);
  assert.deepEqual(result, ["**Chief of Staff:** Hello"]);
});

test("buildChatTranscriptBlocks skips entries with no visible text", () => {
  const history = [
    { role: "user", text: "  " },
    { role: "user", text: "" },
    { role: "user" },
    null,
    { role: "assistant", text: "Real message" },
  ];
  const result = buildChatTranscriptBlocks(history);
  assert.equal(result.length, 1);
  assert.equal(result[0], "**Chief of Staff:** Real message");
});

test("buildChatTranscriptBlocks treats unknown roles as assistant", () => {
  const result = buildChatTranscriptBlocks([{ role: "system", text: "Note" }], { assistantName: "COS" });
  assert.deepEqual(result, ["**COS:** Note"]);
});

test("buildChatTranscriptBlocks handles non-array and empty input", () => {
  assert.deepEqual(buildChatTranscriptBlocks(null), []);
  assert.deepEqual(buildChatTranscriptBlocks(undefined), []);
  assert.deepEqual(buildChatTranscriptBlocks("not an array"), []);
  assert.deepEqual(buildChatTranscriptBlocks([]), []);
});

test("buildChatTranscriptBlocks falls back on blank assistant name", () => {
  const result = buildChatTranscriptBlocks([{ role: "assistant", text: "Hi" }], { assistantName: "   " });
  assert.deepEqual(result, ["**Chief of Staff:** Hi"]);
});

test("buildChatTranscriptBlocks trims message text", () => {
  const result = buildChatTranscriptBlocks([{ role: "user", text: "  padded  " }]);
  assert.deepEqual(result, ["**User:** padded"]);
});

// ═════════════════════════════════════════════════════════════════════════════
// looksLikeRoamUid
// ═════════════════════════════════════════════════════════════════════════════

test("looksLikeRoamUid recognises 9-char block UIDs", () => {
  assert.equal(looksLikeRoamUid("aHirk9S7g"), true);
  assert.equal(looksLikeRoamUid("CLVXEsLYw"), true);
  assert.equal(looksLikeRoamUid("_fM7pkQEa"), true);
  assert.equal(looksLikeRoamUid("abc-de_12"), true);
});

test("looksLikeRoamUid recognises DNP UIDs", () => {
  assert.equal(looksLikeRoamUid("07-06-2026"), true);
  assert.equal(looksLikeRoamUid("12-31-2025"), true);
});

test("looksLikeRoamUid rejects page titles", () => {
  assert.equal(looksLikeRoamUid("bbq shelter"), false);   // has a space
  assert.equal(looksLikeRoamUid("BBQ Shelter"), false);
  assert.equal(looksLikeRoamUid("Project"), false);        // too short
  assert.equal(looksLikeRoamUid("bbqShelter1"), false);    // 11 chars
  assert.equal(looksLikeRoamUid("[[Page]]"), false);       // bracketed ref
  assert.equal(looksLikeRoamUid(""), false);
  assert.equal(looksLikeRoamUid(null), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// buildRoamTagString
// ═════════════════════════════════════════════════════════════════════════════

test("buildRoamTagString renders a single-word tag as #Tag", () => {
  assert.equal(buildRoamTagString("Inbox"), "#Inbox");
});

test("buildRoamTagString renders a multi-word tag with brackets", () => {
  assert.equal(buildRoamTagString("Weekly Review"), "#[[Weekly Review]]");
});

test("buildRoamTagString comma-separates multiple tags", () => {
  assert.equal(buildRoamTagString("Inbox, Review"), "#Inbox #Review");
  assert.equal(buildRoamTagString("Inbox, Weekly Review"), "#Inbox #[[Weekly Review]]");
});

test("buildRoamTagString strips a leading # and [[ ]] the user typed", () => {
  assert.equal(buildRoamTagString("#Inbox"), "#Inbox");
  assert.equal(buildRoamTagString("[[Inbox]]"), "#Inbox");
  assert.equal(buildRoamTagString("[[Weekly Review]]"), "#[[Weekly Review]]");
});

test("buildRoamTagString dedupes case-insensitively, keeping first form", () => {
  assert.equal(buildRoamTagString("Inbox, inbox"), "#Inbox");
  assert.equal(buildRoamTagString("A, B, A"), "#A #B");
});

test("buildRoamTagString returns empty for blank / invalid input", () => {
  assert.equal(buildRoamTagString(""), "");
  assert.equal(buildRoamTagString("   "), "");
  assert.equal(buildRoamTagString(",, ,"), "");
  assert.equal(buildRoamTagString(null), "");
  assert.equal(buildRoamTagString(undefined), "");
});

test("buildRoamTagString drops stray brackets that would break the #[[ ]] form", () => {
  assert.equal(buildRoamTagString("Foo]]bar"), "#Foobar");
});

// ═════════════════════════════════════════════════════════════════════════════
// stripConversationalPrefix (#136b2)
// ═════════════════════════════════════════════════════════════════════════════

test("stripConversationalPrefix removes leading fillers with/without comma", () => {
  assert.equal(stripConversationalPrefix("no, run the X skill on Y"), "run the X skill on Y");
  assert.equal(stripConversationalPrefix("ok run the audit"), "run the audit");
  assert.equal(stripConversationalPrefix("actually, audit skill assumptions"), "audit skill assumptions");
  assert.equal(stripConversationalPrefix("yes please do the thing"), "do the thing");
});

test("stripConversationalPrefix peels stacked fillers", () => {
  assert.equal(stripConversationalPrefix("ok, no, run it"), "run it");
});

test("stripConversationalPrefix leaves real leading command words alone", () => {
  assert.equal(stripConversationalPrefix("search for tennis"), "search for tennis");
  assert.equal(stripConversationalPrefix("well-being report"), "well-being report");
  assert.equal(stripConversationalPrefix("run the skill"), "run the skill");
  assert.equal(stripConversationalPrefix("okra recipe"), "okra recipe"); // not "ok" + "ra"
});

test("stripConversationalPrefix handles blank input", () => {
  assert.equal(stripConversationalPrefix(""), "");
  assert.equal(stripConversationalPrefix(null), "");
});

// ═════════════════════════════════════════════════════════════════════════════
// extractSkillTriggerPhrases (#136a)
// ═════════════════════════════════════════════════════════════════════════════

const AUDIT_CONTENT = [
  "Description: audit a skill's guardrails.",
  'Triggers: "run the Skill Assumption Audit skill on [skill]", "skill assumption audit", "audit skill assumptions", "assumption audit for [skill]", "audit guardrails"',
  "Tier: power",
].join("\n");

test("extractSkillTriggerPhrases pulls quoted phrases, lowercased", () => {
  const phrases = extractSkillTriggerPhrases(AUDIT_CONTENT);
  assert.ok(phrases.includes("skill assumption audit"));
  assert.ok(phrases.includes("audit skill assumptions"));
  assert.ok(phrases.includes("audit guardrails"));
});

test("extractSkillTriggerPhrases strips [placeholder] and trailing connectors", () => {
  const phrases = extractSkillTriggerPhrases(AUDIT_CONTENT);
  // "assumption audit for [skill]" → "assumption audit" (placeholder + trailing "for" gone)
  assert.ok(phrases.includes("assumption audit"));
  assert.ok(!phrases.some(p => p.includes("[")));
  assert.ok(!phrases.some(p => /\bfor$/.test(p)));
});

test("extractSkillTriggerPhrases drops single-word phrases (hijack risk)", () => {
  const content = 'Triggers: "triage", "clean up today", "process"';
  const phrases = extractSkillTriggerPhrases(content);
  assert.ok(!phrases.includes("triage"));
  assert.ok(!phrases.includes("process"));
  assert.ok(phrases.includes("clean up today"));
});

test("extractSkillTriggerPhrases returns [] when no Triggers line", () => {
  assert.deepEqual(extractSkillTriggerPhrases("Description: no triggers here"), []);
  assert.deepEqual(extractSkillTriggerPhrases(""), []);
});

test("extractSkillTriggerPhrases handles a leading dash and em-dash separator", () => {
  const phrases = extractSkillTriggerPhrases('- Triggers — "weekly review", "week retro"');
  assert.ok(phrases.includes("weekly review"));
  assert.ok(phrases.includes("week retro"));
});

// ═════════════════════════════════════════════════════════════════════════════
// matchSkillByTriggerPhrase (#136a)
// ═════════════════════════════════════════════════════════════════════════════

const ENTRIES = [
  { title: "Skill Assumption Audit", content: AUDIT_CONTENT },
  { title: "Weekly Review", content: 'Triggers: "weekly review", "week in review"' },
  { title: "Catch Me Up", content: 'Triggers: "catch me up", "what changed"' },
];

test("matchSkillByTriggerPhrase matches a phrase prefix and extracts the target", () => {
  const r = matchSkillByTriggerPhrase("audit skill assumptions for Catch Me Up", ENTRIES);
  assert.equal(r.skillName, "Skill Assumption Audit");
  assert.equal(r.targetText, "Catch Me Up");
  assert.equal(r.originalPrompt, "audit skill assumptions for Catch Me Up");
});

test("matchSkillByTriggerPhrase strips connector and article from the target", () => {
  assert.equal(matchSkillByTriggerPhrase("audit skill assumptions on the Weekly Review", ENTRIES).targetText, "Weekly Review");
});

test("matchSkillByTriggerPhrase matches an exact full-message phrase with empty target", () => {
  const r = matchSkillByTriggerPhrase("weekly review", ENTRIES);
  assert.equal(r.skillName, "Weekly Review");
  assert.equal(r.targetText, "");
});

test("matchSkillByTriggerPhrase works through a conversational prefix", () => {
  const r = matchSkillByTriggerPhrase("no, audit skill assumptions for Catch Me Up", ENTRIES);
  assert.equal(r.skillName, "Skill Assumption Audit");
  assert.equal(r.targetText, "Catch Me Up");
});

test("matchSkillByTriggerPhrase prefers the longest matching phrase", () => {
  // "skill assumption audit" (22) vs "audit skill assumptions" (23) — message favors the longer
  const r = matchSkillByTriggerPhrase("skill assumption audit for Weekly Review", ENTRIES);
  assert.equal(r.skillName, "Skill Assumption Audit");
  assert.equal(r.targetText, "Weekly Review");
});

test("matchSkillByTriggerPhrase does NOT fire on incidental mid-sentence mentions", () => {
  // phrase must be at the start, not buried
  assert.equal(matchSkillByTriggerPhrase("remind me to do a weekly review tomorrow", ENTRIES), null);
});

test("matchSkillByTriggerPhrase returns null when nothing matches", () => {
  assert.equal(matchSkillByTriggerPhrase("search for tennis", ENTRIES), null);
  assert.equal(matchSkillByTriggerPhrase("", ENTRIES), null);
  assert.equal(matchSkillByTriggerPhrase("weekly review", null), null);
});

// ── Hijack guards: a trigger phrase must be the whole message, or be followed
//    by an explicit connector. General questions that merely *begin* with a
//    generic trigger phrase must fall through to the agent loop. (#136a hardening)

test("matchSkillByTriggerPhrase does NOT hijack a general question starting with a generic trigger", () => {
  // "what changed" is a real 2-word Catch Me Up trigger — but this is a question
  // about the Roam API, not a request to run the skill.
  assert.equal(matchSkillByTriggerPhrase("what changed in the Roam API this year?", ENTRIES), null);
  assert.equal(matchSkillByTriggerPhrase("what changed since Roam shipped semantic search", ENTRIES), null);
});

test("matchSkillByTriggerPhrase still matches phrase + explicit connector", () => {
  const r = matchSkillByTriggerPhrase("catch me up on the Roam API", ENTRIES);
  assert.equal(r.skillName, "Catch Me Up");
  assert.equal(r.targetText, "Roam API");
});

test("matchSkillByTriggerPhrase accepts a colon separator", () => {
  const r = matchSkillByTriggerPhrase("audit skill assumptions: Weekly Review", ENTRIES);
  assert.equal(r.skillName, "Skill Assumption Audit");
  assert.equal(r.targetText, "Weekly Review");
});

test("matchSkillByTriggerPhrase requires the phrase to end on a word boundary", () => {
  // "catch me upon the API" must not match the "catch me up" trigger
  assert.equal(matchSkillByTriggerPhrase("catch me upon the API", ENTRIES), null);
});

test("matchSkillByTriggerPhrase rejects a connector-lookalike word", () => {
  // "online"/"office" begin with on/of but aren't connectors
  assert.equal(matchSkillByTriggerPhrase("catch me up online tomorrow", ENTRIES), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// Skill token accounting (#119 deterministic counter)
// ═════════════════════════════════════════════════════════════════════════════

test("estimateTokens approximates 4 chars per token, min 1 for non-empty", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("   "), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a"), 1);           // min 1, never 0 for real text
  assert.equal(estimateTokens("x".repeat(100)), 25);
});

const SKILL_CHILDREN = [
  "- Description: audit a skill's guardrails.",
  '- Triggers: "audit skill assumptions", "audit guardrails"',
  "- Sources: cos_get_skill, roam_get_page",
  "- Tools: cos_get_skill, roam_get_page",
  "- Tier: power",
  "- Budget: $0.15",
  "- Iterations: 6",
  "- Models: +Anthropic",
  "- Never fabricate activity.",
  "  - Mark inferences with [INFERRED].",
].join("\n");

test("extractAuditableSkillLines excludes every structural field", () => {
  const lines = extractAuditableSkillLines(SKILL_CHILDREN);
  const texts = lines.map(l => l.text);
  for (const banned of ["Triggers", "Sources", "Tools", "Tier", "Budget", "Iterations", "Models"]) {
    assert.ok(!texts.some(t => t.startsWith(banned + ":")), `${banned} must not be auditable`);
  }
  assert.equal(lines.length, 3); // description + 2 guardrails
});

test("extractAuditableSkillLines strips bullets/indent and assigns stable 1-based ids", () => {
  const lines = extractAuditableSkillLines(SKILL_CHILDREN);
  assert.deepEqual(lines.map(l => l.id), [1, 2, 3]);
  assert.equal(lines[1].text, "Never fabricate activity.");
  assert.equal(lines[2].text, "Mark inferences with [INFERRED].");   // nested child, indent stripped
  assert.ok(lines.every(l => l.tokens > 0));
});

test("extractAuditableSkillLines handles em-dash structural separators and blank input", () => {
  assert.equal(extractAuditableSkillLines("- Tier — power\n- Real guardrail").length, 1);
  assert.deepEqual(extractAuditableSkillLines(""), []);
  assert.deepEqual(extractAuditableSkillLines(null), []);
});

test("summariseSkillTokens returns exact totals — the whole point of the tool", () => {
  const lines = [
    { id: 1, text: "a", tokens: 24 },
    { id: 2, text: "b", tokens: 24 },
    { id: 3, text: "c", tokens: 227 },
    { id: 4, text: "d", tokens: 342 },
  ];
  const s = summariseSkillTokens(lines, [1, 2]);
  assert.equal(s.total_tokens, 617);        // the real sum the model reported as 612
  assert.equal(s.removable_tokens, 48);
  assert.equal(s.percentage, 7.8);
  assert.equal(s.line_count, 4);
  assert.equal(s.removed_line_count, 2);
});

test("summariseSkillTokens handles no removals, unknown ids, and empty input", () => {
  const lines = [{ id: 1, text: "a", tokens: 10 }];
  assert.equal(summariseSkillTokens(lines, []).removable_tokens, 0);
  assert.equal(summariseSkillTokens(lines, []).percentage, 0);
  assert.equal(summariseSkillTokens(lines, [99]).removable_tokens, 0);  // unknown id contributes nothing
  const empty = summariseSkillTokens([], [1]);
  assert.equal(empty.total_tokens, 0);
  assert.equal(empty.percentage, 0);        // no divide-by-zero
  assert.equal(summariseSkillTokens(null, null).total_tokens, 0);
});

test("summariseSkillTokens coerces string ids and rounds percentage to 1dp", () => {
  const lines = [{ id: 1, text: "a", tokens: 1 }, { id: 2, text: "b", tokens: 2 }];
  assert.equal(summariseSkillTokens(lines, ["1"]).removable_tokens, 1);
  assert.equal(summariseSkillTokens(lines, [1]).percentage, 33.3);  // 1/3
});
