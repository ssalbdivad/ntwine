import { useCallback, useEffect, useRef, useState } from "react"
import { showToast } from "../store.ts"

// ON-DEVICE DICTATION — the composer's microphone (2026-10-08).
//
// Chrome ships an on-device recognizer behind the ordinary Web Speech API: set `processLocally` and the
// audio never leaves the machine, recognized by the same engine as Live Caption after a one-time language
// pack download (~10–20s here). `SpeechRecognition.available()` answers whether this browser can do that
// at all, and it is the WHOLE feature detection — no user-agent sniffing. Safari exposes only the prefixed
// server-backed recognizer and Firefox keeps the API behind a flag, so neither has `available()`; Electron
// stubs it to "unavailable"; an insecure origin (`--host` over plain http) gets no microphone. Each of
// those simply never sees the button. Edge, which ships the same engine, does.
//
// THE PROBE CAN CRASH THE TAB. `available({ processLocally: true })` asks the browser process for an
// on-device recognizer, and an embedder that never registered one takes the renderer down instead of
// answering: chrome-headless-shell does ("Page crashed!", reproduced 2026-10-08), and Electron did until
// it stubbed the interface in August 2026. Every Chrome-layer browser (Chrome, Chrome for Testing, Edge,
// Arc, Brave) has it. So the probe never runs where the user agent says HeadlessChrome or Electron —
// which includes this repo's own headless e2e runs — and it leaves a marker in localStorage while it
// is in flight: a marker still there on a later load means a probe died with its tab, and this browser
// is never probed again. One crash, never a crash on every load.
//
// There is deliberately NO cloud fallback. Without `processLocally` Chrome streams the microphone to
// Google's speech service; a prompt box that does that silently is not the feature that was asked for.
//
// Measured before building it (a spoken 70-word steer fed in as a MediaStreamTrack, Chrome 155, Apple
// silicon): the on-device transcript was as accurate as the cloud one — both heard "cue card" for
// "queue card" and "Maine" for "main" — with a first partial result inside ~1–4s. Neither engine
// punctuates. The phrase hints below fixed most of the Frizz vocabulary it missed.
//
// Two engine behaviours this module is shaped around, both observed, neither documented:
//   - The LAST segment never becomes final when recognition is stopped: `stop()` ends the session with
//     it still interim. So interim text is written into the box as it arrives, and stopping keeps
//     whatever the box shows — nothing waits for a final result that will not come.
//   - Every segment after a pause arrives capitalized ("…pull request" then "Then run…"), as if it
//     opened a sentence that the engine never closed. `joinSegments` lowercases those continuations
//     rather than inventing a full stop the speaker may not have meant.

