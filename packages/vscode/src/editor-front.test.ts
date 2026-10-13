import { test } from "node:test"
import assert from "node:assert/strict"
import { EDITOR_STATE_MAX_SELECTION_TEXT } from "@ntwine/shared/editor-protocol"
import { EMBED_MAX_SELECTION_TEXT } from "@ntwine/shared/embed-protocol"
import { editorContextMessage, pageActive, type Position } from "./editor-context.ts"
import { editorFront, pickFront, secretFile, selectedText, type ReadableEditor } from "./editor-front.ts"
import { buildEditorSnapshot } from "./editor-state.ts"

const at = (line: number, character: number): Position => ({ line, character })

/** A document as VS Code's TextDocument reads it, over a string: offsets, positions, ranges. */
function editor(text: string, options: { scheme?: string; path?: string; dirty?: boolean; closed?: boolean; selections?: [Position, Position][]; visible?: [number, number] } = {}): ReadableEditor<Position> {
  const lines = text.split("\n")
  const offsetAt = ({ line, character }: Position) => lines.slice(0, line).reduce((sum, each) => sum + each.length + 1, 0) + character
  const positionAt = (offset: number): Position => {
    let left = Math.min(offset, text.length)
    for (let line = 0; line < lines.length; line++) {
      if (left <= lines[line]!.length) return at(line, left)
      left -= lines[line]!.length + 1
    }
    return at(lines.length - 1, lines.at(-1)!.length)
  }
  const scheme = options.scheme ?? "file"
  const path = options.path ?? "/repo/src/a.ts"
  // VS Code's document takes only its own Range objects (it checks `instanceof Range`): this one takes only
  // ranges it made — the selection, or one the selection's `with` returned — so a literal fails here too.
  const ours = new WeakSet<object>()
  const range = (start: Position, end: Position) => {
    const made = { start, end, with: (from: Position | undefined, to: Position) => range(from ?? start, to) }
    ours.add(made)
    return made
  }
  const ranges = (options.selections ?? [[at(0, 0), at(0, 0)]]).map(([start, end]) => range(start, end))
  const primary = ranges[0]!
  return {
    document: {
      uri: { scheme, fsPath: path, path: scheme === "untitled" ? "Untitled-1" : path },
      languageId: "typescript",
      isDirty: options.dirty ?? false,
      isClosed: options.closed ?? false,
      lineCount: lines.length,
      offsetAt,
      positionAt,
      getText: (range) => {
        if (range && !ours.has(range)) throw new Error("Invalid argument")
        return range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text
      },
    },
    selection: Object.assign(primary, { active: primary.end, isEmpty: offsetAt(primary.start) === offsetAt(primary.end) }),
    selections: ranges,
    visibleRanges: options.visible ? [{ start: at(options.visible[0], 0), end: at(options.visible[1], 0) }] : [],
  }
}

const SOURCE = "let total = 0\nfor (const x of xs) {\n  total += x\n}\n"

test("in front: the active editor when it is a file or an untitled buffer, else the last one still on screen", () => {
  const file = editor(SOURCE)
  const untitled = editor("scratch", { scheme: "untitled" })
  const output = editor("[info] built", { scheme: "output" })
  const gitSide = editor(SOURCE, { scheme: "git" })
  assert.equal(pickFront(file, undefined, [file]), file)
  assert.equal(pickFront(untitled, file, [file, untitled]), untitled, "an untitled buffer is in front in its own right")
  // Focus in the Output panel makes IT the active text editor: the file the human was pointing at stands in.
  assert.equal(pickFront(output, file, [file, output]), file)
  // The git side of a diff is not a file on disk; the diff's working-tree side, still on screen, is.
  assert.equal(pickFront(gitSide, file, [gitSide, file]), file)
  // …but only while it is on screen and open: a closed or scrolled-away editor is not in front of anyone.
  assert.equal(pickFront(output, file, [output]), undefined)
  assert.equal(pickFront(output, editor(SOURCE, { closed: true }), [output]), undefined)
  assert.equal(pickFront(undefined, undefined, []), undefined)
})

test("the reading: path, flags, caret, the primary selection with every selection's characters, the lines on screen", () => {
  const front = editorFront(editor(SOURCE, { dirty: true, selections: [[at(1, 0), at(3, 0)], [at(0, 4), at(0, 9)]], visible: [0, 3] }))
  assert.deepEqual(front, {
    path: "/repo/src/a.ts",
    untitled: false,
    dirty: true,
    languageId: "typescript",
    lineCount: 5,
    cursor: at(3, 0),
    selection: { start: at(1, 0), end: at(3, 0), primaryChars: 35, chars: 40 },
    visible: { start: 0, end: 3 },
    withheld: false,
  })
  // A caret is not a selection, and an untitled buffer is named by its label.
  const scratch = editorFront(editor("note", { scheme: "untitled", selections: [[at(0, 2), at(0, 2)]] }))
  assert.equal(scratch.selection, undefined)
  assert.deepEqual([scratch.path, scratch.untitled, scratch.cursor], ["Untitled-1", true, at(0, 2)])
})

