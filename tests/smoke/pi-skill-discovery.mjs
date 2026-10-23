// Real Pi package discovery: the root manifest must load the harness-neutral
// core by package name and expose the autonomous-delivery skill with no
// collision. Private agent state, no provider and no project mutation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = process.env.SPECFLOW_PI_SDK;
if (!sdkRoot)
  throw new Error(
    "Set SPECFLOW_PI_SDK to an already-installed trusted Pi 1.x package; never auto-install",
  );
const { DefaultResourceLoader, SettingsManager } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/index.js")).href
);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
assert.equal(manifest.private, true);
assert.deepEqual(manifest.pi.extensions, ["./packages/pi/index.ts"]);
assert.deepEqual(manifest.pi.skills, ["./packages/pi/skills"]);
assert.ok(fs.existsSync(path.join(repo, manifest.pi.extensions[0])));
const coreManifest = JSON.parse(
  fs.readFileSync(path.join(repo, "packages/pi/package.json"), "utf8"),
);
assert.equal(coreManifest.dependencies["@nightink/spec-flow-core"], `^${coreManifest.version}`);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-pi-skill-"));
const cwd = path.join(sandbox, "private project"),
  agentDir = path.join(sandbox, "agent");
fs.mkdirSync(cwd);
fs.mkdirSync(agentDir);
try {
  const settings = SettingsManager.inMemory({ packages: [repo] });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  const extension = extensions.extensions.find((entry) =>
    String(entry.sourceInfo?.path ?? entry.path ?? "").endsWith("packages/pi/index.ts"),
  );
  assert.ok(extension, "root manifest extension was not discovered through the pi package");
  const skills = loader.getSkills();
  const skill = skills.skills.find((entry) => entry.name === "autonomous-delivery");
  assert.ok(skill, "package skill was not discovered through the pi manifest");
  assert.equal(
    fs.realpathSync(skill.filePath),
    fs.realpathSync(path.join(repo, "packages/pi/skills/autonomous-delivery/SKILL.md")),
  );
  assert.match(skill.description, /end-to-end/);
  assert.deepEqual(
    skills.diagnostics.filter((entry) => entry.type === "collision"),
    [],
  );
  console.log(
    "PASS root pi manifest discovers packages/pi extension and skill with zero collision",
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
