import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

function zedTarget() {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : null;

  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;

  if (!os || !arch) {
    throw new Error(`unsupported platform: ${process.platform} ${process.arch}`);
  }

  return `${os}-${arch}`;
}

const root = path.resolve(new URL("..", import.meta.url).pathname);
const extensionRoot = path.resolve(root, "..");

const target = zedTarget();
const outDir = path.join(extensionRoot, "dist");
const stagingDir = path.join(outDir, `staging-${target}`);
const outFile = path.join(outDir, `kiro-cli-acp-${target}.tar.gz`);

await mkdir(outDir, { recursive: true });
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

await copyFile(path.join(root, "dist", "kiro-cli-acp"), path.join(stagingDir, "kiro-cli-acp"));
await writeFile(path.join(stagingDir, "package.json"), "{\"type\":\"module\"}\n");

await execFileAsync("tar", ["-czf", outFile, "-C", stagingDir, "kiro-cli-acp", "package.json"]);

const bytes = await readFile(outFile);
const sha256 = createHash("sha256").update(bytes).digest("hex");

process.stdout.write(`${outFile}\nsha256=${sha256}\n`);
