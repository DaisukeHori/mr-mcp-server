import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MrClient } from "../services/mr-client.js";

export function registerRunnerTools(server: McpServer, mr: MrClient): void {
  // ─────────────────────────────────────────────
  // 1. add_runner
  // ─────────────────────────────────────────────
  server.tool(
    "add_runner",
    `Add a GitHub Actions self-hosted runner for a specific repository on this host.

This works with **individual GitHub accounts** (no Organization required).
After the runner is added, writing \`runs-on: [self-hosted, managed-by-mr]\`
(or any of the specified labels) in a workflow file in that repository will
cause the workflow to run on this host.

The default label 'managed-by-mr' is always attached unless you override 'labels'.

Common use cases:
- User wants CI/CD on a new personal repo → call add_runner with owner+repo
- Need more parallel capacity for an active repo → call with count>1

Returns: the newly created Linux user(s) (e.g. 'runner-3') and systemd service name(s).`,
    {
      owner: z
        .string()
        .optional()
        .describe(
          "GitHub account name (user or organization) that owns the repository. Optional if DEFAULT_OWNER is set on the server.",
        ),
      repo: z.string().describe("GitHub repository name (without the owner prefix)."),
      labels: z
        .array(z.string())
        .optional()
        .describe(
          "Extra labels to attach to the runner. Defaults to ['managed-by-mr']. The built-in 'self-hosted', 'Linux', 'X64' labels are always present.",
        ),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of runners to create for this repo. Defaults to 1."),
    },
    async (input) => {
      try {
        const result = await mr.addRunner(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `add_runner failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  // ─────────────────────────────────────────────
  // 2. list_runners
  // ─────────────────────────────────────────────
  server.tool(
    "list_runners",
    `List all self-hosted GitHub Actions runners managed by multi-runners on this host.

Returns an array of runner entries. Each entry includes:
- user: local Linux username (e.g. 'runner-0')
- owner / repo: GitHub repository this runner is bound to
- url: full GitHub URL
- status: 'active' | 'inactive' | 'failed' | 'unknown' (systemd state)
- memory: disk usage of the runner's home (approximate)
- service: systemd unit name

Use this to audit current runners, find idle ones, or locate a runner by repo.`,
    {},
    async () => {
      try {
        const runners = await mr.listRunners();
        return {
          content: [{ type: "text", text: JSON.stringify({ count: runners.length, runners }, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `list_runners failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  // ─────────────────────────────────────────────
  // 3. del_runner
  // ─────────────────────────────────────────────
  server.tool(
    "del_runner",
    `Delete one or more self-hosted runners from this host. This also unregisters them from GitHub.

Two selection modes:
1) Delete by local user: pass only 'user' (e.g. 'runner-3'). Deletes exactly that runner.
2) Delete by GitHub repo: pass 'owner' + 'repo'. Deletes all runners bound to that repo
   (or limit with 'count'). DEFAULT_OWNER fills in 'owner' if omitted.

Irreversible — the runner's Linux user and home directory are removed, and GitHub's
runner list is cleaned up via the registration API.`,
    {
      user: z
        .string()
        .optional()
        .describe(
          "Local Linux username of the runner (e.g. 'runner-3'). Mutually exclusive with owner/repo.",
        ),
      owner: z
        .string()
        .optional()
        .describe("GitHub account name. Used with 'repo' to delete by repository."),
      repo: z.string().optional().describe("GitHub repository name. Used with 'owner'."),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("When deleting by owner/repo, limit how many runners to remove. Omit to remove all matches."),
    },
    async (input) => {
      try {
        const result = await mr.delRunner(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `del_runner failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  // ─────────────────────────────────────────────
  // 4. get_runner_logs
  // ─────────────────────────────────────────────
  server.tool(
    "get_runner_logs",
    `Retrieve recent systemd journal logs for a specific runner. Useful for debugging
why a runner is offline, failing to pick up jobs, or exiting unexpectedly.`,
    {
      user: z.string().describe("Local Linux username of the runner (e.g. 'runner-3')."),
      lines: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Number of journal lines to retrieve. Default 50, max 1000."),
    },
    async ({ user, lines }) => {
      try {
        const result = await mr.getRunnerLogs(user, lines);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `get_runner_logs failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  // ─────────────────────────────────────────────
  // 5. restart_runner
  // ─────────────────────────────────────────────
  server.tool(
    "restart_runner",
    `Restart a specific runner's systemd service. Use when a runner is stuck or
has consumed excess memory. The runner reconnects to GitHub on startup.`,
    {
      user: z.string().describe("Local Linux username of the runner to restart (e.g. 'runner-3')."),
    },
    async ({ user }) => {
      try {
        const result = await mr.restartRunner(user);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `restart_runner failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  // ─────────────────────────────────────────────
  // 6. health
  // ─────────────────────────────────────────────
  server.tool(
    "health",
    `Self-diagnostic of the mr-mcp-server host. Returns hostname, IP, total/active runner count,
multi-runners version, disk usage, and whether mr.bash is installed.

Run this first if runner operations are failing, to verify the host itself is healthy.`,
    {},
    async () => {
      try {
        const stats = await mr.healthCheck();
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `health failed: ${(err as Error).message}` }],
        };
      }
    },
  );
}
