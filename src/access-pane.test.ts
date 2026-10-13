import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { renderQrLines } from "@ntwine/server/qr";
import { fitScreen, installAccessPane, type AccessLink } from "./access-pane.ts";

/** A stand-in TTY pair, so the pane can be driven without a real terminal. */
function fakeTty(isTty = true) {
  const input = new EventEmitter() as unknown as NodeJS.ReadStream & {
    isTTY: boolean;
    rawMode: boolean;
    setRawMode: (on: boolean) => NodeJS.ReadStream;
    resume: () => NodeJS.ReadStream;
    pause: () => NodeJS.ReadStream;
    setEncoding: () => NodeJS.ReadStream;
  };
  input.isTTY = isTty;
  input.rawMode = false;
  input.setRawMode = (on: boolean) => { input.rawMode = on; return input; };
  input.resume = () => input;
  input.pause = () => input;
  input.setEncoding = () => input;

  const written: string[] = [];
  const output = { isTTY: isTty, write: (chunk: string) => { written.push(chunk); return true; } } as unknown as NodeJS.WriteStream;
  return { input, output, written, all: () => written.join("") };
}

function link(overrides: Partial<AccessLink> = {}): AccessLink {
  return { code: "abc", url: "https://dana.ntwine.app/?ntwine_code=abc", expiresAt: 300_000, ...overrides };
}

