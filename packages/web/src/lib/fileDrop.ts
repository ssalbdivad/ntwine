import { useEffect, useState, type DragEvent } from "react"

// FILE DROP ZONES. A prompt box takes a file dragged in from the desktop (Composer's attachment intake),
// and a queue card takes one ANYWHERE on it, handing it to its own prompt box (maintainer 2026-10-12:
// "You should be able to drag a file anywhere onto a card in the queue in order to drop it into the
// chat"). Both are `useFileDropZone` on a different element; `FileIntakeHandle` is how a zone that is
// not the box itself reaches the box's intake.

// A drag that STARTED in this page is not a file being brought in, even when it carries one: Chromium
// hands an <img> drag its bytes as a File, so a screenshot nudged a few pixels inside a card would attach
// a copy of itself to the reply. Set at dragstart and cleared at dragend — and at the next pointer press,
// because a source node unmounted mid-drag never delivers its dragend to the document.
let pageDrag = false
let trackingPageDrags = false
function trackPageDrags(): void {
  if (trackingPageDrags) return
  trackingPageDrags = true
  document.addEventListener("dragstart", () => { pageDrag = true }, true)
  document.addEventListener("dragend", () => { pageDrag = false }, true)
  document.addEventListener("pointerdown", () => { pageDrag = false }, true)
}

function bringsFiles(e: DragEvent): boolean {
  return !pageDrag && [...e.dataTransfer.items].some((item) => item.kind === "file")
}

export interface FileDropZone {
  /** A file is being dragged over the zone right now. */
  over: boolean
  /** Spread onto the zone's element. */
  handlers: {
    onDragOver: (e: DragEvent<HTMLElement>) => void
    onDragLeave: (e: DragEvent<HTMLElement>) => void
    onDrop: (e: DragEvent<HTMLElement>) => void
  }
}

export function useFileDropZone(onFiles: (files: File[]) => void): FileDropZone {
  const [over, setOver] = useState(false)
  useEffect(trackPageDrags, [])
  return {
    over,
    handlers: {
      // Cancelling dragover is what makes the element a drop target at all — without it the browser
      // opens the file in place of the app. A text or link drag is left alone, so it still drops into a
      // field the native way.
      onDragOver: (e) => {
        if (!bringsFiles(e)) return
        e.preventDefault()
        setOver(true)
      },
      // `dragleave` also fires at every crossing between two of the zone's own children; only a pointer
      // that left the zone (or the window: a null relatedTarget) ends the hover, or the hint blinks at
      // every child edge.
      onDragLeave: (e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(false)
      },
      onDrop: (e) => {
        setOver(false)
        if (!bringsFiles(e)) return
        e.preventDefault()
        onFiles([...e.dataTransfer.files])
      },
    },
  }
}

/** What a surface hands its prompt box when the SURFACE is the drop zone: whether a file is over it, so
 *  the box draws its drop hint, and the handle the box registers its intake on. */
export interface SurfaceFileDrop {
  over: boolean
  intake: FileIntakeHandle
}

/** A surface's prompt box, as the place a file dropped on the surface goes. The surface owns the zone,
 *  the box owns the intake (type and size checks, upload, chip, draft). Files given while no box is
 *  registered — a collapsed queue card has none — wait here and go to the box as it mounts. */
export class FileIntakeHandle {
  private take: ((files: File[]) => void) | null = null
  private held: File[] = []
  /** Called by the prompt box on mount with its intake, and with null on unmount. */
  set(take: ((files: File[]) => void) | null): void {
    this.take = take
    if (take && this.held.length > 0) take(this.held.splice(0))
  }
  give(files: File[]): void {
    if (this.take) this.take(files)
    else this.held.push(...files)
  }
}

/** One handle for the life of the surface. */
export function useFileIntakeHandle(): FileIntakeHandle {
  return useState(() => new FileIntakeHandle())[0]
}
