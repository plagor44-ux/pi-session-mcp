import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { temporaryRoot, removeTemporaryRoots } from "./temporary-roots.js";
afterAll(removeTemporaryRoots);
async function checks(document: unknown) {
  const root = await temporaryRoot("doctor-routing-"); const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ workspaces: { repo: root }, executionProfiles: { safe: { default: true, permissionProfile: "read-only", provider: "fake", model: "fake", thinkingLevel: "off" } } }));
  await writeFile(join(root, "routing.json"), JSON.stringify(document));
  return (await runDoctor({ configPath: path, home: root, writerLeaseRoot: async () => undefined })).checks;
}
it("reports routing_config_invalid for an unknown alias", async () => { expect(await checks({ mode: "manual", tiers: { medium: { review: ["gone"] } }, families: { gone: "one" } })).toContainEqual(expect.objectContaining({ id: "routing_config_invalid", severity: "error" })); });
it("reports routing_history_required for auto without history", async () => { expect(await checks({ mode: "auto" })).toContainEqual(expect.objectContaining({ id: "routing_history_required", severity: "error" })); });
it("warns routing_single_family", async () => { expect(await checks({ mode: "manual", tiers: { medium: { review: ["safe"] } }, families: { safe: "one" } })).toContainEqual(expect.objectContaining({ id: "routing_single_family", severity: "warning" })); });
