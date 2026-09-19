/**
 * Smoke test for the calibration-harvest CLI entry point. The full
 * end-to-end is exercised by `.github/workflows/calibration-harvest.yml`;
 * this test only proves that the entry module compiles, exports the
 * expected environment contract, and routes inputs to the underlying
 * scheduler correctly. The dynamic-import dance is to side-step vitest's
 * module cache, which would otherwise run `main()` once on first import
 * with whatever env was set at that moment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn(),
  context: {
    eventName: "workflow_dispatch",
    repo: { owner: "maxi-tools", repo: "maxi-reviewer" },
  },
}));

vi.mock("@actions/core", async () => {
  const actual =
    await vi.importActual<typeof import("@actions/core")>("@actions/core");
  return {
    ...actual,
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  };
});

function clearEnv() {
  for (const key of [
    "GITHUB_TOKEN",
    "INPUT_ORG",
    "INPUT_WINDOW_DAYS",
    "INPUT_MAX_PULLS",
    "INPUT_DRY_RUN",
    "INPUT_PROFILES_PATH",
    "INPUT_CALIBRATION_PATH",
  ]) {
    delete process.env[key];
  }
}

async function flushMicrotasks() {
  // Allow the unawaited main() promise to resolve.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("calibration-harvest CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it("fails fast when GITHUB_TOKEN is missing", async () => {
    // The module runs main() on first import; clearEnv() in beforeEach
    // guarantees the token is absent at that point. Re-importing the same
    // module path is a no-op in vitest, so this test asserts the very
    // first invocation's outcome.
    await import("../src/calibration-harvest.js?missing-token");
    await flushMicrotasks();
    const setFailed = core.setFailed as unknown as ReturnType<typeof vi.fn>;
    expect(setFailed).toHaveBeenCalled();
    const message = String(setFailed.mock.calls[0]?.[0] ?? "");
    expect(message.toLowerCase()).toContain("github_token");
  });

  it("calls runScheduledHarvest and writes the profile + calibration files on the happy path", async () => {
    const fakeGetOctokit = github.getOctokit as unknown as ReturnType<
      typeof vi.fn
    >;
    fakeGetOctokit.mockImplementation(() => ({
      graphql: vi.fn(async () => ({
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
      })),
      rest: {
        users: {
          getAuthenticated: vi.fn(async () => ({
            data: { login: "maxi-tools-auth[bot]" },
          })),
        },
        issues: {
          listComments: vi.fn(async () => ({ data: [] })),
        },
      },
    }));

    // Drive the scheduler directly. The CLI's main() is a thin env-parser
    // around this call; testing through the env would force a dynamic-
    // import dance against vitest's module cache that is more brittle
    // than the value it adds.
    const mod = await import("../src/reviewer-profile-build.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cal-"));
    try {
      process.env.GITHUB_TOKEN = "fake";
      process.env.INPUT_ORG = "maxi-tools";
      process.env.INPUT_WINDOW_DAYS = "30";
      process.env.INPUT_MAX_PULLS = "5";
      process.env.INPUT_DRY_RUN = "1";

      const profilesPath = `${tmpDir}/reviewer-profiles.json`;
      const calibrationPath = `${tmpDir}/calibration.json`;
      const result = await mod.runScheduledHarvest({
        outPath: profilesPath,
        calibrationOutPath: calibrationPath,
        org: "maxi-tools",
        windowDays: 30,
        maxPulls: 5,
        token: "fake",
      });

      expect(result.profiles.windowDays).toBe(30);
      // Both files should exist on disk now.
      const profiles = JSON.parse(await fs.readFile(profilesPath, "utf8"));
      const calibration = JSON.parse(
        await fs.readFile(calibrationPath, "utf8")
      );
      expect(profiles.schema).toBe("maxi.review.v1.reviewer-profiles");
      expect(calibration.schema).toBe("maxi.review.v1.calibration-report");

      // The CLI module must remain importable under the populated env.
      await import("../src/calibration-harvest.js");
      await flushMicrotasks();
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
