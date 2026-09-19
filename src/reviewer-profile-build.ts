/**
 * Scheduled harvest runner for the per-reviewer calibration profile. The
 * GitHub-side harvesting that `src/calibration.ts`'s docstring defers lives
 * here: walk the org's merged/closed PRs in a window, pull inline review
 * thread states and the commits that landed between each thread's first
 * comment and the PR's merge/close, and feed the observations into the pure
 * classifier in `src/reviewer-profile.ts`.
 *
 * Entry points:
 *   - runScheduledHarvest(): used by .github/workflows/calibration-harvest.yml.
 *   - harvest(...): the harvester itself, exposed for tests.
 *   - listPullsInWindow / listReviewThreads / listChangedPathsAfter: the
 *     three paginated GraphQL walks the harvester composes.
 */

import * as github from "@actions/github";
import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import {
  aggregateReviewerProfiles,
  BotReviewer,
  InlineReviewFinding,
  isBotReviewer,
  pathGroupFor,
  ReviewerProfiles,
} from "./reviewer-profile.js";
import { buildCalibrationReport } from "./calibration.js";
import { extractReviewArtifact } from "./review-command.js";
import { listReviewArtifactComments } from "./github.js";

interface GraphqlPullsPage {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      number: number;
      title: string;
      url: string;
      mergedAt: string | null;
      closedAt: string | null;
      updatedAt: string;
      repository: { nameWithOwner: string };
    }>;
  };
}

interface GraphqlThreadPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string | null;
          line: number | null;
          comments: {
            nodes: Array<{
              author: { login: string } | null;
              createdAt: string;
              databaseId: number;
            }>;
          };
        }>;
      };
    };
  } | null;
}

interface GraphqlCommitPathsPage {
  repository: {
    pullRequest: {
      commits: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          commit: {
            oid: string;
            authoredDate: string;
            committedDate: string;
            changedFilesIfAvailable: { nodes: Array<{ path: string }> } | null;
          };
        }>;
      };
    };
  } | null;
}

const PULLS_QUERY = /* GraphQL */ `
  query HarvestPulls($searchQuery: String!, $first: Int!, $cursor: String) {
    search(query: $searchQuery, type: ISSUE, first: $first, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          number
          title
          url
          mergedAt
          closedAt
          updatedAt
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
`;

const THREADS_QUERY = /* GraphQL */ `
  query HarvestThreads(
    $owner: String!
    $name: String!
    $pr: Int!
    $first: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: $first, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 1) {
              nodes {
                author {
                  login
                }
                createdAt
                databaseId
              }
            }
          }
        }
      }
    }
  }
`;

