# mr-mcp-server

MCP server for managing [multi-runners](https://github.com/vbem/multi-runners) — self-hosted GitHub Actions runners on a single host.

**Key feature**: works with individual GitHub accounts, **no Organization required**.

## What it does

Provides MCP tools that let LLMs (Claude.ai, Claude Code, Cursor, etc.) manage GitHub Actions self-hosted runners:

- `add_runner` — Add a runner for a given repository (owner/repo pair)
- `list_runners` — List all runners on this host
- `del_runner` — Remove a runner by user, or by owner/repo
- `get_runner_logs` — Retrieve systemd journal logs of a runner
- `restart_runner` — Restart a runner service
- `health` — Self-diagnostic (disk, runner count, multi-runners version)

## Why it exists

GitHub doesn't allow a single self-hosted runner to cover all repositories under an individual account. The official options are:
- Repository-level runners (one runner per repo)
- Organization-level runners (requires Organization)
- Enterprise-level runners (requires Enterprise plan)

[multi-runners](https://github.com/vbem/multi-runners) works around this by running multiple independent repo-level runners on one host. This MCP server wraps it so LLMs can trigger runner operations with a single tool call.

## Architecture

```
Claude.ai / Claude Code / Cursor / etc.
   │
   │ HTTPS (MCP protocol)
   ▼
https://mr-mcp.appserver.tokyo/mcp?key=...
   │
   │ Cloudflare Tunnel
   ▼
LXC 450 @ Proxmox (self-hosted)
   │
   ├─ cloudflared (systemd)
   ├─ mr-mcp-server (Node.js, systemd)
   └─ /opt/multi-runners/mr.bash  ← existing install
      └─ /home/runner-N/runner/   ← N self-hosted runners
```

## Deployment

See `deploy-lxc.sh` for one-shot LXC deployment.

Environment variables:
- `PORT` (default: 4000)
- `ADMIN_KEY` — required. HTTP `?key=` must match this for MCP tool calls.
- `MR_DIR` (default: `/opt/multi-runners`) — path to multi-runners install
- `DEFAULT_OWNER` — default GitHub username (optional, reduces parameters)
- `WEBHOOK_SECRET` — for GitHub push → auto-deploy

## License

MIT
