import { qrAreaOf, renderQrLines } from "@ntwine/server/qr";
import { installPaneHost, type Pane } from "./pane-host.ts";

/**
 * "Press L for a fresh access link" — an ephemeral full-screen QR, then back to the readout.
 *
 * Why a pane and not a line in the readout: the readout is SCROLLBACK. A QR that lives there is the
 * same leak as a standing secret, just harder to grep for, and it would still be on screen long after
 * the code behind it expired. A pane shows a credential for as long as someone is looking at it and
 * then takes it away.
 *
 * The keyboard itself — raw mode, ^C, restoring the shell — belongs to the pane host (pane-host.ts),
 * which routes L here and R to the remote-access pane. This file only knows how to paint a link.
 */

export interface AccessLink {
  code: string;
  url: string;
  expiresAt: number;
}

export interface AccessPaneOptions {
  /** Mint a fresh single-use link. Null when the board has no public origin, which disables the pane. */
  issue: () => AccessLink | null;
  output?: NodeJS.WriteStream;
  now?: () => number;
}

export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const CLEAR = "\x1b[2J\x1b[H";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

export interface AccessPane extends Pane {
  /** The pane is showing a code that has just been spent; repaint it as stale. */
  markConsumed(): void;
}

function secondsUntil(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** A screen line that may be dropped when the window is too short; lower `drop` goes first. */
export interface OptionalLine {
  text: string;
  drop: number;
}

/**
 * The text of a full-screen paint that never scrolls. Past its last row the alternate screen SCROLLS,
 * and on a QR screen what scrolls away first is the code's own quiet zone: an 80x24 window lost all
 * four light rows above the finder patterns, which then touched the window's edge and stopped being
 * findable. So the lines are joined with no trailing newline, and optional lines are dropped, lowest
 * `drop` first, until what is left fits `rows` at the height each line wraps to in `columns`.
 */
export function fitScreen(entries: Array<string | OptionalLine>, rows: number | undefined, columns: number | undefined): string {
  const width = columns ?? 80;
  const height = (text: string) => Math.max(1, Math.ceil([...text.replace(/\x1b\[[0-9;]*m/g, "")].length / width));
  const kept = entries.map((entry) => (typeof entry === "string" ? { text: entry, drop: Infinity } : entry));
  const total = () => kept.reduce((sum, entry) => sum + height(entry.text), 0);
  while (rows && total() > rows) {
    const next = kept.reduce<number>((lowest, entry, index) => (entry.drop < (kept[lowest]?.drop ?? Infinity) ? index : lowest), -1);
    if (next < 0) break;
    kept.splice(next, 1);
  }
  return kept.map((entry) => entry.text).join("\n");
}

export function createAccessPane(options: AccessPaneOptions): AccessPane {
  const output = options.output ?? process.stdout;
  const now = options.now ?? Date.now;

  let open = false;
  let shown: AccessLink | null = null;
  let consumed = false;
  let ticker: NodeJS.Timeout | undefined;

  const paint = () => {
    if (!shown) return;
    const remaining = secondsUntil(shown.expiresAt, now());
    const status = consumed
      ? "This link has been used. Press L for another."
      : remaining === 0
        ? "This link has expired. Press L for another."
        : `Single use, expires in ${remaining}s.`;
    const footer = `${status}  Press any other key to close.`;
    const width = output.columns ?? 80;
    const wrapped = (text: string) => Math.max(1, Math.ceil((text.length + 2) / width));
    // The code gets the window minus the URL and the status at the height they wrap to and one blank
    // line between it and them. A terminal that does not draw block elements itself gets the
    // glyph-free code when that fits (see qr.ts).
    const qr = renderQrLines(shown.url, { area: qrAreaOf(output, { indent: 2, rows: wrapped(shown.url) + wrapped(footer) + 1 }) });
    output.write(CLEAR);
    // As the window shrinks the top margin goes first, then the gap above the status, the gap below
    // the code last; the code itself never scrolls (see fitScreen).
    output.write(
      fitScreen(
        [
          { text: "", drop: 1 },
          ...qr.map((row) => `  ${row}`),
          { text: "", drop: 3 },
          `  ${shown.url}`,
          { text: "", drop: 2 },
          `  ${DIM}${footer}${RESET}`,
        ],
        output.rows,
        output.columns,
      ),
    );
  };

  return {
    open() {
      const link = options.issue();
      // No public origin means nothing to show. Say so rather than flashing an empty pane.
      if (!link) return false;
      shown = link;
      consumed = false;
      open = true;
      output.write(ALT_SCREEN_ON);
      output.write(HIDE_CURSOR);
      paint();
      // Repaint once a second so the countdown is honest and expiry is visible rather than silent.
      ticker = setInterval(paint, 1_000);
      ticker.unref?.();
      return true;
    },
    key(key) {
      // The readout footer and this pane's own expired/consumed lines all say "press L for a fresh
      // link" — so L while the pane is open must mint one in place. Before this, every key closed the
      // pane, which made L a toggle: the exact keystroke the copy invited took the QR away instead.
      if (key === "l" || key === "L") {
        const link = options.issue();
        // The origin can drop while the pane is up (the R pane clearing the remote setup); with
        // nothing left to mint, close rather than keep showing a link that no longer works.
        if (!link) return "close";
        shown = link;
        consumed = false;
        paint();
        return "keep";
      }
      return "close";
    },
    close() {
      if (!open) return;
      open = false;
      shown = null;
      consumed = false;
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      output.write(ALT_SCREEN_OFF);
      output.write(SHOW_CURSOR);
    },
    markConsumed() {
      if (!open) return;
      consumed = true;
      paint();
    },
  };
}

/**
 * The L-only host, kept for the launchers' simplest case and for the tests: a pane host with a single
 * binding. Launchers that also mount the remote-access pane build the host themselves.
 */
export interface InstalledAccessPane {
  dispose(): void;
  markConsumed(): void;
}

export function installAccessPane(
  options: AccessPaneOptions & { input?: NodeJS.ReadStream; onInterrupt?: () => void },
): InstalledAccessPane | null {
  const pane = createAccessPane(options);
  const host = installPaneHost({
    bindings: { l: pane, L: pane },
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
  });
  if (!host) return null;
  return { dispose: host.dispose, markConsumed: () => pane.markConsumed() };
}
