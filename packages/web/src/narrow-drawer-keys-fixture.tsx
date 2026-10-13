import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { DrawerStack } from "./components/DrawerStack.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { Dialog } from "./components/ui/Dialog.tsx"
import { registerQueueCursor, useShortcutListener } from "./lib/keyboardRuntime.ts"
import { pushDrawer } from "./store.ts"
import { initFont } from "./lib/font.ts"
import "./styles.css"

// Plain keys over an open thread drawer, at whatever width the test sets: the REAL keyboard runtime's
// listener, the REAL drawer stack with a thread sheet (a modal Radix dialog below 800px — the case that
// swallowed every key), and a real ui/Dialog the test can raise over it as a genuine overlay. The thread
// has no board behind it and shows its loading state; only its Radix layer matters here. The queue
// cursor stands in for the Everything page's, and records where `j` / `k` took it.
initFont()
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!new URL(href, location.href).pathname.startsWith("/_ntwine/rpc/")) return nativeFetch(input, init)
  return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
}

const cards = ["card-a", "card-b", "card-c"]
let current = cards[0]
const landed: string[] = []
registerQueueCursor({
  keys: () => cards,
  current: () => current,
  root: () => null,
  go: (key) => {
    current = key
    landed.push(key)
  },
})

let raise: (open: boolean) => void = () => {}
;(window as unknown as { __narrowDrawerKeys: unknown }).__narrowDrawerKeys = {
  landed: () => [...landed],
  openDialog: () => raise(true),
}

pushDrawer("thread", "fixture-thread", { routed: true })

function Fixture() {
  useShortcutListener()
  const [dialog, setDialog] = useState(false)
  raise = setDialog
  return (
    <>
      <main className="min-h-screen bg-bg p-5 text-fg">The board behind the thread.</main>
      <DrawerStack />
      <Dialog open={dialog} onOpenChange={setDialog} title="A genuine overlay">
        <p className="p-4">Plain keys belong to this dialog while it is open.</p>
      </Dialog>
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
