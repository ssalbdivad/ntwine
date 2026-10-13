// A WORKER'S `editor` TOOL, CALLED FOR REAL — one `tools/call editor` on the real cc-worker/bin/ntwine-mcp.mjs,
// spawned the way an Ntwine worker of `projectId` runs it and finding the server by its lock, so what comes
// back is exactly what an agent reads. Shared by the suite (e2e/suite.ts, inside VS Code, --stack mode)
// and the real-page sidebar run (scripts/e2e-sidebar.ts, in the harness).

import { spawn } from "node:child_process"

export interface WorkerToolOptions {
  /** The node binary to run the MCP server with. */
  node: string
  /** cc-worker/bin/ntwine-mcp.mjs. */
  mcp: string
  /** The server lock a worker's MCP server finds Ntwine by (NTWINE_SERVER_LOCK). */
  serverLock: string
  /** The project the worker belongs to (NTWINE_PROJECT_ID): the tool reads that project's editor windows. */
  projectId: string
  home?: string
}

type Reply = { id: number; result?: { content: { text: string }[] } }

/** The tool's text, as the agent reads it. */
export async function workerTool(options: WorkerToolOptions): Promise<string> {
  const child = spawn(options.node, [options.mcp], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "", HOME: options.home ?? process.env.HOME ?? "", NTWINE_PROJECT_ID: options.projectId, NTWINE_SERVER_LOCK: options.serverLock },
  })
  try {
    let buffer = ""
    const replies = new Map<number, (reply: Reply) => void>()
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const reply = JSON.parse(line) as Reply
        replies.get(reply.id)?.(reply)
      }
    })
    const request = (id: number, method: string, params: unknown) => new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ntwine-mcp did not answer ${method}`)), 20_000)
      replies.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
    await request(1, "initialize", { protocolVersion: "2025-06-18" })
    const reply = await request(2, "tools/call", { name: "editor", arguments: {} })
    return reply.result?.content[0]?.text ?? JSON.stringify(reply)
  } finally {
    child.kill()
  }
}
