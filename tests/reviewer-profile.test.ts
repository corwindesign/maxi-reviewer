import { describe, it, expect } from "vitest";
import {
  BOT_REVIEWERS,
  aggregateReviewerProfiles,
  classifyOutcome,
  isBotReviewer,
  pathGroupFor,
  ReviewerProfiles,
} from "../src/reviewer-profile.js";

const baseFinding = (
  overrides: Partial<{
    reviewer:
      | "codacy-production"
      | "coderabbitai"
      | "qltysh"
      | "chatgpt-codex-connector"
      | "cubic-dev-ai"
      | "github-advanced-security"
      | "maxi-reviewer";
    path: string;
    line: number;
    threadResolved: boolean;
    subsequentTouchedPaths: string[];
  }> = {}
) => ({
  reviewer: "maxi-reviewer" as const,
  repo: "maxi-tools/maxi-reviewer",
  prNumber: 1,
  path: "src/a.ts",
  line: 4,
  threadResolved: false,
  subsequentTouchedPaths: [],
  ...overrides,
});

describe("pathGroupFor", () => {
  it("routes source Rust files into rust-src and test Rust files into rust-test", () => {
    expect(pathGroupFor("crates/maxi-kvm-core/src/lib.rs")).toBe("rust-src");
    expect(pathGroupFor("src/lib.rs")).toBe("rust-src");
    expect(pathGroupFor("crates/maxi-kvm-core/tests/x.rs")).toBe("rust-test");
    expect(pathGroupFor("src/foo_test.rs")).toBe("rust-test");
    expect(pathGroupFor("src/foo.test.rs")).toBe("rust-test");
    expect(pathGroupFor("tests/test_foo.rs")).toBe("rust-test");
  });

  it("recognises the path groups the README documents", () => {
    expect(pathGroupFor(".github/workflows/ci.yml")).toBe("workflows");
    expect(pathGroupFor(".github/dependabot.yml")).toBe("config");
    expect(pathGroupFor("Cargo.lock")).toBe("lockfile");
    expect(pathGroupFor("package-lock.json")).toBe("lockfile");
    expect(pathGroupFor("pnpm-lock.yaml")).toBe("lockfile");
    expect(pathGroupFor("scripts/run.sh")).toBe("shell");
    expect(pathGroupFor("tools/x.bash")).toBe("shell");
    expect(pathGroupFor("Makefile")).toBe("shell");
    expect(pathGroupFor("tools/x.py")).toBe("python");
    expect(pathGroupFor("README.md")).toBe("docs");
  });

  it("falls back to the top-level directory for unknown extensions", () => {
    expect(pathGroupFor("src/foo.ts")).toBe("src");
    expect(pathGroupFor("lib/bar.go")).toBe("lib");
  });

  it("treats an empty path as unknown rather than throwing", () => {
    expect(pathGroupFor("")).toBe("(unknown)");
  });
});

describe("classifyOutcome", () => {
  it("marks a thread as accepted when a later commit touched the same file", () => {
    const outcome = classifyOutcome(
      baseFinding({
        threadResolved: false,
        subsequentTouchedPaths: ["src/a.ts", "src/b.ts"],
      })
    );
    expect(outcome).toBe("accepted");
  });

  it("also accepts when a later commit touched another file in the same path group", () => {
    const outcome = classifyOutcome(
      baseFinding({
        path: "crates/maxi-kvm-core/src/lib.rs",
        subsequentTouchedPaths: ["crates/maxi-kvm-core/src/peer.rs"],
      })
    );
    expect(outcome).toBe("accepted");
  });

  it("marks a resolved thread with no follow-up edit as dismissed", () => {
    const outcome = classifyOutcome(
      baseFinding({
        threadResolved: true,
        subsequentTouchedPaths: [],
      })
    );
    expect(outcome).toBe("dismissed");
  });

  it("marks an open thread with no follow-up edit as unaddressed", () => {
    const outcome = classifyOutcome(
      baseFinding({
        path: "crates/x/src/lib.rs",
        threadResolved: false,
        subsequentTouchedPaths: ["docs/README.md", "scripts/run.sh"],
      })
    );
    expect(outcome).toBe("unaddressed");
  });
});

