/**
 * Per-reviewer calibration profile. The scheduled `calibration-harvest`
 * workflow (see .github/workflows/calibration-harvest.yml) runs this engine
 * against merged/closed PRs across the org and publishes the resulting
 * `reviewer-profiles.json` to the rolling tag `reviewer-profiles-latest`.
 *
 * Design notes
 * ------------
 * - Per-bot accept-rate is derived from inline review threads, not from the
 *   artifact comment channel: the comment channel only carries `maxi-reviewer`
 *   findings; the other six bots (codacy-production, coderabbitai, qltysh,
 *   chatgpt-codex-connector, cubic-dev-ai, github-advanced-security) post
 *   inline comments on the diff and never emit a `maxi.review.v1.*` payload.
 *   So a single observation unit is one inline review comment posted on a PR
 *   by one of the seven bot authors during the harvest window.
 * - The classifier is side-effect-free. The GitHub-side harvesting
 *   (pulls, review threads, commits) is the workflow's job; this module only
 *   turns the harvested observations into aggregate stats.
 * - Path grouping is a routing signal, not a verdict on the bot. A low
 *   accept-rate on `python` says "route this reviewer less aggressively on
 *   python PRs," not "this reviewer is bad." The README carries that caveat.
 * - This module does NOT call calibration.ts's own correlation. That engine
 *   expects a `ReviewArtifact` and the list of `ThreadState`s the artifact
 *   generated, and is the right tool for maxi-reviewer's own artifacts. But
 *   the schema we publish here is reviewer-by-reviewer overall + by-path-group
 *   — not the per-rule / per-severity buckets calibration.ts produces — so
 *   importing it would be a wording mismatch: we re-use its outcome vocabulary
 *   (`accepted` / `dismissed` / `unaddressed`) and the same path-group
 *   bucketer, but compute the aggregate stats directly.
 */

export const BOT_REVIEWERS = [
  "codacy-production",
  "coderabbitai",
  "qltysh",
  "chatgpt-codex-connector",
  "cubic-dev-ai",
  "github-advanced-security",
  "maxi-reviewer",
] as const;

export type BotReviewer = (typeof BOT_REVIEWERS)[number];

export type ReviewOutcome = "accepted" | "dismissed" | "unaddressed";

export interface InlineReviewFinding {
  /** The bot's GitHub login. Must be one of BOT_REVIEWERS. */
  reviewer: BotReviewer;
  /** Repository the comment lives in (owner/name). */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** File path the comment was attached to (may be empty for repo-level). */
  path: string;
  /** Line number the comment was attached to (0 for file-level comments). */
  line: number;
  /** Whether the review thread is currently resolved. */
  threadResolved: boolean;
  /**
   * Files touched by commits that landed after this comment was posted. Used
   * to decide whether a still-open thread was effectively accepted by a later
   * edit.
   */
  subsequentTouchedPaths: string[];
}

export interface PathGroupStats {
  n: number;
  acceptRate: number;
}

export interface ReviewerStats {
  overall: PathGroupStats;
  byPathGroup: Record<string, PathGroupStats>;
}

export interface ReviewerProfiles {
  schema: "maxi.review.v1.reviewer-profiles";
  generatedAt: string;
  windowDays: number;
  reviewers: Record<BotReviewer, ReviewerStats>;
}

/**
 * Bucket a file path into a coarse group. The group names are the routing
 * vocabulary used by downstream selectors (maxi-reviewer issue #17 follow-up
 * work, the per-language review-intensity knob in `prompt.ts`). A path that
 * doesn't fit any named group falls into its top-level directory.
 *
 * The bucketing is intentionally coarse: a path group with N < 20 in a
 * 30-day window is too noisy to drive routing, and the README says so.
 */
