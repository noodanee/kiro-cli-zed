import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestError,
  SessionNotification,
  SetSessionModeRequest,
  SetSessionModeResponse,
  CancelNotification,
  SessionModelState,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { runKiroChat } from "./kiro.ts";
import { promptToText } from "./prompt.ts";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const ZED_AGENT_SERVER_ID = "kiro-cli";

type Session = {
  cwd: string;
  started: boolean;
  cancelled: boolean;
  preflightOk: boolean;
  kiroAgent?: string;
  kiroModel?: string;
  kiroDefaultAgent?: string;
  defaultAgentSync: {
    lastAttempt?: string;
    lastOk?: boolean;
  };
  trustAllTools: boolean;
  trustTools?: string;
  wrap: "always" | "never" | "auto";
  verbose: boolean;
  child?: ReturnType<typeof runKiroChat>;
  modes: {
    currentModeId: string;
    availableModes: { id: string; name: string; description?: string }[];
  };
  models: SessionModelState;
};

function envString(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function envBool(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function resolveKiroCli(): string {
  const envPath = envString("KIRO_ACP_KIRO_CLI") ?? envString("KIRO_CLI");
  if (envPath) return envPath;

  const home = os.homedir();
  const candidates = [
    "kiro-cli",
    path.join(home, ".local", "bin", "kiro-cli"),
    "/opt/homebrew/bin/kiro-cli",
    "/usr/local/bin/kiro-cli",
  ];

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // ignore
    }
  }

  return "kiro-cli";
}

type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

async function execCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));

    child.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ code: null, stdout, stderr, error }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function ensureKiroReady(
  session: Session,
  kiroCli: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const who = await execCapture(
    kiroCli,
    ["whoami", "--format", "json"],
    session.cwd,
  );

  if (who.error && who.error.code === "ENOENT") {
    return {
      ok: false,
      message:
        "未找到 `kiro-cli`。请先安装 Kiro CLI：`curl -fsSL https://cli.kiro.dev/install | bash`，或在启动 Zed 前设置环境变量 `KIRO_ACP_KIRO_CLI` 指向你的 `kiro-cli` 路径。",
    };
  }

  if (who.code !== 0) {
    return {
      ok: false,
      message:
        "Kiro CLI 似乎尚未登录。请在外部终端运行 `kiro-cli login`（也可用 `kiro-cli login --license free --social google --use-device-flow`），完成后再回到 Zed 重试。",
    };
  }

  try {
    const parsed = JSON.parse(who.stdout);
    if (
      !parsed ||
      typeof parsed.accountType !== "string" ||
      parsed.accountType.length === 0
    ) {
      return {
        ok: false,
        message:
          "Kiro CLI 登录状态不可用。请在外部终端运行 `kiro-cli login` 完成登录后再重试。",
      };
    }
  } catch {
    return {
      ok: false,
      message:
        "无法解析 `kiro-cli whoami` 输出。请确认已安装并登录 Kiro CLI（`kiro-cli login`），然后重试。",
    };
  }

  session.preflightOk = true;
  return { ok: true };
}

function zedSettingsFilePath(): string {
  const home = os.homedir();

  if (process.platform === "win32") {
    const appData = envString("APPDATA");
    if (appData) return path.join(appData, "Zed", "settings.json");
    return path.join(home, "AppData", "Roaming", "Zed", "settings.json");
  }

  if (process.platform === "linux" || process.platform === "freebsd") {
    const base =
      envString("FLATPAK_XDG_CONFIG_HOME") ??
      envString("XDG_CONFIG_HOME") ??
      path.join(home, ".config");
    return path.join(base, "zed", "settings.json");
  }

  return path.join(home, ".config", "zed", "settings.json");
}

function stripJsonWithComments(source: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escape = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i++;
      continue;
    }

    out += ch;
  }

  return out;
}