describe("aggregateReviewerProfiles", () => {
  it("emits the documented schema with all seven bot reviewers seeded to zero", () => {
    const out = aggregateReviewerProfiles([], "2026-09-18T00:00:00.000Z", 30);
    expect(out.schema).toBe("maxi.review.v1.reviewer-profiles");
    expect(out.windowDays).toBe(30);
    expect(out.generatedAt).toBe("2026-09-18T00:00:00.000Z");
    for (const bot of BOT_REVIEWERS) {
      expect(out.reviewers[bot]).toBeDefined();
      expect(out.reviewers[bot].overall).toEqual({
        n: 0,
        acceptRate: 0,
        unknownN: 0,
      });
    }
  });

  it("buckets findings by reviewer and by path group, dropping unknown reviewers", () => {
    const findings = [
      // maxi-reviewer: two findings on rust-src, one accepted (touched), one dismissed (resolved, untouched)
      baseFinding({
        reviewer: "maxi-reviewer",
        path: "crates/maxi-kvm-core/src/lib.rs",
        threadResolved: false,
        subsequentTouchedPaths: ["crates/maxi-kvm-core/src/lib.rs"],
      }),
      baseFinding({
        reviewer: "maxi-reviewer",
        path: "crates/maxi-kvm-core/src/peer.rs",
        threadResolved: true,
        subsequentTouchedPaths: [],
      }),
      // coderabbitai: one finding on workflows, accepted
      baseFinding({
        reviewer: "coderabbitai",
        path: ".github/workflows/ci.yml",
        threadResolved: false,
        subsequentTouchedPaths: [".github/workflows/ci.yml"],
      }),
      // coderabbitai: one finding on workflows, unaddressed (open, no touch)
      baseFinding({
        reviewer: "coderabbitai",
        path: ".github/workflows/calibration-harvest.yml",
        threadResolved: false,
        subsequentTouchedPaths: [],
      }),
      // codacy-production: dismissed on rust-src
      baseFinding({
        reviewer: "codacy-production",
        path: "src/main.rs",
        threadResolved: true,
        subsequentTouchedPaths: [],
      }),
      // unknown bot, should be dropped
      baseFinding({
        reviewer: "maxi-reviewer" as const,
        path: "src/x.ts",
      }),
    ];
    // Force the "unknown bot" path through a type-asserted reviewer name we don't allow.
    (findings[findings.length - 1] as { reviewer: string }).reviewer =
      "rogue-bot";

    const out: ReviewerProfiles = aggregateReviewerProfiles(
      findings as never,
      "2026-09-18T00:00:00.000Z",
      30
    );

    expect(out.reviewers["maxi-reviewer"].overall.n).toBe(2);
    expect(out.reviewers["maxi-reviewer"].overall.acceptRate).toBeCloseTo(0.5);
    const rustSrc = out.reviewers["maxi-reviewer"].byPathGroup["rust-src"];
    expect(rustSrc).toBeDefined();
    expect(rustSrc.n).toBe(2);
    expect(rustSrc.acceptRate).toBeCloseTo(0.5);

    expect(out.reviewers["coderabbitai"].overall.n).toBe(2);
    expect(out.reviewers["coderabbitai"].overall.acceptRate).toBeCloseTo(0.5);
    const workflows = out.reviewers["coderabbitai"].byPathGroup["workflows"];
    expect(workflows.n).toBe(2);
    expect(workflows.acceptRate).toBeCloseTo(0.5);

    expect(out.reviewers["codacy-production"].overall.n).toBe(1);
    expect(out.reviewers["codacy-production"].overall.acceptRate).toBe(0);
    expect(out.reviewers["qltysh"].overall.n).toBe(0);
  });

  it("exposes each reviewer's path-group buckets only for groups with samples", () => {
    const findings = [
      baseFinding({
        reviewer: "maxi-reviewer",
        path: "crates/x/src/lib.rs",
        threadResolved: false,
        subsequentTouchedPaths: ["crates/x/src/lib.rs"],
      }),
    ];
    const out = aggregateReviewerProfiles(
      findings,
      "2026-09-18T00:00:00.000Z",
      30
    );
    expect(out.reviewers["maxi-reviewer"].byPathGroup["rust-src"]?.n).toBe(1);
    expect(
      out.reviewers["maxi-reviewer"].byPathGroup["rust-test"]
    ).toBeUndefined();
  });
});

describe("isBotReviewer", () => {
  it("accepts every login the schema covers", () => {
    for (const login of BOT_REVIEWERS) {
      expect(isBotReviewer(login)).toBe(true);
    }
  });

  it("rejects logins outside the schema", () => {
    expect(isBotReviewer("maxiboch")).toBe(false);
    expect(isBotReviewer("")).toBe(false);
  });
});
