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

  let rawStdout = "";
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const REDACT_KEYS = [
    "thought",
    "analysis",
    "reasoning",
    "chain_of_thought",
    "scratchpad",
  ];

  const redactLine = (line: string) => {
    let next = line;
    for (const key of REDACT_KEYS) {
      const token = `"${key}"`;
      const tokenIndex = next.indexOf(token);
      if (tokenIndex === -1) continue;
      const colonIndex = next.indexOf(":", tokenIndex + token.length);
      if (colonIndex === -1) continue;
      const after = next.slice(colonIndex + 1);
      const wsPrefix = after.match(/^\s*/)?.[0] ?? "";
      const wsSuffix = after.match(/\s*$/)?.[0] ?? "";
      const trimmed = after.trimEnd();
      const hasComma = trimmed.endsWith(",");
      const comma = hasComma ? "," : "";
      next = `${next.slice(0, colonIndex + 1)}${wsPrefix}"[redacted]"${comma}${wsSuffix}`;
      break;
    }
    return next;
  };

  const processChunk = (rawChunk: string, isFinal: boolean, buffer: string) => {
    const cleaned = stripAnsi(rawChunk);
    const combined = buffer + cleaned;
    const endsWithNewline = /\r?\n$/.test(combined);
    const parts = combined.split(/\r?\n/);
    let nextBuffer = buffer;
    if (!endsWithNewline) {
      nextBuffer = parts.pop() ?? "";
    } else {
      parts.pop();
      nextBuffer = "";
    }
    for (const line of parts) {
      onEvent({ type: "chunk", text: `${redactLine(line)}\n` });
    }
    if (isFinal && nextBuffer.length > 0) {
      onEvent({ type: "chunk", text: redactLine(nextBuffer) });
      nextBuffer = "";
    }
    return nextBuffer;
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    rawStdout += data;
    stdoutBuffer = processChunk(data, false, stdoutBuffer);
  });

  child.on("close", (code, signal) => {
    stdoutBuffer = processChunk("", true, stdoutBuffer);
    stderrBuffer = processChunk("", true, stderrBuffer);
    onEvent({ type: "exit", code, signal, rawStdout });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderrBuffer = processChunk(data, false, stderrBuffer);
  });

  return child;
}