function stripTrailingCommas(source: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escape = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j]!)) j++;
      const next = source[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

function zedDefaultMode(agentServerId: string): string | undefined {
  const settingsPath = zedSettingsFilePath();
  let raw = "";
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: any;
  try {
    const cleaned = stripTrailingCommas(stripJsonWithComments(raw));
    parsed = JSON.parse(cleaned);
  } catch {
    return undefined;
  }

  const agentServers = parsed?.agent_servers;
  if (!agentServers || typeof agentServers !== "object") return undefined;
  const entry = agentServers[agentServerId];
  if (!entry || typeof entry !== "object") return undefined;
  const defaultMode = entry.default_mode;
  return typeof defaultMode === "string" && defaultMode.length > 0
    ? defaultMode
    : undefined;
}

async function listKiroAgents(kiroCli: string, cwd: string) {
  return await new Promise<{
    agents: Session["modes"]["availableModes"];
    defaultAgent?: string;
  }>((resolve) => {
    const child = spawn(kiroCli, ["agent", "list"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
    });

    child.on("error", () => resolve({ agents: [], defaultAgent: undefined }));

    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (out += d));
    child.on("close", () => {
      const lines = out
        .split(/\r?\n/)
        .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trim())
        .filter(Boolean);

      const agents: Session["modes"]["availableModes"] = [];
      let defaultAgent: string | undefined;

      for (const line of lines) {
        const isDefault = line.startsWith("*");
        const rest = isDefault ? line.slice(1).trimStart() : line;
        const [name, ...tail] = rest.split(/\s+/);
        if (!name) continue;
        if (isDefault) defaultAgent = name;
        agents.push({
          id: name,
          name,
          description: tail.length > 0 ? tail.join(" ") : undefined,
        });
      }

      resolve({ agents, defaultAgent });
    });
  });
}

async function syncKiroDefaultAgent(
  session: Session,
  kiroCli: string,
): Promise<void> {
  const desired = zedDefaultMode(ZED_AGENT_SERVER_ID);
  if (!desired || desired === "default") return;

  if (
    session.defaultAgentSync.lastAttempt === desired &&
    session.defaultAgentSync.lastOk === false
  )
    return;
  if (session.kiroDefaultAgent === desired) return;

  const result = await execCapture(
    kiroCli,
    ["agent", "set-default", "-n", desired],
    session.cwd,
  );
  const ok = result.code === 0;
  session.defaultAgentSync = { lastAttempt: desired, lastOk: ok };
  if (ok) session.kiroDefaultAgent = desired;
}

