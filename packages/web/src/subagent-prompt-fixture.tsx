import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot } from "@ntwine/shared"
import { ToolCardRouter, ThreadSlugContext } from "./components/ChatView.tsx"
import { store } from "./store.ts"
import "./styles.css"

store.board = { projectDir: "/fixture/ntwine", threads: [] } as unknown as BoardSnapshot
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const prompt = "Inspect the resolver.\n\nReport the failing case."
const calls = [
  { name: "Agent", detail: "Review the resolver", prompt },
  { name: "Spawn agent", detail: "Review the resolver", prompt },
  { name: "Spawn agent", detail: "Encrypted prompt" },
  { name: "Spawn agent", detail: "Long prompt", prompt: Array.from({ length: 20 }, (_, i) => `Instruction ${i + 1}`).join("\n") },
]

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThreadSlugContext.Provider value="prompt-fixture">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-5">
        {calls.map((call, i) => (
          <section key={i} data-prompt-case={i}>
            <ToolCardRouter t={{
              ...call,
              count: 1,
              agentId: `dispatch-${i}`,
              subagentType: "gpt-5.6-terra/medium",
              status: "completed",
              durationMs: 1000,
              // Deliberately present: neither legacy input nor output may leak into the disclosure.
              input: '{"fork_turns":"none","service_tier":"priority"}',
              output: '{"agent_id":"child","agent_name":"/root/reviewer"}',
            }} />
          </section>
        ))}
      </main>
    </ThreadSlugContext.Provider>
  </QueryClientProvider>,
)