test("L opens a pane with a scannable code, and any other key closes it", () => {
  const tty = fakeTty();
  let issued = 0;
  const pane = installAccessPane({
    issue: () => { issued++; return link(); },
    input: tty.input,
    output: tty.output,
    now: () => 0,
  });
  assert.ok(pane);

  // Nothing is minted until asked. A credential must never appear without a deliberate keystroke.
  assert.equal(issued, 0);

  tty.input.emit("data", "l");
  assert.equal(issued, 1, "L mints exactly one link");
  const opened = tty.all();
  assert.match(opened, /\x1b\[\?1049h/, "uses the alternate screen, so the QR is not left in scrollback");
  assert.match(opened, /ntwine_code=abc/, "prints the URL for anyone who cannot scan");
  assert.match(opened, /Single use, expires in 300s/);
  assert.match(opened, /[▀▄]/, "renders the QR itself");

  tty.written.length = 0;
  tty.input.emit("data", "x");
  assert.match(tty.all(), /\x1b\[\?1049l/, "leaves the alternate screen, restoring the readout");
  assert.match(tty.all(), /\x1b\[\?25h/, "puts the cursor back");

  pane.dispose();
});

test("pressing L twice mints a second link rather than re-showing the first", () => {
  // Codes are single-use, so a pane that redisplayed a spent one would be actively misleading.
  const tty = fakeTty();
  const codes = ["one", "two"];
  let n = 0;
  const pane = installAccessPane({
    issue: () => link({ code: codes[n]!, url: `https://x/?ntwine_code=${codes[n++]}` }),
    input: tty.input,
    output: tty.output,
    now: () => 0,
  });
  assert.ok(pane);
  tty.input.emit("data", "l");
  tty.input.emit("data", "q");
  tty.written.length = 0;
  tty.input.emit("data", "L");
  assert.match(tty.all(), /ntwine_code=two/, "uppercase L works too, and mints fresh");
  pane.dispose();
});

test("L while the pane is open mints a fresh link in place instead of closing", () => {
  // "Press L for a fresh sign-in link" / "Press L for another" — pressed while the pane is already
  // showing, L must honour that copy, not act as a toggle that takes the QR away.
  const tty = fakeTty();
  const codes = ["one", "two", "three"];
  let n = 0;
  const pane = installAccessPane({
    issue: () => link({ code: codes[n]!, url: `https://x/?ntwine_code=${codes[n++]}` }),
    input: tty.input,
    output: tty.output,
    now: () => 0,
  });
  assert.ok(pane);
  tty.input.emit("data", "l");
  tty.written.length = 0;
  tty.input.emit("data", "l");
  assert.doesNotMatch(tty.all(), /\x1b\[\?1049l/, "the pane stays up");
  assert.match(tty.all(), /ntwine_code=two/, "and shows a freshly minted code");
  tty.written.length = 0;
  tty.input.emit("data", "L");
  assert.match(tty.all(), /ntwine_code=three/, "uppercase L re-mints too");
  tty.input.emit("data", "x");
  assert.match(tty.all(), /\x1b\[\?1049l/, "any other key still closes");
  pane.dispose();
});

test("L while the pane is open closes it when the origin has dropped mid-view", () => {
  // The R pane can clear the remote setup while the QR is up; with nothing left to mint, keeping a
  // dead link on screen would be worse than closing.
  const tty = fakeTty();
  let minted = 0;
  const pane = installAccessPane({
    issue: () => (minted++ === 0 ? link() : null),
    input: tty.input,
    output: tty.output,
    now: () => 0,
  });
  assert.ok(pane);
  tty.input.emit("data", "l");
  tty.written.length = 0;
  tty.input.emit("data", "l");
  assert.match(tty.all(), /\x1b\[\?1049l/, "the pane comes down rather than re-offering a link it cannot mint");
  pane.dispose();
});

test("Ctrl-C still stops the board, because raw mode stopped the TTY doing it", () => {
  // The failure this prevents is severe and silent: the operator's own terminal can no longer kill the
  // server it started, and nothing on screen explains why.
  const tty = fakeTty();
  let interrupts = 0;
  const pane = installAccessPane({
    issue: () => link(),
    input: tty.input,
    output: tty.output,
    now: () => 0,
    onInterrupt: () => { interrupts++; },
  });
  assert.ok(pane);
  assert.equal(tty.input.rawMode, true, "raw mode is on while listening");

  tty.input.emit("data", "\x03");
  assert.equal(interrupts, 1, "^C is re-raised as an interrupt by hand");
  assert.equal(tty.input.rawMode, false, "and the terminal is restored BEFORE the signal lands");
  pane.dispose();
});

test("disposing always restores raw mode, and is safe to call twice", () => {
  const tty = fakeTty();
  const pane = installAccessPane({ issue: () => link(), input: tty.input, output: tty.output, now: () => 0 });
  assert.ok(pane);
  assert.equal(tty.input.rawMode, true);
  pane.dispose();
  assert.equal(tty.input.rawMode, false, "a shell left in raw mode echoes nothing after Ntwine stops");
  pane.dispose();
  assert.equal(tty.input.rawMode, false);
});

test("a consumed code repaints as spent instead of lying on screen", () => {
  const tty = fakeTty();
  const pane = installAccessPane({ issue: () => link(), input: tty.input, output: tty.output, now: () => 0 });
  assert.ok(pane);
  tty.input.emit("data", "l");
  tty.written.length = 0;
  pane.markConsumed();
  assert.match(tty.all(), /has been used/, "someone scanned it; the screen must stop offering it");
  pane.dispose();
});

test("an expired code says so rather than counting down past zero", () => {
  const tty = fakeTty();
  let clock = 0;
  const pane = installAccessPane({
    issue: () => link({ expiresAt: 5_000 }),
    input: tty.input,
    output: tty.output,
    now: () => clock,
  });
  assert.ok(pane);
  tty.input.emit("data", "l");
  clock = 6_000;
  tty.written.length = 0;
  pane.markConsumed.call(pane); // forces a repaint through the same path
  assert.match(tty.all(), /has been used|has expired/);
  pane.dispose();
});

test("without a TTY the pane does not install at all", () => {
  // Under a pipe or CI there is no keyboard and no cursor addressing, and stdout is being read as
  // records. Installing would corrupt that output and swallow stdin.
  const piped = fakeTty(false);
  let issued = 0;
  const pane = installAccessPane({
    issue: () => { issued++; return link(); },
    input: piped.input,
    output: piped.output,
  });
  assert.equal(pane, null);
  assert.equal(piped.input.rawMode, false, "stdin is left exactly as found");
  assert.equal(piped.all(), "", "nothing is written");
  assert.equal(issued, 0);
});

test("a board with no public origin has nothing to show and opens nothing", () => {
  const tty = fakeTty();
  const pane = installAccessPane({ issue: () => null, input: tty.input, output: tty.output, now: () => 0 });
  assert.ok(pane, "the listener still installs; only the pane content is unavailable");
  tty.input.emit("data", "l");
  assert.doesNotMatch(tty.all(), /\x1b\[\?1049h/, "no empty pane flashes up");
  pane.dispose();
});

/** What is on screen after the pane's last repaint, colour codes stripped. */
function lastScreen(written: string): string {
  return written.split("\x1b[2J\x1b[H").pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

test("in an 80x24 window the whole code stays on screen, quiet zone included", () => {
  // The alternate screen scrolls when a paint runs past its last row, and the first thing to go is the
  // code's own quiet zone: an 80x24 window (Terminal.app's default) lost all four light rows above the
  // finder patterns, which then touched the window edge. The paint must fit, and never end on a newline.
  const tty = fakeTty();
  Object.assign(tty.output, { columns: 80, rows: 24 });
  const pane = installAccessPane({ issue: () => link(), input: tty.input, output: tty.output, now: () => 0 });
  assert.ok(pane);
  tty.input.emit("data", "l");
  const screen = lastScreen(tty.all());
  assert.ok(!screen.endsWith("\n"), "the paint does not end on a newline");
  const rows = screen.split("\n");
  assert.ok(rows.length <= 24, `the paint is ${rows.length} rows in a 24-row window`);
  const code = renderQrLines(link().url, { style: "half" }).map((row) => `  ${row.replace(/\x1b\[[0-9;]*m/g, "")}`);
  const top = rows.indexOf(code[0]!);
  assert.ok(top >= 0, "the code's top quiet-zone row is on screen");
  assert.deepEqual(rows.slice(top, top + code.length), code, "every row of the code, in order");
  assert.ok(rows.some((row) => row.includes("ntwine_code=abc")), "the URL still fits");
  pane.dispose();
});

test("fitScreen drops optional lines lowest first, and only as far as the window needs", () => {
  const entries = ["a", { text: "", drop: 2 }, "b", { text: "", drop: 1 }, "c"];
  assert.equal(fitScreen(entries, undefined, 80), "a\n\nb\n\nc", "an unsized stream keeps everything");
  assert.equal(fitScreen(entries, 5, 80), "a\n\nb\n\nc");
  assert.equal(fitScreen(entries, 4, 80), "a\n\nb\nc", "drop 1 goes first");
  assert.equal(fitScreen(entries, 3, 80), "a\nb\nc");
  assert.equal(fitScreen(entries, 2, 80), "a\nb\nc", "required lines are never dropped");
  // A line counts at the height it wraps to, colour codes excluded.
  assert.equal(fitScreen(["\x1b[2m" + "x".repeat(81) + "\x1b[0m", { text: "", drop: 1 }, "y"], 3, 80), "\x1b[2m" + "x".repeat(81) + "\x1b[0m\ny");
});
