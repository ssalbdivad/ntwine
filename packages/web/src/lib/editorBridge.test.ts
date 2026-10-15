import assert from "node:assert/strict"
import test from "node:test"
import type { BoardSnapshot } from "@ntwine/shared"
import { resetProjectState, store } from "../store.ts"
import { draftKey, draftStore } from "./drafts.ts"
import { composeInto, sendCodeFilesTo, threadInFront } from "./editorBridge.ts"
import { splitComposerValue } from "./imagePaths.ts"
import { stagedItems } from "./stagedContext.ts"

function at<T>(pathname: string, run: () => T): T {
  const previous = globalThis.location
  globalThis.location = { pathname, search: "", origin: "http://127.0.0.1:4100" } as unknown as Location
  try {
    return run()
  } finally {
    globalThis.location = previous
  }
}

// The thread in front is the TOP thread drawer's, whatever the address says: a layer stacked over it (a
// sub-agent, a file) still leaves that thread the one being read, and a closing drawer is not in front.
test("the thread in front is the top thread drawer's", () => {
  resetProjectState()
  store.board = { threads: [{ id: "fix-auth", sessionId: "s1" }, { id: "port", sessionId: "s2" }] } as unknown as BoardSnapshot
  try {
    // The board, with no drawer open: no thread in front.
    assert.equal(at("/", threadInFront), undefined)
    store.drawers = [{ id: 1, kind: "thread", slug: "port" }, { id: 2, kind: "thread", slug: "fix-auth" }, { id: 3, kind: "file", slug: "fix-auth", path: "/r/a.ts" }]
    assert.deepEqual(at("/all/nub/thread/fix-auth", threadInFront), { slug: "fix-auth", sessionId: "s1" })
    store.drawers = [{ id: 1, kind: "thread", slug: "port" }, { id: 2, kind: "thread", slug: "fix-auth", closing: true }]
    assert.deepEqual(at("/all/nub/thread/port", threadInFront), { slug: "port", sessionId: "s2" })
    // A thread the board does not have is no target.
    store.drawers = [{ id: 1, kind: "thread", slug: "elsewhere" }]
    assert.equal(at("/all/nub/thread/elsewhere", threadInFront), undefined)
  } finally {
    resetProjectState()
  }
})

const settings = { localFileOpener: "system" }

async function withFetch(answer: (url: string, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<void>): Promise<string[]> {
  const original = globalThis.fetch
  const previous = globalThis.location
  const calls: string[] = []
  globalThis.location = { pathname: "/", search: "", origin: "http://127.0.0.1:4100" } as unknown as Location
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    return answer(url, init)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
    globalThis.location = previous
  }
  return calls
}

