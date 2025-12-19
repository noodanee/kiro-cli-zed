import { spawn } from "node:child_process";
import { stripAnsi } from "./ansi.ts";

export type KiroChatConfig = {
  kiroCli: string;
  cwd: string;
  input: string;
  agent?: string;
  model?: string;
  resume: boolean;
  verbose: boolean;
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
  if (config.verbose) args.push("-v");
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
  let preludeIndex = 0;

  const shouldEmitPreludeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("Running tool ")) return true;
    if (
      trimmed.startsWith("- Completed in") ||
      trimmed.startsWith("- Failed in")
    )
      return true;
    if (/\b(ERROR|WARN|WARNING)\b/.test(trimmed)) return true;
    return false;
  };

  const emitPreludeLines = (limit: number, flush: boolean) => {
    if (limit <= preludeIndex) return;
    const slice = cleanStdout.slice(preludeIndex, limit);
    const end = flush ? slice.length : slice.lastIndexOf("\n") + 1;
    if (end <= 0) return;
    const chunk = slice.slice(0, end);
    preludeIndex += end;
    const lines = chunk.split(/\r?\n/);
    for (const line of lines) {
      if (!shouldEmitPreludeLine(line)) continue;
      const text = line.trimEnd();
      if (text.length === 0) continue;
      onEvent({ type: "chunk", text: `${text}\n` });
    }
  };

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

      const preludeLimit = markerPos === -1 ? cleanStdout.length : markerPos;
      emitPreludeLines(preludeLimit, isFinal || markerPos !== -1);

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

  let stderrBuffer = "";
  const processStderr = (rawChunk: string, isFinal: boolean) => {
    if (rawChunk.length > 0) stderrBuffer += stripAnsi(rawChunk);
    const parts = stderrBuffer.split(/\r?\n/);
    if (!isFinal) {
      stderrBuffer = parts.pop() ?? "";
    } else {
      stderrBuffer = "";
    }
    for (const line of parts) {
      if (!shouldEmitPreludeLine(line)) continue;
      const text = line.trimEnd();
      if (text.length === 0) continue;
      onEvent({ type: "chunk", text: `${text}\n` });
    }
    if (isFinal && stderrBuffer.length > 0) {
      const text = stderrBuffer.trimEnd();
      if (text.length > 0 && shouldEmitPreludeLine(text)) {
        onEvent({ type: "chunk", text: `${text}\n` });
      }
    }
  };

  child.on("close", (code, signal) => {
    processStdout("", true);
    processStderr("", true);

    if (!emitting) {
      const cleaned = cleanStdout.trimEnd();
      if (cleaned.trim().length > 0) onEvent({ type: "chunk", text: cleaned });
    }
    onEvent({ type: "exit", code, signal, rawStdout });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    processStderr(data, false);
  });

  return child;
}
