# Enrow MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/EnrowAPI/enrow-mcp)](https://github.com/EnrowAPI/enrow-mcp)
[![Last commit](https://img.shields.io/github/last-commit/EnrowAPI/enrow-mcp)](https://github.com/EnrowAPI/enrow-mcp/commits)

MCP (Model Context Protocol) server for the [Enrow API](https://enrow.io). Find and verify professional emails and phone numbers directly from any MCP-compatible AI assistant (Claude Desktop, Cursor, Windsurf, etc.).

## Tools

| Tool | Description |
|------|-------------|
| `find_email` | Find a professional email from a name + company |
| `get_email_result` | Retrieve an email search result |
| `find_emails_bulk` | Find up to 5,000 emails in one batch |
| `get_emails_bulk_result` | Retrieve bulk email results |
| `verify_email` | Verify if an email is deliverable (works on catch-all) |
| `get_verification_result` | Retrieve a verification result |
| `verify_emails_bulk` | Verify up to 5,000 emails in one batch |
| `get_verifications_bulk_result` | Retrieve bulk verification results |
| `find_phone` | Find a mobile phone number from a LinkedIn profile URL |
| `get_phone_result` | Retrieve a phone search result |
| `find_phones_bulk` | Find up to 3,000 phone numbers in one batch |
| `get_phones_bulk_result` | Retrieve bulk phone results |
| `get_account_info` | Check credit balance and webhooks |

## Setup

### Hosted server (recommended)

Enrow runs this server at `https://mcp.enrow.io/mcp` (Streamable HTTP). Add it to your assistant and sign in with your Enrow account (OAuth): there is no API key to copy, and it works on the free plan. Step-by-step guides for Claude, ChatGPT, Claude Code, Codex, Cursor, VS Code and other clients: [app.enrow.io/mcp](https://app.enrow.io/mcp).

For example, in Claude Code:

```bash
claude mcp add --transport http --scope user enrow https://mcp.enrow.io/mcp
```

On the free plan, the assistant runs single searches (emails, verifications, mobiles) with your credits, up to 300 searches every 30 days, 10 of them mobiles. The bulk tools need a paid plan.

### Run it locally (stdio)

The package is not published on npm: build it from this repository (Node.js 18 or later).

```bash
git clone https://github.com/EnrowAPI/enrow-mcp.git
cd enrow-mcp
npm ci
npm run build
```

The local server authenticates with an Enrow API key (`ENROW_API_KEY`), available on paid plans from the [API page](https://app.enrow.io/api).

Add it to your `claude_desktop_config.json` (Claude Desktop) or to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "enrow": {
      "command": "node",
      "args": ["/absolute/path/to/enrow-mcp/dist/index.js"],
      "env": {
        "ENROW_API_KEY": "your_api_key"
      }
    }
  }
}
```

## Remote / hosted (HTTP)

Besides local `stdio`, the server also ships a remote **Streamable HTTP** transport
(`enrow-mcp-http`, or `npm run start:http`) for self-hosting it as a shared,
multi-tenant connector — each request carries the caller's Enrow API key as
`Authorization: Bearer <key>` (or the `x-enrow-api-key` header), so nothing is
stored server-side.

## Usage examples

Once configured, just ask your AI assistant:

- "Find the email for Tim Cook at Apple"
- "Verify if tim@apple.com is deliverable"
- "Find the phone number for this LinkedIn profile: linkedin.com/in/timcook"
- "Check my Enrow credit balance"
- "Find emails for these 3 people: [list]"

## Pricing

- **50 free credits** to start, no credit card required
- Email Finder: 1 credit/email found
- Email Verifier: 0.25 credit/email search
- Phone Finder: 40 credits/phone found
- Plans from **$17/mo** to **$1,397/mo**: [see pricing](https://enrow.io/pricing)

## Links

- [Enrow API Documentation](https://docs.enrow.io)
- [Full Enrow SDK](https://github.com/EnrowAPI/enrow-js)
- [MCP Protocol](https://modelcontextprotocol.io)

## License

MIT