// The procedure a request names: the last segment of its path, whatever prefix the page's apiBase gave it
// (a query is an absolute URL with `?input=`, a mutation a bare path).
const procedure = (url: string) => url.replace(/[?#].*$/u, "").split("/").pop()

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// "Use VS Code" sets Local file links to that editor; a failed write says so and changes nothing.
test("the offer's action reports a failed settings write", async () => {
  for (const fail of ["settingsGet", "settingsSet"]) {
    const calls = await withFetch((url) => {
      if (procedure(url) === fail) return json({ error: "ntwine is restarting" }, 500)
      return json({ result: settings })
    }, () => sendCodeFilesTo("vscode"))
    assert.equal(calls.map(procedure).at(-1), fail, "the failure is the one this case meant")
    assert.equal(store.toast?.text, "Couldn't set local file links to VS Code")
  }
  // A network failure, not an answer: the same.
  await withFetch(() => Promise.reject(new TypeError("fetch failed")), () => sendCodeFilesTo("vscode"))
  assert.equal(store.toast?.text, "Couldn't set local file links to VS Code")
})

test("the offer's action writes Local file links once the write lands", async () => {
  let written: unknown
  const calls = await withFetch((url, init) => {
    if (procedure(url) === "settingsSet") {
      written = JSON.parse(String(init?.body ?? "{}"))
      return json({ result: { localFileOpener: "vscode" } })
    }
    return json({ result: settings })
  }, () => sendCodeFilesTo("vscode"))
  assert.ok(calls.some((url) => procedure(url) === "settingsSet"))
  assert.equal((written as { localFileOpener?: string } | undefined)?.localFileOpener, "vscode")
  assert.equal(store.toast?.text, "Code files open in VS Code")
})

// The page as composeInto sees it: an address, and a DOM whose only textarea is the one `selector` asks for,
// showing whatever its draft says (placeCaret waits for the box to show the insert). Returns the selectors
// asked for, so a test can say WHICH box the caret was put in.
async function onPage<T>(pathname: string, draft: () => string, run: () => Promise<T>): Promise<{ result: T; asked: string[] }> {
  const previous = { location: globalThis.location, document: globalThis.document, window: globalThis.window }
  const asked: string[] = []
  const box = {
    get value() { return splitComposerValue(draft()).prose },
    getClientRects: () => [{}],
    scrollIntoView() {},
    focus() {},
    setSelectionRange() {},
  }
  globalThis.location = { pathname, search: "", origin: "http://127.0.0.1:4100" } as unknown as Location
  globalThis.document = { querySelectorAll: (selector: string) => { asked.push(selector); return [box] } } as unknown as Document
  globalThis.window = globalThis as unknown as Window & typeof globalThis
  try {
    return { result: await run(), asked }
  } finally {
    globalThis.location = previous.location
    globalThis.document = previous.document
    globalThis.window = previous.window
  }
}

const item = { path: "/repo/src/a.ts", app: "Visual Studio Code", text: "export const a = 1", startLine: 4, endLine: 6 }

// A held thread's box is kept by its holder: a chip "added" to its follow-up draft never showed,
// and surfaced in the reply box once the thread had started (sweep 2026-10-01).
test("an editor's insert refuses a held thread in front, and writes no draft", async () => {
  resetProjectState()
  store.board = { projectDir: "/repo", projectSlug: "acme", threads: [{ id: "later", sessionId: "s9", held: "lazy", heldPrompt: "Refactor the limiter" }] } as unknown as BoardSnapshot
  store.drawers = [{ id: 1, kind: "thread", slug: "later" }] as typeof store.drawers
  const key = draftKey.followUp("/repo", "later", "s9")
  try {
    const { result } = await onPage("/all/acme/thread/later", () => draftStore.get(key), () => composeInto(item, { target: "front", focus: false }))
    assert.deepEqual(result, { ok: false, reason: "Start the thread to add code to it." })
    assert.equal(draftStore.get(key), "")
  } finally {
    resetProjectState()
  }
})

// With the New thread dialog over a drawer, "front" is the dialog's box. It was the drawer's reply box
// behind the scrim, and the dialog stayed empty (sweep 2026-10-01).
test("with the New thread dialog up, an editor's insert goes into the dialog, and the drawer stays", async () => {
  resetProjectState()
  store.board = { projectDir: "/repo", projectSlug: "acme", threads: [{ id: "fix-auth", sessionId: "s1" }] } as unknown as BoardSnapshot
  store.drawers = [{ id: 1, kind: "thread", slug: "fix-auth" }] as typeof store.drawers
  store.showNewThread = true
  const dialogKey = draftKey.dispatch("/repo")
  const replyKey = draftKey.followUp("/repo", "fix-auth", "s1")
  draftStore.set(dialogKey, "")
  draftStore.set(replyKey, "")
  try {
    const { result, asked } = await onPage("/all/acme/thread/fix-auth", () => draftStore.get(dialogKey), () => composeInto(item, { target: "front", focus: true }))
    assert.deepEqual(result, { ok: true })
    assert.equal(draftStore.get(dialogKey), "@a.ts:4-6 ")
    assert.deepEqual(stagedItems(dialogKey).map((staged) => staged.token), ["@a.ts:4-6"])
    assert.equal(draftStore.get(replyKey), "", "the reply box behind the dialog is untouched")
    assert.deepEqual(asked, ['[role="dialog"]:not([data-drawer-layer]) textarea[data-surface="newComposer"]'])
    assert.equal(store.drawers.length, 1, "the drawer stays where it is")
  } finally {
    draftStore.set(dialogKey, "")
    resetProjectState()
  }
})
