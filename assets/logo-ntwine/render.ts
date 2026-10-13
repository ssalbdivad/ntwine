// Rasterize SVG strings to PNG in puppeteer's headless shell (scripts/lib/headless-browser.mjs).
// This machine has no rsvg-convert, so Chrome's SVG rasterizer is the one used for every PNG here,
// the installed ones included. One browser per run; it is closed in `finally`.
import { launchHeadless } from "../../scripts/lib/headless-browser.mjs"

type Browser = Awaited<ReturnType<typeof launchHeadless>>

export async function withRenderer<T>(fn: (render: (svg: string, size: number, opts?: { opaque?: boolean }) => Promise<Buffer>) => Promise<T>): Promise<T> {
  const browser: Browser = await launchHeadless({ protocolTimeout: 60_000 })
  try {
    const page = await browser.newPage()
    const render = async (svg: string, size: number, { opaque = false } = {}) => {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
      const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent"><img id="i" src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`,
      )
      await page.waitForFunction(() => (document.getElementById("i") as HTMLImageElement).complete)
      const shot = await page.screenshot({ type: "png", omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } })
      return Buffer.from(shot)
    }
    return await fn(render)
  } finally {
    await browser.close()
  }
}

/** Screenshot a whole HTML file (a contact sheet) at its full height. */
export async function shootPage(url: string, out: string, width = 1400) {
  const browser: Browser = await launchHeadless({ protocolTimeout: 60_000 })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width, height: 800, deviceScaleFactor: 1 })
    await page.goto(url, { waitUntil: "load" })
    await page.screenshot({ path: out as `${string}.png`, fullPage: true })
  } finally {
    await browser.close()
  }
}