const COMMIT_PATHS_QUERY = /* GraphQL */ `
  query HarvestCommitPaths(
    $owner: String!
    $name: String!
    $pr: Int!
    $first: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        commits(first: $first, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            commit {
              oid
              authoredDate
              committedDate
              changedFilesIfAvailable(first: 100) {
                nodes {
                  path
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface CollectFindingsOptions {
  /** Maximum PRs to harvest. Defaults to 500. */
  maxPulls?: number;
  /** Maximum review threads per PR to inspect. */
  maxThreadsPerPull?: number;
  /** Maximum commits to walk on a PR's history. */
  maxCommitsPerPull?: number;
  /** Maximum touched paths to keep per PR. */
  maxTouchedPathsPerPull?: number;
}

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
  /** ISO-8601 timestamp of the merge or close event. */
  terminusAt: string;
  updatedAt: string;
}

async function paginate<
  T,
  Page extends { pageInfo: { hasNextPage: boolean; endCursor: string | null } },
>(
  fetcher: (cursor: string | null) => Promise<Page>,
  extractNodes: (page: Page) => T[],
  limit: number
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  while (out.length < limit) {
    const page = await fetcher(cursor);
    out.push(...extractNodes(page));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (cursor === null) break;
  }
  return out.slice(0, limit);
}

/**
 * Walk the org's merged/closed pull requests in the trailing window. The
 * search query narrows on `is:pr` and the merge/close date so we don't
 * enumerate every open PR in the org just to filter server-side. The
 * OR clause is parenthesised — GitHub's search applies `OR` with lower
 * precedence than the implicit AND, so `a OR b sort:updated-desc` would
 * otherwise read as `(a) OR (b sort:updated-desc)` and pull the entire
 * platform's issues into scope.
 */
export async function listPullsInWindow(
  octokit: ReturnType<typeof github.getOctokit>,
  org: string,
  windowDays: number,
  maxPulls: number
): Promise<PullRef[]> {
  const date = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const searchQuery = `org:${org} is:pr is:closed (merged:>=${date} OR closed:>=${date}) sort:updated-desc`;

  const pulls = await paginate(
    async (cursor) => {
      // `query` is reserved by @octokit/graphql as the document key; pass
      // the GraphQL variable under its declared name (`$searchQuery`) so
      // the library doesn't throw `cannot be used as variable name`.
      const response = (await octokit.graphql(PULLS_QUERY, {
        searchQuery,
        first: 50,
        cursor,
      })) as GraphqlPullsPage;
      return response.search;
    },
    (search) => search.nodes,
    maxPulls
  );

  return pulls.map((p) => {
    const [owner, repo] = p.repository.nameWithOwner.split("/");
    return {
      owner,
      repo,
      number: p.number,
      terminusAt: p.mergedAt ?? p.closedAt ?? p.updatedAt,
      updatedAt: p.updatedAt,
    };
  });
}

export interface ReviewThreadRef {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  firstAuthor: string | null;
  createdAt: string | null;
}

/**
 * Walk the review threads on one PR. The GraphQL pagination caps at 100 per
 * page; most PRs have well under that, but high-traffic repos can blow past.
 */
export async function listReviewThreads(
  octokit: ReturnType<typeof github.getOctokit>,
  pull: PullRef,
  maxThreads: number
): Promise<ReviewThreadRef[]> {
  const threads = await paginate(
    async (cursor) => {
      const response = (await octokit.graphql(THREADS_QUERY, {
        owner: pull.owner,
        name: pull.repo,
        pr: pull.number,
        first: 100,
        cursor,
      })) as GraphqlThreadPage;
      return (
        response.repository?.pullRequest?.reviewThreads ?? {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        }
      );
    },
    (conn) =>
      conn.nodes.map((node) => ({
        id: node.id,
        isResolved: node.isResolved,
        path: node.path,
        line: node.line,
        firstAuthor: node.comments.nodes[0]?.author?.login ?? null,
        createdAt: node.comments.nodes[0]?.createdAt ?? null,
      })),
    maxThreads
  );
  return threads;
}

/**
 * Walk the commits on this PR, returning a per-PR list of `{oid,
 * committedDate, paths}` in reverse-chronological order. The list is
 * capped by `maxCommits` and `maxTouchedPaths` so a noisy branch can't run
 * the harvester out of memory.
 *
 * The PR's `commits` connection is used (not `repository.object`) because
 * `object(expression:)` requires a git ref (SHA, branch, or tag) — passing
 * an ISO timestamp silently returns null, which would surface as an empty
 * changed-files set on every PR. The commits connection doesn't accept a
 * date filter; instead, callers stop walking once a commit's date falls
 * before their per-thread `createdAt`.
 */
export async function listCommitsAfter(
  octokit: ReturnType<typeof github.getOctokit>,
  pull: PullRef,
  maxTouchedPaths: number,
  maxCommits: number
): Promise<Array<{ oid: string; committedDate: string; paths: string[] }>> {
  const commits: Array<{
    oid: string;
    committedDate: string;
    paths: string[];
  }> = [];
  let cursor: string | null = null;
  let touchedPaths = 0;
  while (commits.length < maxCommits && touchedPaths < maxTouchedPaths) {
    const response = (await octokit.graphql(COMMIT_PATHS_QUERY, {
      owner: pull.owner,
      name: pull.repo,
      pr: pull.number,
      first: 50,
      cursor,
    })) as GraphqlCommitPathsPage;
    const conn = response.repository?.pullRequest?.commits;
    if (!conn) break;
    for (const node of conn.nodes) {
      const paths = (node.commit.changedFilesIfAvailable?.nodes ?? []).map(
        (f) => f.path
      );
      commits.push({
        oid: node.commit.oid,
        committedDate: node.commit.committedDate,
        paths,
      });
      touchedPaths += paths.length;
      if (commits.length >= maxCommits) break;
      if (touchedPaths >= maxTouchedPaths) break;
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (cursor === null) break;
  }
  return commits;
}

export interface HarvestResult {
  findings: InlineReviewFinding[];
  /** Per-rule / per-severity / per-path calibration report from `calibration.ts`. */
  calibration: ReturnType<typeof buildCalibrationReport>;
  /** How many maxi-reviewer `maxi.review.v1.review-artifact` payloads we successfully harvested. */
  artifactsObserved: number;
}

/**
 * End-to-end harvester: walk the org's PRs, walk their threads, walk the
 * commits that landed between each thread's creation and the PR's merge, and
 * emit observations for the pure classifier. Also harvests
 * `maxi.review.v1.review-artifact` payloads from each PR so the existing
 * `calibration.ts` engine produces a per-rule / per-severity / per-path report
 * for maxi-reviewer.
 *
 * The touched-paths set for each finding is filtered by that thread's own
 * `createdAt`. Using a single PR-wide earliest date (as the original draft
 * did) risked marking threads accepted by commits that landed before the
 * thread was opened.
 */
export async function harvest(
  octokit: ReturnType<typeof github.getOctokit>,
  org: string,
  windowDays: number,
  options: CollectFindingsOptions = {}
): Promise<HarvestResult> {
  const maxPulls = options.maxPulls ?? 500;
  const maxThreadsPerPull = options.maxThreadsPerPull ?? 200;
  const maxCommitsPerPull = options.maxCommitsPerPull ?? 200;
  const maxTouchedPathsPerPull = options.maxTouchedPathsPerPull ?? 2000;

  const pulls = await listPullsInWindow(octokit, org, windowDays, maxPulls);
  core.info(`harvest: scanning ${pulls.length} merged/closed PRs in ${org}`);

  const findings: InlineReviewFinding[] = [];
  const calibrationInputs: Array<{
    artifact: Parameters<typeof buildCalibrationReport>[0][number]["artifact"];
    threads: Parameters<typeof buildCalibrationReport>[0][number]["threads"];
  }> = [];
  let artifactsObserved = 0;
  let pullIndex = 0;
  for (const pull of pulls) {
    pullIndex += 1;
    let threads: ReviewThreadRef[];
    try {
      threads = await listReviewThreads(octokit, pull, maxThreadsPerPull);
    } catch (err) {
      core.warning(
        `harvest: threads fetch failed for ${pull.owner}/${pull.repo}#${pull.number}: ${String(err)}`
      );
      continue;
    }

    const botThreads = threads.filter(
      (t) => t.firstAuthor && isBotReviewer(t.firstAuthor)
    );
    if (botThreads.length === 0) continue;
    core.info(
      `harvest: PR ${pullIndex}/${pulls.length} ${pull.owner}/${pull.repo}#${pull.number}: ${botThreads.length} bot threads`
    );

    // Walk the PR's commits once. The list is reverse-chronological;
    // for each thread, accumulate the paths touched after its createdAt
    // by stopping the per-thread filter when we hit an older commit.
    let commits: Array<{
      oid: string;
      committedDate: string;
      paths: string[];
    }> = [];
    if (botThreads.some((t) => !t.isResolved)) {
      try {
        commits = await listCommitsAfter(
          octokit,
          pull,
          maxTouchedPathsPerPull,
          maxCommitsPerPull
        );
      } catch (err) {
        core.warning(
          `harvest: commits fetch failed for ${pull.owner}/${pull.repo}#${pull.number}: ${String(err)}`
        );
      }
    }

    function touchedPathsAfterThread(thread: ReviewThreadRef): string[] {
      if (!thread.createdAt) return [];
      const out: string[] = [];
      // commits is reverse-chronological; once we see a commit dated
      // before the thread, no later commit is older, so we stop walking.
      for (const c of commits) {
        if (c.committedDate < thread.createdAt) break;
        for (const p of c.paths) {
          out.push(p);
        }
      }
      return out;
    }

    for (const thread of botThreads) {
      const reviewer = thread.firstAuthor;
      if (!reviewer || !isBotReviewer(reviewer)) continue;
      const path = thread.path ?? "";
      findings.push({
        reviewer: reviewer as BotReviewer,
        repo: `${pull.owner}/${pull.repo}`,
        prNumber: pull.number,
        path,
        line: thread.line ?? 0,
        threadResolved: thread.isResolved,
        subsequentTouchedPaths: touchedPathsAfterThread(thread),
      });
    }

    // Calibration harvest: pull maxi-reviewer's `review-artifact` comments off
    // this PR, decode them, and feed each into `calibration.ts`. The thread
    // states we already walked above feed the same engine.
    try {
      const artifactBodies = await listReviewArtifactComments(
        octokit,
        pull.owner,
        pull.repo,
        pull.number
      );
      for (const body of artifactBodies) {
        const artifact = extractReviewArtifact(body);
        if (
          !artifact ||
          typeof (artifact as { repoFullName?: unknown }).repoFullName !==
            "string"
        ) {
          continue;
        }
        const threadStates = threads.map((t) => ({
          path: t.path ?? "",
          line: t.line ?? 0,
          resolved: t.isResolved,
        }));
        calibrationInputs.push({
          artifact: artifact as Parameters<
            typeof buildCalibrationReport
          >[0][number]["artifact"],
          threads: threadStates,
        });
        artifactsObserved += 1;
      }
    } catch (err) {
      core.warning(
        `harvest: artifact fetch failed for ${pull.owner}/${pull.repo}#${pull.number}: ${String(err)}`
      );
    }
  }

  const calibration = buildCalibrationReport(calibrationInputs);
  core.info(
    `harvest: calibration report produced ${calibration.byRule.length} rule groups, ${calibration.bySeverity.length} severity groups, ${calibration.byPath.length} path groups from ${artifactsObserved} artifacts`
  );

  return { findings, calibration, artifactsObserved };
}