export class KiroAcpAgent implements Agent {
  private client: AgentSideConnection;
  private sessions: Record<string, Session> = {};

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          embeddedContext: true,
          image: false,
        },
        sessionCapabilities: {},
      },
      agentInfo: {
        name: "kiro-cli-acp",
        title: "Kiro CLI",
        version: "0.0.1",
      },
      authMethods: [
        {
          id: "kiro-cli-login",
          name: "Log in with Kiro CLI",
          description: "在终端运行 `kiro-cli login` 完成登录",
        },
      ],
    };
  }

  async authenticate(_request: AuthenticateRequest): Promise<void> {
    throw RequestError.internalError(
      undefined,
      "请在外部终端运行 `kiro-cli login` 完成登录后再重试。",
    );
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomUUID();
    const kiroCli = resolveKiroCli();

    const { agents, defaultAgent } = await listKiroAgents(kiroCli, params.cwd);
    const requested = envString("KIRO_ACP_AGENT");
    const preferred =
      requested && requested !== "default"
        ? requested
        : (zedDefaultMode(ZED_AGENT_SERVER_ID) ??
          defaultAgent ??
          agents[0]?.id ??
          "default");

    const modes: Session["modes"] = {
      currentModeId: preferred,
      availableModes:
        agents.length > 0 ? agents : [{ id: "default", name: "default" }],
    };

    if (
      preferred &&
      preferred !== "default" &&
      !modes.availableModes.some((m) => m.id === preferred)
    ) {
      modes.availableModes.push({
        id: preferred,
        name: preferred,
        description: "From settings",
      });
    }

    const model = envString("KIRO_ACP_MODEL") ?? "auto";
    const models: SessionModelState = {
      currentModelId: model,
      availableModels: [
        {
          modelId: "auto",
          name: "Auto",
          description:
            "Models chosen by task for optimal usage and consistent quality",
        },
        {
          modelId: "claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          description: "The latest Claude Sonnet model",
        },
        {
          modelId: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          description: "Hybrid reasoning and coding for regular use",
        },
        {
          modelId: "claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          description: "The latest Claude Haiku model",
        },
        {
          modelId: "claude-opus-4.5",
          name: "Claude Opus 4.5",
          description: "The latest Claude Opus model",
        },
      ],
    };

    const verboseEnv = envString("KIRO_ACP_VERBOSE");

    this.sessions[sessionId] = {
      cwd: params.cwd,
      started: false,
      cancelled: false,
      preflightOk: false,
      trustAllTools: envBool("KIRO_ACP_TRUST_ALL_TOOLS"),
      trustTools: envString("KIRO_ACP_TRUST_TOOLS"),
      wrap: (envString("KIRO_ACP_WRAP") as any) ?? "auto",
      verbose: verboseEnv ? envBool("KIRO_ACP_VERBOSE") : true,
      modes,
      models,
      kiroDefaultAgent: defaultAgent,
      defaultAgentSync: {},
    };

    return {
      sessionId,
      modes,
      models,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) throw new Error("Session not found");

    session.cancelled = false;

    const kiroCli = resolveKiroCli();
    const input = promptToText(params);
    const resume = session.started;

    let sentAny = false;
    let sendChain = Promise.resolve();

    const sendUpdate = (update: SessionNotification["update"]) => {
      if (session.cancelled) return sendChain;
      sentAny = true;
      sendChain = sendChain
        .then(() =>
          this.client.sessionUpdate({
            sessionId: params.sessionId,
            update,
          }),
        )
        .catch(() => {});
      return sendChain;
    };

    const sendText = (text: string) =>
      sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });

    const sendThought = (text: string) =>
      sendUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      });

    const toolStartRe =
      /^I will run the following command:\s*(.+?)\s*\(using tool:\s*([^)]+)\)\s*$/;
    const toolDoneRe = /- Completed in /;
    const thoughtPrefixes = [
      "Thought:",
      "Reasoning:",
      "Chain of Thought:",
      "Chain-of-thought:",
      "Scratchpad:",
    ];

    let toolSeq = 0;
    let activeTool:
      | {
          id: string;
          kind: "execute" | "other";
          title: string;
          rawInput: string;
          output: string[];
        }
      | null = null;
    let lineBuffer = "";

    const toolContent = () => {
      if (!activeTool || activeTool.output.length === 0) return undefined;
      return [
        {
          type: "content",
          content: { type: "text", text: activeTool.output.join("\n") },
        },
      ];
    };

    const sendToolCall = () => {
      if (!activeTool) return;
      void sendUpdate({
        sessionUpdate: "tool_call",
        toolCall: {
          toolCallId: activeTool.id,
          title: activeTool.title,
          kind: activeTool.kind,
          status: "in_progress",
          rawInput: activeTool.rawInput,
        },
      });
    };

    const sendToolUpdate = (status?: "in_progress" | "completed" | "failed") => {
      if (!activeTool) return;
      const update: {
        toolCallId: string;
        status?: "in_progress" | "completed" | "failed";
        content?: { type: "content"; content: { type: "text"; text: string } }[];
        rawOutput?: string;
      } = { toolCallId: activeTool.id };
      if (status) update.status = status;
      const content = toolContent();
      if (content) update.content = content;
      if (activeTool.output.length > 0) {
        update.rawOutput = activeTool.output.join("\n");
      }
      void sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCall: update,
      });
    };

    const handleLine = (line: string) => {
      const toolMatch = line.match(toolStartRe);
      if (toolMatch) {
        if (activeTool) {
          sendToolUpdate("completed");
        }
        const command = toolMatch[1].trim();
        const toolName = toolMatch[2].trim();
        const id = `tool-${Date.now()}-${++toolSeq}`;
        const kind = toolName === "shell" ? "execute" : "other";
        activeTool = {
          id,
          kind,
          title: toolName ? `${toolName}: ${command}` : command,
          rawInput: command,
          output: [],
        };
        sendToolCall();
        return;
      }

      if (activeTool) {
        if (toolDoneRe.test(line)) {
          sendToolUpdate("completed");
          activeTool = null;
          return;
        }
        activeTool.output.push(line);
        sendToolUpdate("in_progress");
        return;
      }

      for (const prefix of thoughtPrefixes) {
        if (line.startsWith(prefix)) {
          void sendThought(`${line}\n`);
          return;
        }
      }

      void sendText(`${line}\n`);
    };

    const handleChunk = (text: string) => {
      lineBuffer += text;
      const parts = lineBuffer.split(/\r\n|\r|\n/);
      lineBuffer = parts.pop() ?? "";
      for (const part of parts) {
        handleLine(part);
      }
    };

    if (!session.preflightOk) {
      const ready = await ensureKiroReady(session, kiroCli);
      if (!ready.ok) {
        await sendText(ready.message);
        return { stopReason: "end_turn" };
      }
    }

    await syncKiroDefaultAgent(session, kiroCli);

    const child = runKiroChat(
      {
        kiroCli,
        cwd: session.cwd,
        input,
        agent:
          session.modes.currentModeId === "default"
            ? undefined
            : session.modes.currentModeId,
        model:
          session.models.currentModelId === "auto"
            ? undefined
            : session.models.currentModelId,
        resume,
        verbose: session.verbose,
        trustAllTools: session.trustAllTools,
        trustTools: session.trustTools,
        wrap: session.wrap,
      },
      (event) => {
        if (event.type === "chunk") {
          handleChunk(event.text);
        }
      },
    );

    session.child = child;

    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    session.child = undefined;
    if (lineBuffer.length > 0) {
      handleLine(lineBuffer);
      lineBuffer = "";
    }
    if (activeTool) {
      sendToolUpdate(exit.code === 0 ? "completed" : "failed");
      activeTool = null;
    }
    await sendChain;

    if (session.cancelled) return { stopReason: "cancelled" };

    if (!sentAny && exit.code !== 0) {
      throw RequestError.internalError(
        undefined,
        `kiro-cli exited with code ${exit.code ?? "?"}`,
      );
    }

    if (exit.code !== 0) {
      await sendText(`\n(kiro-cli 退出码: ${exit.code ?? "?"})\n`);
    }

    session.started = true;
    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) throw new Error("Session not found");
    session.cancelled = true;
    session.child?.kill("SIGINT");
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) throw new Error("Session not found");

    const exists = session.modes.availableModes.some(
      (m) => m.id === params.modeId,
    );
    if (!exists) throw new Error("Invalid mode");

    session.modes.currentModeId = params.modeId;

    if (
      zedDefaultMode(ZED_AGENT_SERVER_ID) === params.modeId &&
      session.kiroDefaultAgent !== params.modeId
    ) {
      void syncKiroDefaultAgent(session, resolveKiroCli());
    }

    await this.client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      },
    });

    return {};
  }

  async setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) throw new Error("Session not found");

    const exists = session.models.availableModels.some(
      (m) => m.modelId === params.modelId,
    );
    if (!exists) throw new Error("Invalid model");

    session.models.currentModelId = params.modelId;

    return {};
  }
}
