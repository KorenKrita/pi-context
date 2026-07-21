import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function createModelRegistry(tempDir: string): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    authPath: join(tempDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}
