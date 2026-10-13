// Imported for its SIDE EFFECT, and imported BEFORE `node:sqlite` anywhere it is used.
//
// `node:sqlite` is Stability 1.2 (release candidate) and emits an ExperimentalWarning to stderr the
// first time it is loaded. Ntwine's launcher paints a compact readout there, so an unsolicited Node
// warning lands in the middle of it — and the operator can do nothing about a warning describing an
// implementation detail they did not choose. Which releases warn is not even monotonic (measured:
// 22.14 and 24.1 warn, 24.17 is silent, 25.0-25.2 warn again, 25.8+ silent), so suppressing it is the
// only stable behaviour available.
//
// The filter is deliberately narrow: it drops ONLY node:sqlite's own experimental notice and forwards
// every other warning untouched, so a genuine deprecation or leak warning still reaches the log.
const emitWarning = process.emitWarning.bind(process)

function isSqliteExperimentalNotice(warning: string | Error, type?: string): boolean {
  const name = typeof warning === "string" ? type : warning?.name
  if (name !== "ExperimentalWarning") return false
  const text = typeof warning === "string" ? warning : (warning?.message ?? "")
  return text.includes("SQLite")
}

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const type = typeof rest[0] === "string" ? (rest[0] as string) : undefined
  if (isSqliteExperimentalNotice(warning, type)) return
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning
