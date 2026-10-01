// SPIKE suite (branch vscode-sidebar-spike): runs INSIDE the real VS Code that scripts/sidebar-spike.ts
// launches. It does nothing on its own beyond waiting for the extension to connect; the harness drives
// it through a control directory — `cmd-<n>.json` {command, args} in, `ack-<n>.json` {ok, result|error}
// out — so the harness can interleave editor commands with its own screenshots and CDP probes.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as vscode from "vscode"
import type { FrizzExtensionApi } from "../src/app.ts"

const control = process.env.FRIZZ_SPIKE_CONTROL ?? ""

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<FrizzExtensionApi>("ssalbdivad.frizz-vscode")
  if (!extension) throw new Error("the extension under development is not installed")
  const api = await extension.activate()
  const deadline = Date.now() + 60_000
  while (api.status().kind !== "connected" || api.projects().length === 0) {
    if (Date.now() > deadline) throw new Error(`never connected: ${JSON.stringify(api.status())}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  writeFileSync(join(control, "ready.json"), JSON.stringify({ origin: api.origin(), projects: api.projects() }))
  for (let seq = 1; ; seq++) {
    const file = join(control, `cmd-${seq}.json`)
    const hardStop = Date.now() + 900_000
    while (!existsSync(file)) {
      if (Date.now() > hardStop) throw new Error(`no command ${seq} within 15m`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const { command, args = [] } = JSON.parse(readFileSync(file, "utf8")) as { command: string; args?: unknown[] }
    if (command === "__done") return
    try {
      const result = await vscode.commands.executeCommand(command, ...args)
      writeFileSync(join(control, `ack-${seq}.json`), JSON.stringify({ ok: true, result: result ?? null }))
    } catch (error) {
      writeFileSync(join(control, `ack-${seq}.json`), JSON.stringify({ ok: false, error: String(error) }))
    }
  }
}
