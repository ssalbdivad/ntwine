// HOST CLIPBOARD IMAGE READER — reads an image (screenshot, copied image, or copied image file) from
// the macOS pasteboard when the sidebar asks for the clipboard on ⌘V (framed-page.ts).
//
// VS Code's `env.clipboard` exposes text only, and VS Code's webview refuses `navigator.clipboard.read()`
// inside the cross-origin ntwine iframe on macOS. Running `osascript -l JavaScript` against AppKit's
// `NSPasteboard` needs no native binary and handles PNG, JPEG, WebP, GIF, TIFF (converted to PNG via
// `NSBitmapImageRep`), and Finder image file copies (`public.file-url`) without ever grabbing Finder's
// `public.tiff` file icon for a non-image file.

import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { basename, extname } from "node:path"
import {
  EMBED_CLIPBOARD_IMAGE_MIMES,
  EMBED_CLIPBOARD_MAX_BASE64_CHARS,
  EMBED_CLIPBOARD_MAX_BYTES,
  type EmbedClipboardImage,
  type EmbedClipboardImageMime,
} from "@ntwine/shared/embed-protocol"

const ALLOWED_MIMES = new Set<string>(EMBED_CLIPBOARD_IMAGE_MIMES)

const EXT_TO_MIME: Readonly<Record<string, EmbedClipboardImageMime>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/** Allowed raster image MIME type for a filename/path, or undefined for anything else. */
export function imageMimeForPath(filePath: string): EmbedClipboardImageMime | undefined {
  return EXT_TO_MIME[extname(filePath).toLowerCase()]
}

/**
 * JXA script that inspects `NSPasteboard.generalPasteboard` (or a named pasteboard, for tests) and
 * returns JSON: either `{ filePath }` for a file copy, `{ mime, base64 }` for a raster image, or `""`.
 */
export function macPasteboardScript(maxBytes = EMBED_CLIPBOARD_MAX_BYTES, pasteboardName?: string): string {
  const pbExpr = pasteboardName
    ? `$.NSPasteboard.pasteboardWithName(${JSON.stringify(pasteboardName)})`
    : "$.NSPasteboard.generalPasteboard"
  return `
ObjC.import("AppKit");
const present = (o) => o && !(typeof o.isNil === "function" && o.isNil());
const pb = ${pbExpr};
const types = present(pb) ? (ObjC.deepUnwrap(pb.types) || []) : [];
const has = (t) => types.indexOf(t) !== -1;
const maxBytes = ${Math.floor(maxBytes)};
let out = "";
if (has("public.file-url")) {
  // Copying any file in Finder also puts its icon on the pasteboard as public.tiff.
  // Never fall through to public.tiff for a file copy: hand the path to Node instead.
  const rawUrl = pb.stringForType("public.file-url");
  const urlStr = present(rawUrl) ? ObjC.unwrap(rawUrl) : "";
  if (urlStr) {
    const nsUrl = $.NSURL.URLWithString(urlStr);
    const fileUrl = present(nsUrl) ? nsUrl.filePathURL : null;
    const p = present(fileUrl) && present(fileUrl.path) ? ObjC.unwrap(fileUrl.path) : "";
    if (p) out = JSON.stringify({ filePath: p });
  }
} else {
  const direct = [
    ["public.png", "image/png"],
    ["public.jpeg", "image/jpeg"],
    ["org.webmproject.webp", "image/webp"],
    ["com.compuserve.gif", "image/gif"],
  ];
  let matchedDirect = false;
  for (const [uti, mime] of direct) {
    if (!has(uti)) continue;
    const data = pb.dataForType(uti);
    if (!present(data)) continue;
    const len = Number(data.length);
    if (len <= 0) continue;
    matchedDirect = true;
    if (len <= maxBytes) {
      out = JSON.stringify({ mime, base64: ObjC.unwrap(data.base64EncodedStringWithOptions(0)) });
    }
    break;
  }
  if (!matchedDirect && has("public.tiff")) {
    const tiff = pb.dataForType("public.tiff");
    if (present(tiff) && Number(tiff.length) > 0) {
      const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
      const png = present(rep) ? rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})) : null;
      if (present(png)) {
        const len = Number(png.length);
        if (len > 0 && len <= maxBytes) {
          out = JSON.stringify({ mime: "image/png", base64: ObjC.unwrap(png.base64EncodedStringWithOptions(0)) });
        }
      }
    }
  }
}
out;
`.trim()
}

export type ParsedClipboardOutput =
  | { kind: "image"; image: EmbedClipboardImage }
  | { kind: "file"; filePath: string }
  | { kind: "none" }

/** Parse and validate the stdout of `macPasteboardScript`. */
export function parseClipboardOutput(raw: string, maxBase64Chars = EMBED_CLIPBOARD_MAX_BASE64_CHARS): ParsedClipboardOutput {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: "none" }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { kind: "none" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "none" }
  const record = parsed as Record<string, unknown>
  if (typeof record.filePath === "string" && record.filePath.length > 0) {
    return { kind: "file", filePath: record.filePath }
  }
  if (
    typeof record.mime === "string" &&
    ALLOWED_MIMES.has(record.mime) &&
    typeof record.base64 === "string" &&
    record.base64.length > 0 &&
    record.base64.length <= maxBase64Chars
  ) {
    return { kind: "image", image: { mime: record.mime as EmbedClipboardImageMime, base64: record.base64 } }
  }
  return { kind: "none" }
}

/** Read an image file from disk if its extension is an allowed raster image and its size is within budget. */
export async function readClipboardImageFile(filePath: string, maxBytes = EMBED_CLIPBOARD_MAX_BYTES): Promise<EmbedClipboardImage | undefined> {
  const mime = imageMimeForPath(filePath)
  if (!mime) return undefined
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return undefined
    const buf = await readFile(filePath)
    if (buf.length === 0 || buf.length > maxBytes) return undefined
    const name = basename(filePath)
    return { mime, base64: buf.toString("base64"), ...(name && name.length <= 255 ? { name } : {}) }
  } catch {
    return undefined
  }
}

export interface ReadClipboardImageOptions {
  platform?: NodeJS.Platform
  pasteboardName?: string
  maxBytes?: number
  timeoutMs?: number
}

/** Read an image from the macOS clipboard, or undefined if none is present or on another platform. */
export async function readClipboardImage(options: ReadClipboardImageOptions = {}): Promise<EmbedClipboardImage | undefined> {
  const platform = options.platform ?? process.platform
  if (platform !== "darwin") return undefined
  const maxBytes = options.maxBytes ?? EMBED_CLIPBOARD_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? 4000
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", macPasteboardScript(maxBytes, options.pasteboardName)],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: EMBED_CLIPBOARD_MAX_BASE64_CHARS + 1024 * 1024 },
      (err, out) => resolve(err ? "" : out),
    )
  })
  const parsed = parseClipboardOutput(stdout)
  if (parsed.kind === "image") return parsed.image
  if (parsed.kind === "file") return readClipboardImageFile(parsed.filePath, maxBytes)
  return undefined
}
