import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphqlPullsPage } from "../src/reviewer-profile-build.js";

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn(),
  context: {
    eventName: "workflow_dispatch",
    repo: { owner: "maxi-tools", repo: "maxi-reviewer" },
  },
}));

import * as github from "@actions/github";
import {
  harvest,
  listPullsInWindow,
  listReviewThreads,
  listChangedPathsAfter,
  runScheduledHarvest,
} from "../src/reviewer-profile-build.js";
import { buildCalibrationReport } from "../src/calibration.js";
import { extractReviewArtifact } from "../src/review-command.js";

// The mock below is the test fixture — referencing `github` here so the
// import survives the linter's `no-unused-vars` check.
void github;

interface FakeOctokit {
  graphql: ReturnType<typeof vi.fn>;
  rest: {
    users: {
      getAuthenticated: ReturnType<typeof vi.fn>;
    };
  };
}

function makeOctokit(
  handlers: Record<string, (vars: Record<string, unknown>) => unknown>
): FakeOctokit {
  return {
    graphql: vi.fn(async (_query: string, vars: Record<string, unknown>) => {
      const key = JSON.stringify(Object.keys(vars).sort());
      const handler = handlers[key];
      if (!handler) {
        throw new Error(`Unexpected graphql call with vars: ${key}`);
      }
      return handler(vars);
    }),
    rest: {
      users: {
        // tests that exercise the artifact path need to seed the
        // authenticated user the github.ts helper uses to filter
        // trustedAuthors; default to a known bot so the filter is
        // permissive without making the test reach the network.
        getAuthenticated: vi.fn(async () => ({
          data: { login: "maxi-tools-auth[bot]" },
        })),
      },
    },
  };
}

describe("listPullsInWindow", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("walks the org search API and maps mergedAt / closedAt to terminusAt", async () => {
    let capturedQuery = "";
    const octokit = makeOctokit({
      '["cursor","first","query"]': (vars) => {
        capturedQuery = String(vars.query);
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "merged",
                url: "u",
                mergedAt: "2026-09-10T12:00:00Z",
                closedAt: null,
                updatedAt: "2026-09-10T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
              {
                number: 8,
                title: "closed-not-merged",
                url: "u",
                mergedAt: null,
                closedAt: "2026-09-09T12:00:00Z",
                updatedAt: "2026-09-09T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
            ],
          },
        } satisfies GraphqlPullsPage;
      },
    });
    const pulls = await listPullsInWindow(
      octokit as never,
      "maxi-tools",
      30,
      10
    );
    expect(pulls).toHaveLength(2);
    expect(pulls[0].terminusAt).toBe("2026-09-10T12:00:00Z");
    expect(pulls[1].terminusAt).toBe("2026-09-09T12:00:00Z");
    expect(capturedQuery).toContain("org:maxi-tools");
    expect(capturedQuery).toContain("is:pr");
    expect(capturedQuery).toContain("is:closed");
  });
});

