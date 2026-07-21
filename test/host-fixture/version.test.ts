import { expect, test } from "bun:test";
import metadata from "./.acm-build/host-packages.json";

test("fixture resolves the exact supported Pi host", () => {
  expect(metadata.supportedVersion).toBe("0.81.1");
  expect(metadata.resolvedPackages).toHaveLength(4);
  expect(metadata.resolvedPackages.every((entry) => entry.version === "0.81.1")).toBe(true);
});
