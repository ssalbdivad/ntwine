import { basename } from "../paths.ts"
// Filename → language id, for the highlighter. A small deliberate map: the languages ntwine agents
// actually touch, plus a plain fallback. Ported from gent's renderer, trimmed to what the tokenizer
// (highlight.ts) understands — anything mapping to "text" renders unhighlighted.
//
// "Trimmed to what the tokenizer understands" was an INTENTION, not a guarantee, and it had drifted:
// this map sent .yaml, .toml, .md and .html to ids `LANGS` had no entry for, so those files rendered
// with no colour at all and nothing said why. Three of the four now have grammars; the check against
// HIGHLIGHTED_LANGUAGES below is what stops the pair drifting apart again.

import { HIGHLIGHTED_LANGUAGES } from "./highlight.ts"

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".jsonc": "json",
  ".css": "css", ".scss": "css", ".less": "css",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".html": "html", ".htm": "html", ".xml": "html", ".svg": "html",
  // Markdown is deliberately absent. This tokenizer is a character scanner driven by
  // comment/string/keyword config, and markdown's structure is line-oriented and nestable — headings,
  // fences, emphasis. A half-right markdown mode reads worse than none, so a .md diff stays plain
  // until there is a renderer shaped for it.
}

const NAME_TO_LANG: Record<string, string> = {
  Dockerfile: "shell",
  Makefile: "shell",
  ".gitignore": "shell",
  ".env": "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
}

export function detectLang(path: string): string {
  // Both separators: a Windows worker reports `C:\repo\Makefile`, and splitting on "/" alone left
  // the whole path as the "name", so extension-less files never matched (Windows audit 2026-09-11).
  const name = basename(path)
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ""
  const lang = NAME_TO_LANG[name] ?? EXT_TO_LANG[ext] ?? "text"
  return HIGHLIGHTED_LANGUAGES.has(lang) ? lang : "text"
}