export function pathGroupFor(path: string): string {
  if (!path) return "(unknown)";
  const normalised = path.startsWith("/") ? path.slice(1) : path;
  if (
    normalised.startsWith(".github/workflows/") ||
    normalised.startsWith(".github/workflow/")
  ) {
    return "workflows";
  }
  if (
    normalised === ".github/CODEOWNERS" ||
    normalised === ".github/dependabot.yml" ||
    normalised === ".github/labeler.yml" ||
    normalised === ".github/labeler.yaml" ||
    normalised.startsWith(".github/")
  ) {
    return "config";
  }
  if (
    normalised === "Cargo.lock" ||
    normalised === "package-lock.json" ||
    normalised === "pnpm-lock.yaml" ||
    normalised === "yarn.lock" ||
    normalised === "Cargo.toml" ||
    normalised.endsWith(".lock") ||
    normalised.endsWith(".lockfile")
  ) {
    return "lockfile";
  }
  const segments = normalised.split("/");
  const filename = segments[segments.length - 1] || "";
  const lang = filename.split(".").pop()?.toLowerCase();
  if (
    lang === "py" ||
    normalised.includes("/python/") ||
    normalised.includes("/py/")
  ) {
    return "python";
  }
  if (
    lang === "sh" ||
    lang === "bash" ||
    filename === "Makefile" ||
    filename === "justfile"
  ) {
    return "shell";
  }
  if (
    normalised.endsWith(".md") ||
    normalised.endsWith(".rst") ||
    normalised.endsWith(".txt") ||
    normalised === "LICENSE" ||
    normalised === "README"
  ) {
    return "docs";
  }
  if (lang === "rs") {
    if (
      normalised.includes("/tests/") ||
      normalised.includes("/test/") ||
      normalised.includes("/testing/") ||
      normalised.startsWith("tests/") ||
      filename.startsWith("test_") ||
      filename.endsWith("_test.rs") ||
      filename.endsWith(".test.rs")
    ) {
      return "rust-test";
    }
    return "rust-src";
  }
  // First-path-segment fallback. calibration.ts uses the same convention
  // ("src", "lib", "crates", ...). Keeping the bucketer in two places is
  // intentional: this one is the *output* group the README documents, the
  // other is the *internal* group used for per-rule debugging.
  return segments[0] || "(unknown)";
}

/**
 * Decide what happened to one inline review finding. A thread is:
 *   - "accepted" when a commit AFTER it landed touched the file. This covers
 *     the most common case (the author fixed the line in a follow-up commit)
 *     and the case where the comment author is satisfied by an unrelated
 *     touch to the same file. We use file-level granularity because most bot
 *     threads do not preserve line numbers across rebases and the harvest
 *     window often spans pushes that move lines.
 *   - "dismissed" when the thread was resolved with no subsequent commit on
 *     the same file. Resolved is treated as a deliberate close by either the
 *     thread author or the PR author; "no commit on the file" is the evidence
 *     the finding was not actioned.
 *   - "unaddressed" when the thread is still open and no commit has touched
 *     the file. Open + no edit = the finding is sitting there unresolved.
 *
 * The classifier is pure: callers pass in the touched-paths set they observed
 * for the window between the comment and the merge/close time, and the
 * classifier does not look at the network.
 */
export function classifyOutcome(finding: InlineReviewFinding): ReviewOutcome {
  const touched = finding.subsequentTouchedPaths.some(
    (p) => p === finding.path || pathGroupFor(p) === pathGroupFor(finding.path)
  );
  if (touched) return "accepted";
  if (finding.threadResolved) return "dismissed";
  return "unaddressed";
}

function statsFor(counts: { accepted: number; total: number }): PathGroupStats {
  return {
    n: counts.total,
    acceptRate: counts.total > 0 ? counts.accepted / counts.total : 0,
  };
}

function emptyStats(): PathGroupStats {
  return { n: 0, acceptRate: 0 };
}

/**
 * Aggregate inline findings into per-reviewer overall + by-path-group stats.
 * Findings whose `reviewer` is not in BOT_REVIEWERS are dropped — the schema
 * covers the seven bots the org runs and adding more is a schema break, not
 * a quiet extension.
 */
export function aggregateReviewerProfiles(
  findings: InlineReviewFinding[],
  generatedAt: string,
  windowDays: number
): ReviewerProfiles {
  const reviewers: Record<string, ReviewerStats> = {};
  for (const bot of BOT_REVIEWERS) {
    reviewers[bot] = { overall: emptyStats(), byPathGroup: {} };
  }

  for (const finding of findings) {
    const stats = reviewers[finding.reviewer];
    if (!stats) continue;
    const accepted = classifyOutcome(finding) === "accepted" ? 1 : 0;
    stats.overall = statsFor({
      accepted: stats.overall.acceptRate * stats.overall.n + accepted,
      total: stats.overall.n + 1,
    });
    const group = pathGroupFor(finding.path);
    const prev = stats.byPathGroup[group] ?? emptyStats();
    stats.byPathGroup[group] = statsFor({
      accepted: prev.acceptRate * prev.n + accepted,
      total: prev.n + 1,
    });
  }

  return {
    schema: "maxi.review.v1.reviewer-profiles",
    generatedAt,
    windowDays,
    reviewers: reviewers as Record<BotReviewer, ReviewerStats>,
  };
}

export function isBotReviewer(login: string): login is BotReviewer {
  return (BOT_REVIEWERS as readonly string[]).includes(login);
}
