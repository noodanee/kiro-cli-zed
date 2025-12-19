import { spawn } from "node:child_process";
import { stripAnsi } from "./ansi.ts";

export type KiroChatConfig = {
  kiroCli: string;
  cwd: string;
  input: string;
  agent?: string;
  model?: string;
  resume: boolean;
  trustAllTools: boolean;
  trustTools?: string;
  wrap: "always" | "never" | "auto";
  env?: Record<string, string | undefined>;
};

export type KiroChatStreamEvent =
  | { type: "chunk"; text: string }
  | {
      type: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
      rawStdout: string;
    };

export function runKiroChat(
  config: KiroChatConfig,
  onEvent: (e: KiroChatStreamEvent) => void,
) {
  const args: string[] = ["chat", "--no-interactive", "--wrap", config.wrap];
  if (config.resume) args.push("--resume");
  if (config.agent) args.push("--agent", config.agent);
  if (config.model) args.push("--model", config.model);
  if (config.trustAllTools) args.push("--trust-all-tools");
  else if (config.trustTools !== undefined)
    args.push(`--trust-tools=${config.trustTools}`);
  args.push(config.input);

  const child = spawn(config.kiroCli, args, {
    cwd: config.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TERM: "dumb",
      NO_COLOR: "1",
      ...config.env,
    },
  });

  const CARRY_BYTES = 64;

  let rawStdout = "";
  let rawCarry = "";
  let cleanStdout = "";
  let emitting = false;
  let emitCleanIndex = 0;

  const processStdout = (rawChunk: string, isFinal: boolean) => {
    rawStdout += rawChunk;

    rawCarry += rawChunk;
    const processUpto = isFinal
      ? rawCarry.length
      : Math.max(0, rawCarry.length - CARRY_BYTES);
    const rawToProcess = rawCarry.slice(0, processUpto);
    rawCarry = rawCarry.slice(processUpto);

    if (rawToProcess.length === 0) return;
    cleanStdout += stripAnsi(rawToProcess);

    if (!emitting) {
      let markerPos = -1;
      if (cleanStdout.startsWith("> ")) {
        markerPos = 0;
      } else {
        const idx = cleanStdout.indexOf("\n> ");
        if (idx !== -1) markerPos = idx + 1;
      }

      if (markerPos !== -1) {
        emitting = true;
        emitCleanIndex = markerPos + 2;
      }
    }

    if (emitting) {
      const next = cleanStdout.slice(emitCleanIndex);
      emitCleanIndex = cleanStdout.length;
      if (next.length > 0) onEvent({ type: "chunk", text: next });
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    processStdout(data, false);
  });

  child.on("close", (code, signal) => {
    processStdout("", true);

    if (!emitting) {
      const cleaned = cleanStdout.trimEnd();
      if (cleaned.trim().length > 0) onEvent({ type: "chunk", text: cleaned });
    }
    onEvent({ type: "exit", code, signal, rawStdout });
  });

  child.stderr.on("data", () => {});

  return child;
}
