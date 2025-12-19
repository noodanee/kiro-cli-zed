import { PromptRequest } from "@agentclientprotocol/sdk";

export function promptToText(prompt: PromptRequest): string {
  const parts: string[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text":
        parts.push(chunk.text);
        break;
      case "resource_link":
        parts.push(chunk.uri);
        break;
      case "resource":
        if ("text" in chunk.resource) {
          parts.push(`\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`);
        }
        break;
      case "image":
        if (chunk.uri) {
          parts.push(chunk.uri);
        }
        break;
    }
  }

  return parts.join("");
}

