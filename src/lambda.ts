/**
 * AWS Lambda handler for the Enrow MCP server. In production it sits behind an
 * API Gateway REST API with a Lambda proxy integration (payload 1.0: the
 * response carries `multiValueHeaders`). serverless-express reads the version
 * of the event, so an HTTP API (payload 2.0) would work as well.
 *
 * No Docker, no Lambda Web Adapter: serverless-express runs the shared Node HTTP
 * listener inside Lambda and bridges the API Gateway event to it. Deploy as a
 * plain zip with handler `dist/lambda.handler`.
 *
 * The REST API renames the `WWW-Authenticate` header of a Lambda response to
 * `x-amzn-remapped-www-authenticate`: its clients see a 401 status, not the
 * challenge that comes with it.
 */

import serverlessExpress from '@codegenie/serverless-express';
import { createChannelSecretProvider } from './channel-secret.js';
import { listener } from './http-handler.js';

// Signs upstream requests when a channel secret is configured.
const getChannelSecret = createChannelSecretProvider(process.env.CHANNEL_SECRET_PARAMETER);
await getChannelSecret();

export const handler = serverlessExpress({ app: (req, res) => listener(req, res, getChannelSecret) });
