// The extension's entry point, and the ONLY module with a value import of "vscode" — which exists solely
// inside an editor's extension host. Everything else takes the API as an argument, so it loads (and is
// unit-tested) under plain node. Design: ARCHITECTURE.md § VS Code extension.

import * as vscode from "vscode"
import { activateNtwine, type NtwineExtensionApi } from "./app.ts"

export function activate(context: vscode.ExtensionContext): NtwineExtensionApi {
  return activateNtwine(vscode, context)
}

// The socket closes through the context's subscriptions; nothing else holds the window open.
export function deactivate(): void {}
