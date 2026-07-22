import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const script = resolve(
  import.meta.dir,
  "../plugins/pi-context-eval/skills/pi-context-eval/scripts/matrix_status.py",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("pi-context-eval matrix status helper", () => {
  test("summarizes classification, judge, and provenance as JSON", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-context-matrix-status-"));
    temporaryDirectories.push(directory);
    await writeFile(
      resolve(directory, "matrix-state.json"),
      JSON.stringify({
        status: "completed",
        matrixRunId: "matrix-1",
        secretSeedSha256: "seed-hash",
        pinnedProvenance: { headSha: "abc123" },
        cells: {
          "model-400k": {
            id: "model-400k",
            status: "completed",
            attempts: 2,
            classification: "certifying_run",
            reason: "observable_coverage_complete",
            reportPath: "/tmp/report.json",
            report: {
              status: "completed",
              sandbox: { formalEvidenceEligible: true },
              lock: { released: true },
              infrastructureInvalid: null,
              runError: null,
              judge: {
                verdict: { overall: { score: 3, modelTier: "strong" } },
              },
            },
          },
        },
      }),
    );

    const result = Bun.spawnSync(["python3", script, "--json", directory]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString()) as {
      status: string;
      headSha: string;
      cells: Array<Record<string, unknown>>;
    };
    expect(output.status).toBe("completed");
    expect(output.headSha).toBe("abc123");
    expect(output.cells).toEqual([
      expect.objectContaining({
        id: "model-400k",
        attempts: 2,
        classification: "certifying_run",
        judgeScore: 3,
        judgeTier: "strong",
        formalEvidenceEligible: true,
        lockReleased: true,
      }),
    ]);
  });

  test("fails clearly when matrix-state.json is missing", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-context-matrix-status-"));
    temporaryDirectories.push(directory);
    const result = Bun.spawnSync(["python3", script, directory]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("matrix state not found");
  });
});
