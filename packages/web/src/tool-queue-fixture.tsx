import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import type { ChatMessage } from "./hooks.ts"
import { Message, ThreadSlugContext } from "./components/ChatView.tsx"
import { store } from "./store.ts"
import "./styles.css"

// A TaskStop issued in the same assistant message as a foreground gate (session fe5967ef, 2026-10-02):
// it waits for the gate, so its card reads "queued" with no clock and no live mark, and once it runs or
// settles it reads its own time, not the gate's (lib/toolQueue.ts). The codex row is the negative
// control: codex runs a turn's calls side by side, so the same shape reads "running" there.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const gate = "nub run typecheck 2>&1 | tail -3 && nub --test src/remote-setup.test.ts 2>&1 | grep -E \"^ℹ (pass|fail)\""
const thread = (id: string, backend: ThreadView["backend"]) => ({ id, title: id, status: "active", runtime: "running", backend, agents: [], errors: [], warnings: [], dependsOn: [], externalDeps: [] }) as unknown as ThreadView
store.board = { threads: [thread("claude-thread", "claude"), thread("codex-thread", "codex")] } as BoardSnapshot

function msg(id: string, tools: ChatMessage["tools"], at: string): ChatMessage {
  return { sourceId: id, role: "assistant", text: "", tools, at, parts: [{ kind: "tools", tools }] }
}
const live = (): ChatMessage["tools"] => [
  { name: "Bash", detail: "Typechecking and testing the merged main", desc: "Typechecking and testing the merged main", command: gate, status: "pending" },
  { name: "TaskStop", detail: "b1v3dncr6", input: "{\n  \"task_id\": \"b1v3dncr6\"\n}", status: "pending" },
]
const states: { label: string; slug: string; m: ChatMessage }[] = [
  { label: "Queued behind the gate", slug: "claude-thread", m: msg("live", live(), ago(296_000)) },
  {
    label: "Running after the gate returned",
    slug: "claude-thread",
    m: msg("after", [{ ...live()[0], status: "completed", durationMs: 383_538 }, live()[1]], ago(389_000)),
  },
  {
    label: "Settled",
    slug: "claude-thread",
    m: msg("settled", [{ ...live()[0], status: "completed", durationMs: 383_538 }, { ...live()[1], status: "completed", durationMs: 384_421, output: "Successfully stopped task: b1v3dncr6" }], ago(400_000)),
  },
  { label: "Codex: side by side, so not queued", slug: "codex-thread", m: msg("codex", live(), ago(296_000)) },
]

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <main className="mx-auto flex max-w-[760px] flex-col gap-6 p-6">
      {states.map((s) => (
        <section key={s.label} data-state={s.m.sourceId} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{s.label}</h2>
          <ThreadSlugContext.Provider value={s.slug}>
            <Message m={s.m} />
          </ThreadSlugContext.Provider>
        </section>
      ))}
    </main>
  </QueryClientProvider>,
)
