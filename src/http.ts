#!/usr/bin/env node

/**
 * Standalone Node HTTP server for the Enrow MCP Streamable HTTP transport.
 * Use this for local dev, PM2, App Runner, Fargate, or any container host.
 * (For AWS Lambda, `lambda.ts` wraps the same listener instead.)
 */

import { createServer } from 'node:http';
import { listener } from './http-handler.js';

const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';

createServer(listener).listen(PORT, () => {
  console.error(`Enrow MCP (Streamable HTTP) listening on :${PORT}${MCP_PATH}`);
});
