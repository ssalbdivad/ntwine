// One recorder for "did the page log an error", for the verify-* scripts that drive a disposable stack.
//
// A disposable stack (scripts/adhoc-stack.mjs) runs no supervisor, so the page's poll of
// `/_ntwine/control/status` 404s on every load, and a project with no icon answers its square's
// `/_ntwine/project-icon?…` request with a 404 (the square falls back to its monogram). Both are the
// harness, not the product: a supervised Ntwine answers the first and the second is by design. Every
// OTHER failed response and every console error still counts. The console's "Failed to load resource"
// line is the echo of a failed response and carries no URL, so it is dropped here and the response
// listener records the same failure once, WITH the URL that failed.
export const HARNESS_404 = /\/_ntwine\/control\/status$|\/_ntwine\/project-icon\?/

export function recordPageErrors(page, errors) {
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400 && !HARNESS_404.test(response.url())) errors.push(`${response.status()} ${response.url()}`)
  })
  return errors
}
