import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "./streams.ts";
import { KiroAcpAgent } from "./agent.ts";

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

const stream = ndJsonStream(
  nodeToWebWritable(process.stdout),
  nodeToWebReadable(process.stdin),
);
new AgentSideConnection((client) => new KiroAcpAgent(client), stream);

process.stdin.resume();
