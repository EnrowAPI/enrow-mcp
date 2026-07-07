/**
 * AWS Lambda handler for the Enrow MCP server (API Gateway HTTP API, payload v2).
 *
 * No Docker, no Lambda Web Adapter: serverless-express runs the shared Node HTTP
 * listener inside Lambda and bridges the API Gateway event to it. Deploy as a
 * plain zip with handler `dist/lambda.handler`.
 */

import serverlessExpress from '@codegenie/serverless-express';
import { listener } from './http-handler.js';

export const handler = serverlessExpress({ app: listener });