// The slice of the Web Speech API this uses. TypeScript's DOM lib carries the result types but not
// the recognizer itself, and none of the on-device statics.
type Availability = "available" | "downloadable" | "downloading" | "unavailable"
interface LocalOptions {
  langs: string[]
  processLocally: true
}
interface Recognizer extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  processLocally: boolean
  phrases: unknown[]
  // Chrome 135+ takes the audio track to recognize; older engines ignore it and open the microphone themselves.
  start(track?: MediaStreamTrack): void
  stop(): void
  abort(): void
  onresult: ((e: { results: SpeechRecognitionResultList }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
interface RecognizerClass {
  new (): Recognizer
  available(options: LocalOptions): Promise<Availability>
  install(options: LocalOptions): Promise<boolean>
}
type PhraseClass = new (phrase: string, boost: number) => unknown

function recognizerClass(): RecognizerClass | null {
  if (typeof window === "undefined" || !window.isSecureContext) return null
  const SR = (window as unknown as { SpeechRecognition?: RecognizerClass }).SpeechRecognition
  return typeof SR?.available === "function" && typeof SR.install === "function" ? SR : null
}

// The language to listen in: the first of the browser's own preferences the on-device engine can serve.
// An English speaker whose exact locale has no pack (en-GB, say) still gets en-US, which hears them fine;
// nobody else is handed an English model they did not ask for.
export function languageCandidates(preferred: readonly string[]): string[] {
  const out = [...new Set(preferred.filter(Boolean))]
  if (out.some((l) => /^en\b/i.test(l)) && !out.includes("en-US")) out.push("en-US")
  return out
}

export type DictationSupport = { lang: string; status: Exclude<Availability, "unavailable"> }

const CRASHES_ON_PROBE = /\bHeadlessChrome\/|\bElectron\//
const PROBE_MARKER = "frizz:dictation-probe"
// A live probe answers in milliseconds; a marker this old outlived its tab.
const PROBE_MARKER_STALE_MS = 60_000

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

async function probe(): Promise<DictationSupport | null> {
  const SR = recognizerClass()
  if (!SR || CRASHES_ON_PROBE.test(navigator.userAgent)) return null
  const store = storage()
  const started = Number(store?.getItem(PROBE_MARKER) ?? 0)
  if (started && Date.now() - started > PROBE_MARKER_STALE_MS) return null
  store?.setItem(PROBE_MARKER, String(Date.now()))
  try {
    return await probeLanguages(SR)
  } finally {
    store?.removeItem(PROBE_MARKER)
  }
}

async function probeLanguages(SR: RecognizerClass): Promise<DictationSupport | null> {
  for (const lang of languageCandidates(navigator.languages ?? [navigator.language])) {
    try {
      const status = await SR.available({ langs: [lang], processLocally: true })
      if (status !== "unavailable") return { lang, status }
    } catch {
      // A malformed tag throws SyntaxError; a Permissions-Policy that blocks the feature rejects.
      // Either way this candidate is out — try the next.
    }
  }
  return null
}

// One answer per page, shared by every composer on it: the question is about the browser, not the box.
let detection: Promise<DictationSupport | null> | undefined
export function detectDictation(): Promise<DictationSupport | null> {
  detection ??= probe()
  return detection
}

// Vocabulary the engine reliably mishears in this product ("cue" for queue, "tag check" for type
// check). Boost 2 is deliberate: at 5 a two-letter hint ("PR") sent the on-device engine into a loop
// that emitted it a hundred times, so nothing here is that short and nothing is boosted that hard.
const PHRASES: ReadonlyArray<string> = ["Frizz", "queue", "pull request", "type check", "worktree", "sub-agent", "commit to main"]
const PHRASE_BOOST = 2

// Words that keep their capital mid-sentence: the pronoun and its contractions. Anything whose second
// letter is also a capital (PR, CI, API) is an acronym and is left alone by the shape test instead.
const KEEPS_CAPITAL = /^I(?:'[a-z]+)?\b/

function continuation(segment: string): string {
  return /^[A-Z][a-z]/.test(segment) && !KEEPS_CAPITAL.test(segment) ? segment[0].toLowerCase() + segment.slice(1) : segment
}

// One session's segments as one run of text: each trimmed, joined by single spaces, and every segment
// after the first read as a continuation of the sentence before it (see the header).
export function joinSegments(segments: readonly string[]): string {
  const parts = segments.map((s) => s.trim()).filter(Boolean)
  return parts.map((s, i) => (i === 0 ? s : continuation(s))).join(" ")
}

// Put a session's text into the draft between `before` and `after` (the caret, or the selection it
// replaces), spaced like typing would be and capitalized for where it lands: a sentence start keeps the
// engine's capital, the middle of a sentence lowercases it. Returns the new draft and the caret, which
// sits right after the spoken text so the next words — typed or spoken — follow it.
export function spliceDictation(before: string, spoken: string, after: string): { text: string; caret: number } {
  if (!spoken) return { text: before + after, caret: before.length }
  const sentenceStart = /(?:^|[.!?]\s*|\n\s*)$/.test(before)
  const body = sentenceStart ? spoken[0].toUpperCase() + spoken.slice(1) : continuation(spoken)
  const lead = before && !/\s$/.test(before) ? " " : ""
  const trail = after && !/^\s/.test(after) ? " " : ""
  const head = before + lead + body
  return { text: head + trail + after, caret: head.length }
}

// Only one microphone at a time on the page: a second composer starting dictation ends the first.
let activeSession: { abort: () => void } | null = null

export type DictationState = "unsupported" | "idle" | "installing" | "starting" | "listening"

// Recognizer errors worth a toast. "aborted" is our own cancel and "no-speech" is the operator saying
// nothing; both just end the session.
function errorMessage(error: string): string | null {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked for this site — allow it in the browser's site settings to dictate"
    case "audio-capture":
      return "No microphone was found"
    case "language-not-supported":
      return "The on-device speech model is not installed — click the microphone again to download it"
    case "aborted":
    case "no-speech":
      return null
    default:
      return `Dictation stopped (${error})`
  }
}

function microphoneError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return errorMessage("not-allowed")!
  if (name === "NotFoundError" || name === "OverconstrainedError") return errorMessage("audio-capture")!
  return `The microphone could not start: ${err instanceof Error ? err.message : String(err)}`
}

function release(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

// The composer's microphone. `read` returns the textarea's current prose and selection; `write` puts
// new prose in it and places the caret. The hook owns the recognizer and never lets two writers race:
// the moment the box holds anything other than what dictation last wrote — the operator typed, sent, or
// the surface cleared the draft — the session is cancelled and the box is left exactly as it is.
//
// The hook opens the microphone ITSELF and hands the recognizer that track, so the same audio can feed
// the level meter on the button (DictationLevel): one capture, one permission prompt, and the browser's
// recording indicator goes out the moment the session ends, because ending it stops the track.
//
// `enabled` is the operator's Settings switch (prefs.dictation). Off reads as "unsupported": no button,
// no capability probe, and a session that was listening when it flipped is cancelled.
export function useDictation({
  read,
  write,
  enabled = true,
}: {
  read: () => { prose: string; start: number; end: number }
  write: (prose: string, caret: number) => void
  enabled?: boolean
}) {
  const [support, setSupport] = useState<DictationSupport | null>(null)
  const [state, setState] = useState<Exclude<DictationState, "unsupported">>("idle")
  const [stream, setStream] = useState<MediaStream | null>(null)
  const sessionRef = useRef<{ recognizer: Recognizer; stream: MediaStream; lastWritten: string; abort: () => void } | null>(null)
  const mountedRef = useRef(true)
  // Bumped by every cancel, so a start still waiting on the microphone prompt knows it was called off.
  const generationRef = useRef(0)
  const readRef = useRef(read)
  readRef.current = read
  const writeRef = useRef(write)
  writeRef.current = write

  useEffect(() => {
    if (!enabled) return
    let live = true
    void detectDictation().then((s) => { if (live) setSupport(s) })
    return () => { live = false }
  }, [enabled])

  // Stop listening and keep what the box shows. Handlers come off FIRST, so nothing the engine still
  // has in flight can write after the operator took the box back.
  const cancel = useCallback(() => {
    generationRef.current++
    const session = sessionRef.current
    if (!session) {
      setState((s) => (s === "starting" ? "idle" : s))
      return
    }
    sessionRef.current = null
    if (activeSession === session) activeSession = null
    session.recognizer.onresult = null
    session.recognizer.onerror = null
    session.recognizer.onend = null
    session.recognizer.abort()
    release(session.stream)
    setStream(null)
    setState("idle")
  }, [])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancel()
    }
  }, [cancel])
  useEffect(() => {
    if (!enabled) cancel()
  }, [enabled, cancel])

  const listen = useCallback(async (lang: string) => {
    const SR = recognizerClass()
    if (!SR) return
    activeSession?.abort()
    setState("starting")
    const generation = generationRef.current
    let mic: MediaStream
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      if (mountedRef.current) setState("idle")
      showToast(microphoneError(err))
      return
    }
    if (!mountedRef.current || generation !== generationRef.current) return release(mic)
    const recognizer = new SR()
    recognizer.lang = lang
    recognizer.continuous = true
    recognizer.interimResults = true
    recognizer.processLocally = true
    const Phrase = (window as unknown as { SpeechRecognitionPhrase?: PhraseClass }).SpeechRecognitionPhrase
    if (Phrase) {
      try {
        recognizer.phrases = PHRASES.map((p) => new Phrase(p, PHRASE_BOOST))
      } catch {
        // Hints are an accuracy nicety; an engine that refuses them still transcribes.
      }
    }
    const { prose, start, end } = readRef.current()
    const before = prose.slice(0, start)
    const after = prose.slice(end)
    const session = { recognizer, stream: mic, lastWritten: prose, abort: () => cancel() }
    recognizer.onresult = (e) => {
      if (readRef.current().prose !== session.lastWritten) return cancel()
      const segments = Array.from(e.results, (r) => r[0]?.transcript ?? "")
      const next = spliceDictation(before, joinSegments(segments), after)
      session.lastWritten = next.text
      writeRef.current(next.text, next.caret)
    }
    recognizer.onerror = (e) => {
      const message = errorMessage(e.error)
      if (message) showToast(message)
      // The pack can be evicted after detection said "available"; ask again on the next click.
      if (e.error === "language-not-supported") {
        detection = undefined
        setSupport((s) => (s ? { ...s, status: "downloadable" } : s))
      }
    }
    recognizer.onend = () => {
      release(mic)
      if (sessionRef.current !== session) return
      sessionRef.current = null
      if (activeSession === session) activeSession = null
      setStream(null)
      setState("idle")
    }
    sessionRef.current = session
    activeSession = session
    setStream(mic)
    setState("listening")
    try {
      recognizer.start(mic.getAudioTracks()[0])
    } catch (err) {
      cancel()
      showToast(`Dictation could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [cancel])

  // The button: start, or stop. A language pack that is not on disk yet is downloaded first, behind a
  // spinner, and listening starts as soon as it lands — the click asked to dictate, not to download.
  const toggle = useCallback(async () => {
    if (sessionRef.current) {
      // stop(), not abort(): let the engine finish the words already spoken. The box already shows them
      // (see the header), so whatever arrives before `end` only refines them.
      sessionRef.current.recognizer.stop()
      return
    }
    const SR = recognizerClass()
    if (!SR || !support || state === "installing" || state === "starting") return
    let status: Availability = support.status
    try {
      status = await SR.available({ langs: [support.lang], processLocally: true })
    } catch {
      // Keep the detected status; start() reports anything still wrong.
    }
    if (status === "unavailable") {
      showToast("On-device dictation is not available in this browser")
      return
    }
    if (status !== "available") {
      setState("installing")
      let ok = false
      try {
        ok = await SR.install({ langs: [support.lang], processLocally: true })
      } catch {
        ok = false
      }
      if (!ok) {
        setState("idle")
        showToast("The on-device speech model could not be downloaded — try again later")
        return
      }
      setSupport({ lang: support.lang, status: "available" })
    }
    await listen(support.lang)
  }, [support, state, listen])

  return { state: support && enabled ? state : ("unsupported" as const), stream, toggle, cancel }
}
