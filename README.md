# Enrow MCP Server

MCP (Model Context Protocol) server for the [Enrow API](https://enrow.io). Find and verify professional emails, phone numbers, and contacts directly from any MCP-compatible AI assistant (Claude Desktop, Cursor, Windsurf, etc.).

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
| `find_phone` | Find a phone number from LinkedIn or name + company |
| `get_phone_result` | Retrieve a phone search result |
| `find_phones_bulk` | Find up to 5,000 phone numbers in one batch |
| `get_phones_bulk_result` | Retrieve bulk phone results |
| `get_account_info` | Check credit balance and webhooks |

## Setup

### 1. Get an API key

Register at [app.enrow.io](https://app.enrow.io) — 50 free credits, no credit card required.

### 2. Install

```bash
npm install -g @enrow/mcp
```

### 3. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "enrow": {
      "command": "enrow-mcp",
      "env": {
        "ENROW_API_KEY": "your_api_key"
      }
    }
  }
}
```

### 4. Configure Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "enrow": {
      "command": "npx",
      "args": ["-y", "@enrow/mcp"],
      "env": {
        "ENROW_API_KEY": "your_api_key"
      }
    }
  }
}
```

## Usage examples

Once configured, just ask your AI assistant:

- "Find the email for Tim Cook at Apple"
- "Verify if tim@apple.com is deliverable"
- "Find the phone number for this LinkedIn profile: linkedin.com/in/timcook"
- "Check my Enrow credit balance"
- "Find emails for these 3 people: [list]"

## Pricing

- **50 free credits** to start — no credit card required
- Email Finder: 1 credit/email found
- Email Verifier: 0.25 credits/check
- Phone Finder: 50 credits/phone found
- From **$17/mo** to **$497/mo** — [see pricing](https://enrow.io/pricing)

## Links

- [Enrow API Documentation](https://docs.enrow.io)
- [Full Enrow SDK](https://github.com/enrow/enrow-js)
- [MCP Protocol](https://modelcontextprotocol.io)

## License

MIT
