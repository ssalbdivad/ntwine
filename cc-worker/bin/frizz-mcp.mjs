#!/usr/bin/env node
// LEGACY: the name ntwine-mcp.mjs had before the Frizz -> Ntwine rename (2026-10-13). A worker session
// started before it still has this path in its MCP config, and starts the server lazily, so the path keeps
// working. REMOVE with the rest of the old name (packages/shared/src/legacy-frizz.ts).
import './ntwine-mcp.mjs';
