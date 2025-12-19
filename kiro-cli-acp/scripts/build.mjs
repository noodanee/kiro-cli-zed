import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });

const outFile = new URL("../dist/kiro-cli-acp", import.meta.url);

await build({
  entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: outFile.pathname,
  banner: {
    js: "#!/usr/bin/env node",
  },
});

await chmod(outFile, 0o755);

