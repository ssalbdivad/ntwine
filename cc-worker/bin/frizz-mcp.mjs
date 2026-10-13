#!/usr/bin/env node
// LEGACY: the name ntwine-mcp.mjs had before the Frizz -> Ntwine rename (2026-10-13). A worker session
// started before it still has this path in its MCP config, and starts the server lazily, so the path keeps
// working. Removal condition: cc-worker/bin/frizzctl.
import './ntwine-mcp.mjs';