test("the selected text is read only as far as a feed carries it, and never from a withheld file", () => {
  const whole = editor(SOURCE, { selections: [[at(0, 0), at(2, 12)]] })
  assert.equal(selectedText(whole, editorFront(whole), 1_000), "let total = 0\nfor (const x of xs) {\n  total += x")
  // Past the ceiling: the START, exactly `max` characters — a select-all is not copied whole to be cut.
  let asked: unknown
  const big = editor("x".repeat(100), { selections: [[at(0, 0), at(0, 100)]] })
  const getText = big.document.getText
  big.document.getText = (range) => ((asked = range), getText(range))
  assert.equal(selectedText(big, editorFront(big), 10), "x".repeat(10))
  assert.deepEqual([(asked as { start: Position }).start, (asked as { end: Position }).end], [at(0, 0), at(0, 10)])
  const secret = editor("API_KEY=sk-live-123\n", { path: "/repo/.env.local", selections: [[at(0, 0), at(0, 19)]] })
  assert.equal(editorFront(secret).withheld, true)
  assert.equal(selectedText(secret, editorFront(secret), 1_000), undefined)
  // What VS Code is told to hide (files.exclude, matched by the glue) is withheld the same way.
  assert.equal(selectedText(whole, editorFront(whole, true), 1_000), undefined)
  // An untitled buffer is never withheld: it has no name that could say so, and nothing the glue can match.
  assert.equal(editorFront(editor("x", { scheme: "untitled" }), true).withheld, false)
})

test("secret files, by name", () => {
  for (const path of [
    "/r/.env", "/r/.env.local", "/r/.env.production", "/r/deploy/prod.env", "/r/.envrc",
    "/r/certs/server.pem", "/r/tls.key", "/r/store.p12", "/r/win.pfx", "/r/app.keystore",
    "/home/me/.ssh/id_rsa", "/home/me/.ssh/id_ed25519.pub", "/home/me/.aws/credentials", "/r/gcp-credentials.json",
    "/r/client_secret.json", "/r/k8s/secrets.yaml", "/home/me/.netrc", "/r/.npmrc", "/home/me/.kube/kubeconfig",
    "C:\\Users\\me\\repo\\.env",
  ]) assert.equal(secretFile(path), true, path)
  for (const path of ["/r/src/env.ts", "/r/src/environment.ts", "/r/keyboard.ts", "/r/src/keys.ts", "/r/README.md", "/r/.envoy.yaml", "/r/Untitled-1", "/r/pemfile.ts"]) {
    assert.equal(secretFile(path), false, path)
  }
})

test("ONE reading, two feeds: the page and the agents' tool say the same lines, flags and caret, each at its own ceiling", () => {
  const big = "y".repeat(EMBED_MAX_SELECTION_TEXT + 10)
  for (const subject of [
    editor(SOURCE, { selections: [[at(1, 0), at(3, 0)]], dirty: true }),
    editor(SOURCE, { selections: [[at(2, 4), at(2, 4)]] }),
    editor("draft", { scheme: "untitled", selections: [[at(0, 0), at(0, 5)]] }),
    editor("TOKEN=1\n", { path: "/r/.env", selections: [[at(0, 0), at(0, 7)]] }),
    editor(big, { selections: [[at(0, 0), at(0, big.length)]] }),
  ]) {
    const front = editorFront(subject)
    const page = editorContextMessage(pageActive(front, { path: front.path, label: front.path }, () => selectedText(subject, front, EMBED_MAX_SELECTION_TEXT)!), []).active!
    const tool = buildEditorSnapshot({
      shared: true,
      active: {
        path: front.path, untitled: front.untitled, languageId: front.languageId, dirty: front.dirty, lineCount: front.lineCount, cursor: front.cursor,
        ...(front.selection ? { selection: { start: front.selection.start, end: front.selection.end, text: selectedText(subject, front, EDITOR_STATE_MAX_SELECTION_TEXT), more: front.selection.primaryChars > EDITOR_STATE_MAX_SELECTION_TEXT } } : {}),
        withheld: front.withheld,
      },
      open: [],
      diagnostics: [],
    }).active!
    assert.equal(page.path, tool.path)
    assert.equal(page.untitled === true, tool.untitled === true, `${front.path}: untitled`)
    assert.equal(page.dirty === true, tool.dirty, `${front.path}: dirty`)
    assert.equal(page.withheld === true, tool.selection?.withheld === true || (!tool.selection && front.withheld), `${front.path}: withheld`)
    if (tool.selection) {
      assert.deepEqual([page.selection?.startLine, page.selection?.endLine], [tool.selection.startLine, tool.selection.endLine], `${front.path}: the same lines`)
      // The page quotes up to 16 Ki and the tool up to 32 Ki: a selection between the two is the tool's alone.
      if (page.selection?.text !== undefined) assert.equal(page.selection.text, tool.selection.text)
    } else {
      assert.equal(page.cursorLine, tool.cursorLine)
    }
  }
  // The withheld file carries no text in either; the big selection is quoted by the tool and not the page.
  const env = editorFront(editor("TOKEN=1\n", { path: "/r/.env", selections: [[at(0, 0), at(0, 7)]] }))
  assert.equal(pageActive(env, { path: env.path, label: ".env" }, () => "TOKEN=1").selection?.text, undefined)
})

test("the page is told the flags only when they are set, and a selection's text only when it may go", () => {
  const dirty = editorFront(editor(SOURCE, { dirty: true, selections: [[at(0, 0), at(0, 3)]] }))
  assert.deepEqual(pageActive(dirty, { path: dirty.path, label: "src/a.ts" }, () => "let"), {
    path: "/repo/src/a.ts", label: "src/a.ts", selection: { startLine: 1, endLine: 1, chars: 3, text: "let" }, dirty: true,
  })
  // Sharing off: the glue passes no reader, and the lines go without their text.
  assert.deepEqual(pageActive(dirty, { path: dirty.path, label: "src/a.ts" }, undefined).selection, { startLine: 1, endLine: 1, chars: 3 })
  const clean = editorFront(editor(SOURCE, { selections: [[at(3, 1), at(3, 1)]] }))
  assert.deepEqual(pageActive(clean, { path: clean.path, label: "src/a.ts" }, () => ""), { path: "/repo/src/a.ts", label: "src/a.ts", cursorLine: 4 })
})
