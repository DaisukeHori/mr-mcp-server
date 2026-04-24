# CLAUDE.md — mr-mcp-server

Context for LLMs (Claude Code, Cursor, etc.) working on this codebase.

## Project

MCP server that wraps [multi-runners](https://github.com/vbem/multi-runners) to let LLMs manage
GitHub Actions self-hosted runners. Target: individual GitHub accounts (no Organization required).

## Architecture

- **Language**: TypeScript (strict, ES2022, NodeNext modules)
- **Framework**: Express + `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`)
- **Runs on**: LXC 450 @ Proxmox, 192.168.70.201, same host as multi-runners install at /opt/multi-runners
- **Public endpoint**: https://mr-mcp.appserver.tokyo/mcp (Cloudflare Tunnel)
- **Auth**: single admin key via `?key=<ADMIN_KEY>`

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Express app, MCP endpoint, health endpoint, GitHub webhook auto-deploy |
| `src/services/mr-client.ts` | Wraps `mr.bash` via `child_process.exec` |
| `src/tools/runner-tools.ts` | Registers 6 MCP tools on the server |
| `deploy-lxc.sh` | One-shot LXC deploy (node install, clone, build, systemd) |
| `.env` | PORT, ADMIN_KEY, MR_DIR, DEFAULT_OWNER, WEBHOOK_SECRET |

## MCP tools exposed

1. `add_runner(owner?, repo, labels?, count?)`
2. `list_runners()`
3. `del_runner({user} | {owner, repo, count?})`
4. `get_runner_logs(user, lines?)`
5. `restart_runner(user)`
6. `health()`

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run compiled server (requires .env)
- `npm run dev` — `tsc --watch`

## Conventions

- Never run mr.bash with `sudo` directly from this server — mr.bash already handles sudo internally,
  and this server runs as root on the LXC.
- Never include shell metacharacters in unescaped `exec` args — always use `shellEscape()` in mr-client.ts.
- Always catch errors in tool handlers and return `{ isError: true, content: [...] }` to MCP, never throw.
- Keep tool descriptions informative — they are the primary documentation LLMs see.

## Deployment flow

1. Push to `main` → GitHub webhook fires → server `/webhook/github` endpoint verifies HMAC
2. Server runs `git pull && npm install && tsc` then calls `process.exit(0)`
3. systemd auto-restarts with new code
