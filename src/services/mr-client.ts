import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";

const execAsync = promisify(exec);

export interface RunnerInfo {
  user: string;
  owner: string;
  repo: string;
  enterprise: string;
  url: string;
  status: "active" | "inactive" | "failed" | "unknown";
  memory: string;
  service: string;
}

export interface AddRunnerResult {
  owner: string;
  repo: string;
  url: string;
  users: string[];
  services: string[];
  raw: string;
}

export interface DelRunnerResult {
  removed: string[];
  raw: string;
}

export interface HealthStats {
  lxc_hostname: string;
  ip: string;
  mr_dir: string;
  mr_version: string;
  total_runners: number;
  active_runners: number;
  inactive_runners: number;
  disk_used_human: string;
  multi_runners_exists: boolean;
}

export class MrClient {
  constructor(
    private readonly mrDir: string,
    private readonly defaultOwner: string,
  ) {}

  /** Resolve owner with fallback to DEFAULT_OWNER */
  resolveOwner(input?: string): string {
    const owner = (input && input.trim()) || this.defaultOwner;
    if (!owner) {
      throw new Error("owner is required (no DEFAULT_OWNER configured)");
    }
    return owner;
  }

  /** Run mr.bash with args and return stdout */
  private async runMr(args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
    const cmd = `cd ${shellEscape(this.mrDir)} && ./mr.bash ${args.map(shellEscape).join(" ")}`;
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout, stderr };
  }

  /** Run an arbitrary shell command (for systemctl, journalctl etc.) */
  private async runShell(cmd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
    return await execAsync(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  }

  // ─────────────────────────────────────────────
  // add_runner
  // ─────────────────────────────────────────────
  async addRunner(params: {
    owner?: string;
    repo: string;
    labels?: string[];
    count?: number;
  }): Promise<AddRunnerResult> {
    const owner = this.resolveOwner(params.owner);
    const repo = params.repo;
    const labels = params.labels && params.labels.length ? params.labels : ["managed-by-mr"];
    const count = Math.max(1, params.count ?? 1);

    // Capture the list of runner-N users BEFORE adding, to detect new ones
    const beforeUsers = await this.readRunnerUsers();

    const args = ["add", "--org", owner, "--repo", repo, "--labels", labels.join(",")];
    if (count > 1) args.push("--count", String(count));

    const { stdout, stderr } = await this.runMr(args, 180_000);
    const raw = (stdout + "\n" + stderr).trim();

    const afterUsers = await this.readRunnerUsers();
    const newUsers = afterUsers.filter((u) => !beforeUsers.includes(u));

    const services = newUsers.map(
      (u) => `actions.runner.${owner}-${repo}.${u}@gha-runner.service`,
    );

    return {
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
      users: newUsers,
      services,
      raw: tailLines(raw, 20),
    };
  }

  // ─────────────────────────────────────────────
  // list_runners
  // ─────────────────────────────────────────────
  async listRunners(): Promise<RunnerInfo[]> {
    const users = await this.readRunnerUsers();
    const runners: RunnerInfo[] = [];

    for (const user of users) {
      try {
        const info = await this.readRunnerMeta(user);
        runners.push(info);
      } catch (err) {
        // ignore broken runners
        console.error(`[mr-client] failed reading runner ${user}:`, (err as Error).message);
      }
    }
    return runners;
  }

  private async readRunnerUsers(): Promise<string[]> {
    try {
      const { stdout } = await this.runShell(
        "getent group 'runners' | cut -d: -f4 | tr ',' '\\n' | sort -g",
      );
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  private async readRunnerMeta(user: string): Promise<RunnerInfo> {
    const home = `/home/${user}/runner`;
    const mrDir = `${home}/mr.d`;

    const [org, repo, enterprise, url] = await Promise.all([
      safeReadFile(`${mrDir}/org`),
      safeReadFile(`${mrDir}/repo`),
      safeReadFile(`${mrDir}/enterprise`),
      safeReadFile(`${mrDir}/url`),
    ]);

    // systemd service status
    const serviceName =
      enterprise
        ? `actions.runner.${enterprise}.${user}@gha-runner.service`
        : repo
          ? `actions.runner.${org}-${repo}.${user}@gha-runner.service`
          : `actions.runner.${org}.${user}@gha-runner.service`;

    let status: RunnerInfo["status"] = "unknown";
    try {
      const { stdout } = await this.runShell(
        `systemctl is-active ${shellEscape(serviceName)} 2>&1`,
      );
      const active = stdout.trim();
      if (active === "active") status = "active";
      else if (active === "inactive") status = "inactive";
      else if (active === "failed") status = "failed";
      else status = "unknown";
    } catch {
      status = "unknown";
    }

    // disk usage of home
    let memory = "unknown";
    try {
      const { stdout } = await this.runShell(
        `sudo -Hiu ${shellEscape(user)} -- du -h --summarize 2>/dev/null | cut -f1`,
      );
      memory = stdout.trim() || "unknown";
    } catch {
      /* ignore */
    }

    return {
      user,
      owner: org,
      repo,
      enterprise,
      url,
      status,
      memory,
      service: serviceName,
    };
  }

  // ─────────────────────────────────────────────
  // del_runner
  // ─────────────────────────────────────────────
  async delRunner(params: {
    user?: string;
    owner?: string;
    repo?: string;
    count?: number;
  }): Promise<DelRunnerResult> {
    const { user, owner: rawOwner, repo, count } = params;

    if (!user && !(rawOwner || repo)) {
      throw new Error("Either `user` or `owner`+`repo` must be provided");
    }

    const args: string[] = ["del"];
    if (user) {
      args.push("--user", user);
    } else {
      const owner = this.resolveOwner(rawOwner);
      args.push("--org", owner);
      if (repo) args.push("--repo", repo);
      if (count && count > 0) args.push("--count", String(count));
    }

    const beforeUsers = await this.readRunnerUsers();
    const { stdout, stderr } = await this.runMr(args, 120_000);
    const afterUsers = await this.readRunnerUsers();
    const removed = beforeUsers.filter((u) => !afterUsers.includes(u));

    return {
      removed,
      raw: tailLines((stdout + "\n" + stderr).trim(), 20),
    };
  }

  // ─────────────────────────────────────────────
  // get_runner_logs
  // ─────────────────────────────────────────────
  async getRunnerLogs(user: string, lines = 50): Promise<{ service: string; logs: string }> {
    // Detect service name
    const runners = await this.listRunners();
    const r = runners.find((x) => x.user === user);
    if (!r) throw new Error(`Runner not found: ${user}`);

    const { stdout } = await this.runShell(
      `journalctl -u ${shellEscape(r.service)} -n ${Math.max(1, Math.min(1000, lines))} --no-pager`,
      30_000,
    );
    return { service: r.service, logs: stdout };
  }

  // ─────────────────────────────────────────────
  // restart_runner
  // ─────────────────────────────────────────────
  async restartRunner(user: string): Promise<{ service: string; restarted: boolean; status: string }> {
    const runners = await this.listRunners();
    const r = runners.find((x) => x.user === user);
    if (!r) throw new Error(`Runner not found: ${user}`);

    await this.runShell(`systemctl restart ${shellEscape(r.service)}`, 30_000);

    // Verify
    const { stdout: active } = await this.runShell(
      `systemctl is-active ${shellEscape(r.service)} 2>&1`,
    );
    return {
      service: r.service,
      restarted: true,
      status: active.trim(),
    };
  }

  // ─────────────────────────────────────────────
  // health
  // ─────────────────────────────────────────────
  async healthCheck(): Promise<HealthStats> {
    const mrExists = existsSync(pathResolve(this.mrDir, "mr.bash"));
    const runners = mrExists ? await this.listRunners() : [];

    const [hostname, ipLine, dfLine, mrVersion] = await Promise.all([
      this.runShell("hostname").then((r) => r.stdout.trim()).catch(() => "unknown"),
      this.runShell("ip -4 -br addr show eth0 2>/dev/null || ip -4 -br addr show 2>/dev/null | head -1")
        .then((r) => r.stdout.trim())
        .catch(() => "unknown"),
      this.runShell("df -h / | tail -1 | awk '{print $3 \" / \" $2}'")
        .then((r) => r.stdout.trim())
        .catch(() => "unknown"),
      mrExists
        ? this.runShell(`cd ${shellEscape(this.mrDir)} && git describe --tags --always 2>/dev/null || echo unknown`)
            .then((r) => r.stdout.trim())
            .catch(() => "unknown")
        : Promise.resolve("not_installed"),
    ]);

    return {
      lxc_hostname: hostname,
      ip: ipLine,
      mr_dir: this.mrDir,
      mr_version: mrVersion,
      total_runners: runners.length,
      active_runners: runners.filter((r) => r.status === "active").length,
      inactive_runners: runners.filter((r) => r.status !== "active").length,
      disk_used_human: dfLine,
      multi_runners_exists: mrExists,
    };
  }
}

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────
function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_\-./=:,@+]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function safeReadFile(path: string): Promise<string> {
  try {
    const buf = await readFile(path, "utf8");
    return buf.trim();
  } catch {
    return "";
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(lines.length - n).join("\n");
}