export interface RunHarvestOptions {
  outPath: string;
  /** Optional second output path for the calibration.ts report (maxi-reviewer own-artifacts). */
  calibrationOutPath?: string;
  org: string;
  windowDays: number;
  maxPulls?: number;
  token: string;
}

export interface RunHarvestResult {
  profiles: ReviewerProfiles;
  calibration: ReturnType<typeof buildCalibrationReport>;
  artifactsObserved: number;
}

export async function runScheduledHarvest(
  options: RunHarvestOptions
): Promise<RunHarvestResult> {
  const octokit = github.getOctokit(options.token, {
    throttle: {
      retries: 3,
      onRateLimit: () => true,
      onSecondaryRateLimit: () => true,
    },
  });
  const result = await harvest(octokit, options.org, options.windowDays, {
    maxPulls: options.maxPulls,
  });
  const profiles = aggregateReviewerProfiles(
    result.findings,
    new Date().toISOString(),
    options.windowDays
  );

  const totalSamples = Object.values(profiles.reviewers).reduce(
    (sum, stats) => sum + stats.overall.n,
    0
  );
  const reviewersWithSamples = Object.values(profiles.reviewers).filter(
    (stats) => stats.overall.n > 0
  ).length;
  core.info(
    `harvest: wrote ${totalSamples} samples across ${reviewersWithSamples} bot reviewers (window=${options.windowDays}d)`
  );
  for (const [reviewer, stats] of Object.entries(profiles.reviewers)) {
    const groups = Object.entries(stats.byPathGroup)
      .filter(([, s]) => s.n > 0)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 3);
    if (groups.length > 0) {
      const summary = groups
        .map(([g, s]) => `${g}=${s.n}@${(s.acceptRate * 100).toFixed(0)}%`)
        .join(", ");
      core.info(`harvest: ${reviewer}: ${summary}`);
    }
  }
  core.info(
    `harvest: bucketer smoke-check: Cargo.lock=${pathGroupFor("Cargo.lock")} workflows/ci.yml=${pathGroupFor(".github/workflows/ci.yml")}`
  );

  await fs.writeFile(options.outPath, JSON.stringify(profiles, null, 2));
  if (options.calibrationOutPath) {
    await fs.writeFile(
      options.calibrationOutPath,
      JSON.stringify(
        {
          schema: "maxi.review.v1.calibration-report",
          generatedAt: profiles.generatedAt,
          windowDays: options.windowDays,
          artifactsObserved: result.artifactsObserved,
          byRule: result.calibration.byRule,
          bySeverity: result.calibration.bySeverity,
          byPath: result.calibration.byPath,
        },
        null,
        2
      )
    );
  }
  return {
    profiles,
    calibration: result.calibration,
    artifactsObserved: result.artifactsObserved,
  };
}
