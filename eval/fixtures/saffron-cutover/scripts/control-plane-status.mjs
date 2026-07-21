import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = join(import.meta.dirname, "..", "fixtures", "control-plane.json");
const state = JSON.parse(readFileSync(fixture, "utf8"));
process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
