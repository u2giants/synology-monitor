# Using 1Password in this repo

Two ways to pull secrets from 1Password instead of hardcoding them:

- **1Password MCP server** — lets AI coding agents (Claude, Codex, etc.) read and manage 1Password items through tools.
- **`op` CLI** — lets humans, scripts, and CI read secrets and inject them into environment variables.

Both authenticate with a **1Password Service Account token** and use **secret references** of the form `op://<vault>/<item>/<field>`.

> **Never commit secrets.** Store them in 1Password and reference them with `op://...`. Keep real `.env` files out of git.

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

- `vault_list`, `item_list`, `item_lookup`, `item_get`
- `password_read` (read a secret by `op://` reference or vault/item id)
- `password_create`, `password_update`, `password_generate`, `password_generate_memorable`
- `item_edit`, `item_delete`, `item_archive`, `note_create`

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

Common commands:

```bash
# Read a single secret to stdout
op read "op://<vault>/<item>/<field>"

# List vaults / items
op vault list
op item list --vault "<vault>"
op item get "<item>" --vault "<vault>"

# Run a command with secrets injected as env vars (values never touch disk)
op run -- <your-command>

# Fill a template: .env.tpl contains FOO=op://vault/item/field
op inject -i .env.tpl -o .env
```

Use `op://` references in committed templates (e.g. `.env.tpl`) and resolve them at runtime with `op run` / `op inject`, so real secret values never land in git.

### Secret reference format

```
op://<vault>/<item>/<field>
op://<vault>/<item>/<section>/<field>
```
