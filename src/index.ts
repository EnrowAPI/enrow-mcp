#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEnrowServer } from './server.js';

function requireEnvKey(): string {
  const key = process.env.ENROW_API_KEY;
  if (!key) throw new Error('ENROW_API_KEY environment variable is required');
  return key;
}

// Fail fast at startup if the key is missing (local/desktop usage).
requireEnvKey();

const server = createEnrowServer(requireEnvKey);
const transport = new StdioServerTransport();
await server.connect(transport);
