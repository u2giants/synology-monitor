# Using 1Password in this repo

Two ways to pull secrets from 1Password instead of hardcoding them:

- **1Password MCP server** — lets AI coding agents (Claude, Codex, etc.) read and manage 1Password items through tools.
- **`op` CLI** — lets humans, scripts, and CI read secrets and inject them into environment variables.

Both authenticate with a **1Password Service Account token** and use **secret references** of the form `op://vibe_coding/<item>/<field>`.

> **Use the `vibe_coding` vault — and only `vibe_coding`.** It is the single vault every project and service account here uses; the service account can't see any other vault. All secret references must start with `op://vibe_coding/...`. Don't create or reference other vaults.

> **Never commit secrets.** Store them in the `vibe_coding` vault in 1Password and reference them with `op://vibe_coding/...`. Keep real `.env` files out of git.

## 1. 1Password MCP server (for AI clients)

`@u2giants/1password-mcp` is an MCP server that exposes 1Password tools to MCP-compatible clients (Claude Desktop, Claude Code, VS Code, OpenAI Codex, etc.).

Add it to your client config (example for Claude Desktop / Claude Code / VS Code):

```json
{
  "mcpServers": {
    "1password": {
      "command": "npx",
      "args": ["-y", "@u2giants/1password-mcp"],
      "env": {
        "OP_SERVICE_ACCOUNT_TOKEN": "<your-service-account-token>"
      }
    }
  }
}
```

OpenAI Codex (TOML), referencing an env var instead of storing the token in config:

```toml
[mcp_servers."1password"]
command = "npx"
args = ["-y", "@u2giants/1password-mcp"]
env_vars = ["OP_SERVICE_ACCOUNT_TOKEN"]
```

Once connected, the agent has tools including:

- `vault_list`, `item_list`, `item_lookup`, `item_get` (the service account only sees the `vibe_coding` vault)
- `password_read` (read a secret by `op://vibe_coding/...` reference or vault/item id)
- `password_create`, `password_update`, `password_generate`, `password_generate_memorable`
- `item_edit`, `item_delete`, `item_archive`, `note_create`

Create and read everything in the `vibe_coding` vault.

Source & full docs: https://github.com/u2giants/1Password-MCP (npm: `@u2giants/1password-mcp`).

## 2. `op` CLI (for humans, scripts, and CI)

Install the 1Password CLI (`op`): https://developer.1password.com/docs/cli/get-started/

Authenticate. For automation, use a Service Account token:

```bash
export OP_SERVICE_ACCOUNT_TOKEN="<your-service-account-token>"   # macOS/Linux
```
```powershell
$env:OP_SERVICE_ACCOUNT_TOKEN = "<your-service-account-token>"   # Windows PowerShell
```

(Interactive desktop users can instead run `op signin`.)

Common commands (always against the `vibe_coding` vault):

```bash
# Read a single secret to stdout
op read "op://vibe_coding/<item>/<field>"

# List items in the vibe_coding vault
op item list --vault vibe_coding
op item get "<item>" --vault vibe_coding

# Run a command with secrets injected as env vars (values never touch disk)
op run -- <your-command>

# Fill a template: .env.tpl contains FOO=op://vibe_coding/item/field
op inject -i .env.tpl -o .env
```

Use `op://vibe_coding/...` references in committed templates (e.g. `.env.tpl`) and resolve them at runtime with `op run` / `op inject`, so real secret values never land in git.

### Secret reference format

```
op://vibe_coding/<item>/<field>
op://vibe_coding/<item>/<section>/<field>
```
