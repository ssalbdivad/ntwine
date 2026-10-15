import { ATTACHMENT_ARCHIVE_EXTENSIONS, ATTACHMENT_DATA_EXTENSIONS, ATTACHMENT_OFFICE_EXTENSIONS } from "@ntwine/shared"
import { isLocalMarkdownFile } from "./markdownTargets.ts"
import { basename } from "./paths.ts"

// WHICH OF NTWINE'S OWN VIEWERS A LOCAL FILE OPENS IN — or none, when only the desktop opener can show
// it. A click on a path used to launch an app for everything but Markdown: a screenshot a worker just
// took opened in whatever the OS maps `.png` to, which on a WSL box is a browser tab (maintainer
// 2026-09-28: "clicking on it should expand it in-app, not try to open externally in a browser. same
// with other file types we can trivially view"). The rule is now the reverse — anything the page can
// draw by itself is drawn here, and the escape hatch to the desktop opener rides in every viewer's
// header or footer as "Open":
//
//   · "image"    — the picture viewer (components/ImageViewer): the raster set `/local-image` serves,
//                  plus SVG, which the viewer renders from the file's TEXT as a `data:` image — where
//                  no script in it can run — because the image proxy deliberately never serves one.
//   · "markdown" — the reader, rendered.
//   · "text"     — the reader, as highlighted source.
//
// "text" is the DEFAULT, not an allowlist, on purpose. The reader already refuses binary with a plain
// "not a text file" (a NUL in the first 8 KiB, server-side), and a list of text extensions is exactly
// what sent a Makefile, a `.env.example` or a `.vue` file out to an editor while `.ts` stayed in. What is listed is
// the other side — formats whose bytes are not text and which a desktop app renders properly: the
// office, data and archive tiers of the attachment allowlist, PDF, media, fonts and compiled objects.
// PDF sits there although a browser can draw one, because the desktop shell enables no PDF plugin.
// Missing an entry costs one click on the reader's "Open", never a wrong answer.
export type LocalViewer = "image" | "markdown" | "text"

const VIEWABLE_IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i

// The subset of VIEWABLE_IMAGE that goes through `/local-image` (it must match that route's
// content-type map, as `PROXIED_IMAGE_PATH` in markdownTargets does). The rest — SVG — is read as text.
const RASTER_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i

const DESKTOP_ONLY: ReadonlySet<string> = new Set([
  "pdf",
  ...ATTACHMENT_OFFICE_EXTENSIONS,
  // `.ipynb` is JSON, but reading one as source is reading escaped cells — a notebook app renders it.
  ...ATTACHMENT_DATA_EXTENSIONS,
  ...ATTACHMENT_ARCHIVE_EXTENSIONS,
  "rar", "lz", "lzma", "jar", "war", "apk", "ipa", "dmg", "iso", "img", "pkg", "deb", "rpm", "msi", "svgz",
  "bmp", "ico", "icns", "tif", "tiff", "heic", "heif", "avif", "psd", "ai", "sketch", "fig", "xcf", "raw", "cr2", "nef", "dng",
  "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aiff", "mid", "midi",
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpg", "mpeg", "3gp",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "o", "a", "lib", "obj", "class", "pyc", "pyo", "wasm", "node", "pdb", "bin", "dat",
  "npy", "npz", "pkl", "pickle", "h5", "hdf5", "onnx", "pt", "pth", "ckpt", "safetensors", "gguf",
  "key", "numbers", "pages", "ds_store",
])

// An editor cursor suffix (`app.ts:12:3`) names the same file; strip it the way the server does.
function bare(path: string): string {
  return path.trim().replace(/:\d+(?::\d+)?$/, "")
}

function extensionOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.startsWith(".") ? name.slice(1).toLowerCase() : ""
}

/** The in-app viewer `path` opens in, or null when it belongs to the desktop opener. */
export function localViewerFor(path: string): LocalViewer | null {
  const file = bare(path)
  if (VIEWABLE_IMAGE.test(file)) return "image"
  if (isLocalMarkdownFile(file)) return "markdown"
  return DESKTOP_ONLY.has(extensionOf(file)) ? null : "text"
}

/** A picture `/local-image` serves, rather than one the viewer has to read as text (SVG). */
export function isRasterImagePath(path: string): boolean {
  return RASTER_IMAGE.test(bare(path))
}