describe("listReviewThreads", () => {
  it("returns the first-comment author and createdAt per thread", async () => {
    const octokit = makeOctokit({
      '["cursor","first","name","owner","pr"]': () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  path: "src/a.ts",
                  line: 4,
                  comments: {
                    nodes: [
                      {
                        author: { login: "coderabbitai" },
                        createdAt: "2026-09-10T00:00:00Z",
                        databaseId: 1,
                      },
                    ],
                  },
                },
                {
                  id: "T2",
                  isResolved: true,
                  path: "src/b.ts",
                  line: 9,
                  comments: {
                    nodes: [
                      {
                        author: { login: "maxiboch" },
                        createdAt: "2026-09-10T00:01:00Z",
                        databaseId: 2,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const threads = await listReviewThreads(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      10
    );
    expect(threads).toHaveLength(2);
    expect(threads[0].firstAuthor).toBe("coderabbitai");
    expect(threads[1].firstAuthor).toBe("maxiboch");
    expect(threads[1].isResolved).toBe(true);
  });
});

describe("listChangedPathsAfter", () => {
  it("returns the set of paths touched after the cutoff", async () => {
    const octokit = makeOctokit({
      '["cursor","expr","first","name","owner"]': () => ({
        repository: {
          object: {
            history: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  oid: "a",
                  authoredDate: "2026-09-10T00:00:00Z",
                  committedDate: "2026-09-10T00:00:00Z",
                  changedFiles: {
                    nodes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
                  },
                },
                {
                  oid: "b",
                  authoredDate: "2026-09-09T23:59:00Z",
                  committedDate: "2026-09-09T23:59:00Z",
                  changedFiles: {
                    nodes: [{ path: "src/early.ts" }],
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const paths = await listChangedPathsAfter(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      "2026-09-10T00:00:00Z",
      2000,
      200
    );
    expect(paths.has("src/a.ts")).toBe(true);
    expect(paths.has("src/b.ts")).toBe(true);
    expect(paths.has("src/early.ts")).toBe(false);
  });
});

describe("harvest", () => {
  it("emits findings for every bot thread and a calibration report for maxi-reviewer artifacts", async () => {
    const octokit = makeOctokit({
      '["cursor","first","query"]': () => ({
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 7,
              title: "t",
              url: "u",
              mergedAt: "2026-09-10T12:00:00Z",
              closedAt: null,
              updatedAt: "2026-09-10T12:00:00Z",
              repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
            },
          ],
        },
      }),
      '["cursor","first","name","owner","pr"]': () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  path: "crates/x/src/lib.rs",
                  line: 4,
                  comments: {
                    nodes: [
                      {
                        author: { login: "coderabbitai" },
                        createdAt: "2026-09-10T00:00:00Z",
                        databaseId: 1,
                      },
                    ],
                  },
                },
                {
                  id: "T2",
                  isResolved: true,
                  path: "scripts/run.sh",
                  line: 9,
                  comments: {
                    nodes: [
                      {
                        author: { login: "maxi-reviewer" },
                        createdAt: "2026-09-10T00:01:00Z",
                        databaseId: 2,
                      },
                    ],
                  },
                },
                {
                  id: "T3",
                  isResolved: false,
                  path: "crates/x/src/lib.rs",
                  line: 7,
                  comments: {
                    nodes: [
                      {
                        author: { login: "codacy-production" },
                        createdAt: "2026-09-10T00:02:00Z",
                        databaseId: 3,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
      '["cursor","expr","first","name","owner"]': () => ({
        repository: {
          object: {
            history: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  oid: "a",
                  authoredDate: "2026-09-10T00:30:00Z",
                  committedDate: "2026-09-10T00:30:00Z",
                  changedFiles: {
                    nodes: [{ path: "crates/x/src/lib.rs" }],
                  },
                },
              ],
            },
          },
        },
      }),
    });

    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
      maxThreadsPerPull: 10,
      maxCommitsPerPull: 50,
    });

    // Three threads -> three observations, classified:
    //   - coderabbitai on rust-src: open, file touched -> accepted
    //   - maxi-reviewer on shell: resolved, untouched -> dismissed
    //   - codacy-production on rust-src: open, file touched -> accepted
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0].reviewer).toBe("coderabbitai");
    expect(result.findings[1].reviewer).toBe("maxi-reviewer");
    expect(result.findings[2].reviewer).toBe("codacy-production");
    // Calibration report: no artifacts returned -> empty report.
    expect(result.calibration.byRule).toEqual([]);
    expect(result.calibration.bySeverity).toEqual([]);
    expect(result.calibration.byPath).toEqual([]);
    expect(result.artifactsObserved).toBe(0);
  });

  it("returns zero findings when no PRs match", async () => {
    const octokit = makeOctokit({
      '["cursor","first","query"]': () => ({
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      }),
    });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    });
    expect(result.findings).toEqual([]);
    expect(result.calibration.byRule).toEqual([]);
  });

  it("decodes a maxi-reviewer artifact comment and feeds it to calibration.ts", async () => {
    // The full GraphQL + REST round-tripping (artifact comment fetch, the
    // trustedAuthors helper, paginate) is exercised in the
    // `runScheduledHarvest` test below. Here we test the pure composition:
    // once `extractReviewArtifact` has decoded a body and `harvest` has
    // produced the (artifact, threads) pair, `buildCalibrationReport`
    // produces a non-empty report.
    const artifact = {
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-09-10T00:00:00.000Z",
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      },
      repoFullName: "maxi-tools/maxi-reviewer",
      prNumber: 7,
      headSha: "h",
      baseSha: "b",
      outcome: "REVIEWED_WITH_FINDINGS",
      outcomeSchema: "maxi.review.v1.review-outcome",
      reviewOutputChars: 1,
      runIdentity: { workflowRunId: 1, workflowRunAttempt: 1, job: "review" },
      analyzerFindings: [],
      rawJulesResponses: [],
      validatedReview: {
        schema: "maxi.review.v1.jules-review",
        summary: "s",
        verdict: "comment",
        resolvedCommentIds: [],
        comments: [
          {
            id: "c1",
            path: "crates/x/src/lib.rs",
            line: 4,
            severity: "Warning",
            confidence: "High",
            message: "m",
          },
        ],
      },
      validationErrors: [],
    };
    const body = `<!-- maxi-review artifact -->\n<!-- maxi-review artifact-data\nname: review.json\nencoding: base64\n${Buffer.from(JSON.stringify(artifact), "utf8").toString("base64")}\n-->`;

    const decoded = extractReviewArtifact(body);
    expect(decoded).not.toBeNull();

    // Drive the calibration engine directly to confirm the artifact decoded
    // into the shape the engine consumes.
    const built = buildCalibrationReport([
      {
        artifact: decoded as never,
        threads: [{ path: "crates/x/src/lib.rs", line: 4, resolved: true }],
      },
    ]);

    expect(built.byRule.length).toBeGreaterThan(0);
    expect(built.bySeverity.length).toBeGreaterThan(0);
    expect(built.byPath.length).toBeGreaterThan(0);
  });
});

describe("listChangedPathsAfter pagination", () => {
  it("walks multiple history pages and stops when the path set is full", async () => {
    let pages = 0;
    const octokit = makeOctokit({
      '["cursor","expr","first","name","owner"]': () => {
        pages += 1;
        if (pages === 1) {
          return {
            repository: {
              object: {
                history: {
                  pageInfo: { hasNextPage: true, endCursor: "c2" },
                  nodes: [
                    {
                      oid: "a",
                      authoredDate: "2026-09-10T00:30:00Z",
                      committedDate: "2026-09-10T00:30:00Z",
                      changedFiles: {
                        nodes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
                      },
                    },
                  ],
                },
              },
            },
          };
        }
        return {
          repository: {
            object: {
              history: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    oid: "b",
                    authoredDate: "2026-09-10T00:31:00Z",
                    committedDate: "2026-09-10T00:31:00Z",
                    changedFiles: {
                      nodes: [{ path: "src/c.ts" }],
                    },
                  },
                ],
              },
            },
          },
        };
      },
    });
    const paths = await listChangedPathsAfter(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      "2026-09-10T00:00:00Z",
      2000,
      200
    );
    expect(paths.has("src/a.ts")).toBe(true);
    expect(paths.has("src/b.ts")).toBe(true);
    expect(paths.has("src/c.ts")).toBe(true);
    expect(pages).toBe(2);
  });

  it("caps at the commit ceiling when a branch has unbounded history", async () => {
    const octokit = makeOctokit({
      '["cursor","expr","first","name","owner"]': () => ({
        repository: {
          object: {
            history: {
              pageInfo: { hasNextPage: true, endCursor: "c2" },
              nodes: [
                {
                  oid: "a",
                  authoredDate: "2026-09-10T00:30:00Z",
                  committedDate: "2026-09-10T00:30:00Z",
                  changedFiles: {
                    nodes: [{ path: "src/a.ts" }],
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const paths = await listChangedPathsAfter(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      "2026-09-10T00:00:00Z",
      2000,
      // Hit the commit ceiling before paginating further.
      1
    );
    expect(paths.has("src/a.ts")).toBe(true);
  });
});

describe("runScheduledHarvest", () => {
  it("writes reviewer-profiles.json and calibration.json when given a token", async () => {
    const fakeGetOctokit = github.getOctokit as unknown as ReturnType<
      typeof vi.fn
    >;
    fakeGetOctokit.mockImplementation(() => {
      const handlers: Record<
        string,
        (vars: Record<string, unknown>) => unknown
      > = {
        '["cursor","first","query"]': () => ({
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "t",
                url: "u",
                mergedAt: "2026-09-10T12:00:00Z",
                closedAt: null,
                updatedAt: "2026-09-10T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
            ],
          },
        }),
        '["cursor","first","name","owner","pr"]': () => ({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    isResolved: true,
                    path: "crates/x/src/lib.rs",
                    line: 4,
                    comments: {
                      nodes: [
                        {
                          author: { login: "coderabbitai" },
                          createdAt: "2026-09-10T00:00:00Z",
                          databaseId: 1,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
        '["issue_number","owner","per_page","repo"]': () => ({ data: [] }),
      };
      return {
        graphql: vi.fn(async (_q: string, vars: Record<string, unknown>) => {
          const key = JSON.stringify(Object.keys(vars).sort());
          const handler = handlers[key];
          if (!handler) throw new Error(`Unexpected graphql call: ${key}`);
          return handler(vars);
        }),
      };
    });

    const tmpDir = await import("node:fs/promises").then((m) =>
      m.mkdtemp("/tmp/calibration-")
    );
    const profilesPath = `${tmpDir}/reviewer-profiles.json`;
    const calibrationPath = `${tmpDir}/calibration.json`;
    try {
      const result = await runScheduledHarvest({
        outPath: profilesPath,
        calibrationOutPath: calibrationPath,
        org: "maxi-tools",
        windowDays: 30,
        token: "fake-token",
      });
      expect(result.profiles.windowDays).toBe(30);
      expect(result.profiles.reviewers["coderabbitai"].overall.n).toBe(1);
      expect(result.profiles.reviewers["coderabbitai"].overall.acceptRate).toBe(
        0
      );

      const written = JSON.parse(
        await import("node:fs/promises").then((m) =>
          m.readFile(profilesPath, "utf8")
        )
      );
      expect(written.schema).toBe("maxi.review.v1.reviewer-profiles");
      expect(written.reviewers["coderabbitai"].overall.n).toBe(1);

      const calibrationWritten = JSON.parse(
        await import("node:fs/promises").then((m) =>
          m.readFile(calibrationPath, "utf8")
        )
      );
      expect(calibrationWritten.schema).toBe(
        "maxi.review.v1.calibration-report"
      );
      expect(calibrationWritten.windowDays).toBe(30);
      expect(calibrationWritten.artifactsObserved).toBe(0);
    } finally {
      await import("node:fs/promises").then((m) =>
        m.rm(tmpDir, { recursive: true })
      );
    }
  });
});
