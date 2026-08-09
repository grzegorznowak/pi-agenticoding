import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runNpmWithRetry } from "./compat-process.mjs";

export const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

export function createCompatCopy(root, prefix) {
  const temp = mkdtempSync(join(tmpdir(), prefix));
  const copy = join(temp, "source");
  cpSync(root, copy, {
    recursive: true,
    filter: (source) => ![".git", "node_modules", "openspec"].includes(basename(source)),
  });
  return { temp, copy };
}

export function prepareCompatCopy(copy) {
  rmSync(join(copy, "package-lock.json"), { force: true });
  const packagePath = join(copy, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.scripts) delete packageJson.scripts.prepare;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

/** Resolve one current Pi release and the exact TypeBox version it requires. */
export async function resolveLatestPi(copy) {
  const piVersion = JSON.parse((await runNpmWithRetry(copy, [
    "view", "@earendil-works/pi-coding-agent@latest", "version", "--json",
  ], { capture: true })).stdout);
  const typeboxVersion = JSON.parse((await runNpmWithRetry(copy, [
    "view", `@earendil-works/pi-coding-agent@${piVersion}`, "dependencies.typebox", "--json",
  ], { capture: true })).stdout);
  if (typeof piVersion !== "string" || !piVersion || typeof typeboxVersion !== "string" || !typeboxVersion) {
    throw new Error("Latest Pi coding-agent did not declare usable Pi and TypeBox versions");
  }
  return { piVersion, typeboxVersion };
}

export function latestPiDependencies({ piVersion, typeboxVersion }) {
  return Object.fromEntries([
    ...PI_PACKAGES.map((name) => [name, piVersion]),
    ["typebox", typeboxVersion],
  ]);
}

/** Write failure diagnostics to artifact directory if configured. */
export function writeCompatDiagnostics(artifactDir, sourceDir, error) {
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  const packageLock = join(sourceDir, "package-lock.json");
  if (existsSync(packageLock)) copyFileSync(packageLock, join(artifactDir, "package-lock.json"));
  writeFileSync(join(artifactDir, "failure.txt"), String(error));
}
