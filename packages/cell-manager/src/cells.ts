import type { TenantConfig } from "./config.js";
import { validateTenantConfig } from "./config.js";

// Container-per-tenant cell lifecycle (MR §7.3 hosted alpha, §21.7). Docker is driven through an injected runner.
export interface CommandRunner { run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }

export interface CellRecord { orgId: string; instanceId: string; image: string; port: number; status: "provisioned" | "running" | "stopped" | "unhealthy" }

export interface CellQuota { maxCells: number; memoryMb: number; cpus: number; pids: number }
export const DEFAULT_QUOTA: CellQuota = { maxCells: 200, memoryMb: 1024, cpus: 1, pids: 256 };

export class CellError extends Error { override name = "CellError"; }

const nameFor = (orgId: string): string => `qg-cell-${orgId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;

export class DockerCellManager {
  private readonly cells = new Map<string, CellRecord>();
  constructor(private readonly docker: CommandRunner, private readonly basePort: number, private readonly quota: CellQuota = DEFAULT_QUOTA, private readonly allowedImages: string[] = []) {}

  /** Replaces the in-memory registry with persisted records (stateless hosts rebuild it per request). */
  hydrate(records: CellRecord[]): void { this.cells.clear(); for (const r of records) this.cells.set(r.orgId, { ...r }); }
  list(): CellRecord[] { return [...this.cells.values()]; }
  get(orgId: string): CellRecord | undefined { return this.cells.get(orgId); }

  private nextPort(): number {
    const used = new Set([...this.cells.values()].map((c) => c.port));
    for (let p = this.basePort; p < this.basePort + this.quota.maxCells; p++) if (!used.has(p)) return p;
    throw new CellError("no free cell ports (quota)");
  }

  async provision(cfg: TenantConfig): Promise<CellRecord> {
    const errs = validateTenantConfig(cfg);
    if (errs.length) throw new CellError(`invalid tenant config: ${errs.join("; ")}`);
    if (this.allowedImages.length && !this.allowedImages.includes(cfg.image)) throw new CellError("image not in allowed (pinned) set");
    const existing = this.cells.get(cfg.orgId);
    if (existing) return existing; // idempotent
    if (this.cells.size >= this.quota.maxCells) throw new CellError("cell quota reached");
    const port = this.nextPort(), name = nameFor(cfg.orgId);
    // Hardened, resource-limited, loopback-only publish; one cell per org; no shared volumes between tenants.
    const r = await this.docker.run("docker", [
      "create", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      `--memory=${this.quota.memoryMb}m`, `--cpus=${this.quota.cpus}`, `--pids-limit=${this.quota.pids}`,
      "-p", `127.0.0.1:${port}:8080`, "--label", `qg.org=${cfg.orgId}`, "--label", `qg.image=${cfg.image}`,
      "--tmpfs", "/tmp", "-v", `${name}-state:/state`, "-e", `QG_TENANT_CONFIG=${Buffer.from(JSON.stringify(cfg)).toString("base64")}`, cfg.image,
    ]);
    if (r.code !== 0) throw new CellError(`docker create failed: ${r.stderr.trim()}`);
    const rec: CellRecord = { orgId: cfg.orgId, instanceId: name, image: cfg.image, port, status: "provisioned" };
    this.cells.set(cfg.orgId, rec);
    return rec;
  }

  private must(orgId: string): CellRecord { const c = this.cells.get(orgId); if (!c) throw new CellError("no cell for organization"); return c; }

  async start(orgId: string): Promise<void> {
    const c = this.must(orgId);
    const r = await this.docker.run("docker", ["start", c.instanceId]);
    if (r.code !== 0) { c.status = "unhealthy"; throw new CellError(`docker start failed: ${r.stderr.trim()}`); }
    c.status = "running";
  }
  async stop(orgId: string): Promise<void> {
    const c = this.must(orgId);
    await this.docker.run("docker", ["stop", "-t", "20", c.instanceId]);
    c.status = "stopped";
  }
  async destroy(orgId: string, deleteState: boolean): Promise<void> {
    const c = this.must(orgId);
    await this.docker.run("docker", ["rm", "-f", c.instanceId]);
    if (deleteState) await this.docker.run("docker", ["volume", "rm", `${c.instanceId}-state`]);
    this.cells.delete(orgId);
  }

  /** Health policy (MR §27): unhealthy cell => stop dispatch; restart attempts are bounded. */
  async health(orgId: string): Promise<{ healthy: boolean; detail: string }> {
    const c = this.must(orgId);
    const r = await this.docker.run("docker", ["inspect", "-f", "{{.State.Status}}|{{.State.Health.Status}}", c.instanceId]);
    const [state] = r.stdout.trim().split("|");
    const healthy = r.code === 0 && state === "running";
    if (!healthy && c.status === "running") c.status = "unhealthy";
    return { healthy, detail: r.code === 0 ? r.stdout.trim() : r.stderr.trim() };
  }

  async restartUnhealthy(orgId: string, maxAttempts = 3): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      if ((await this.health(orgId)).healthy) return true;
      try { await this.start(orgId); } catch { /* retry */ }
    }
    return (await this.health(orgId)).healthy;
  }

  /** Runtime version pinning check: every cell must run an allowed image. Returns offenders. */
  versionDrift(): CellRecord[] { return this.allowedImages.length ? this.list().filter((c) => !this.allowedImages.includes(c.image)) : []; }
}

/** Runs the real docker CLI. Only enable on hosts that have a Docker daemon (never on serverless platforms). */
export function nodeCommandRunner(spawnFn: typeof import("node:child_process").spawn): CommandRunner {
  return { run: (cmd, args) => new Promise((resolve) => {
    const p = spawnFn(cmd, args); let out = "", err = "";
    p.stdout?.on("data", (d) => (out += d)); p.stderr?.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: 127, stdout: out, stderr: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  }) };
}

/** Used where no container runtime exists: every cell operation fails with a clear, non-leaky error. */
export const unavailableRunner: CommandRunner = { run: async () => ({ code: 127, stdout: "", stderr: "container runtime not available in this deployment" }) };
