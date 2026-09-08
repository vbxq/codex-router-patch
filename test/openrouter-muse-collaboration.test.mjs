import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_BY_SLUG } from "../src/model-registry.mjs";

test("OpenRouter Muse Spark 1.3 Contributor publishes native collaboration", () => {
  const model = MODEL_BY_SLUG.get("openrouter/muse-spark-1.3-contributor");
  assert.ok(model, "the OpenRouter Muse route must be registered");
  assert.equal(model.multiAgentVersion, "v2");
  assert.equal(model.supportsParallelToolCalls, true);
});
