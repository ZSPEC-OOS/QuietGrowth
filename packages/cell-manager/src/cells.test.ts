import { describe, expect, it } from "vitest";
import { AGENTS } from "@quietgrowth/agent-contracts";
import { CellError, DockerCellManager, PINNED_MODEL, buildTenantConfig, validateTenantConfig, type CommandRunner } from "./index.js";

const input = { orgId: "11111111-1111-1111-1111-111111111111", openclawImage: "registry.example/openclaw:2026.9.1", controlPlaneUrl: "https://api.quietgrowth.test", secretRefs: { deepseekApiKey: "sec_deepseek_x", internalSecret: "sec_internal_y" }, tokenCeilingPerRun: 20000 };
const runner = (script: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) => {
  const calls: string[][] = [];
  const r: CommandRunner = { run: async (cmd, args) => { calls.push([cmd, ...args]); const k = args[0]!; return { code: script[k]?.code ?? 0, stdout: script[k]?.stdout ?? "", stderr: script[k]?.stderr ?? "" }; } };
  return { r, calls };
};

describe("tenant config", () => {
  const cfg = buildTenantConfig(input);
  it("pins the model, denies host exec, binds loopback, and passes validation", () => {
    expect(cfg.model.primary).toBe(PINNED_MODEL);
    expect(cfg.hostExec).toEqual({ default: "deny", allowlist: [] });
    expect(validateTenantConfig(cfg)).toEqual([]);
    expect(Object.keys(cfg.agents).sort()).toEqual([...AGENTS].sort());
  });
  it("read-only agents carry no mutation tools; secrets are references only", () => {
    expect(cfg.agents["funnel-analyst"].mutation).toBe(false); expect(cfg.agents.research.mutation).toBe(false); expect(cfg.agents.director.mutation).toBe(false);
    expect(cfg.agents.acquisition.mutation).toBe(true);
    expect(JSON.stringify(cfg)).not.toMatch(/sk-/);
  });
  it("rejects unpinned images and flags weakened configs", () => {
    expect(() => buildTenantConfig({ ...input, openclawImage: "openclaw:latest" })).toThrow("latest");
    expect(() => buildTenantConfig({ ...input, openclawImage: "openclaw" })).toThrow();
    const weak = { ...cfg, hostExec: { default: "allow" as never, allowlist: [] }, gateway: { bind: "loopback" as const, authRequired: false as never } };
    expect(validateTenantConfig(weak).length).toBe(2);
  });
});

describe("DockerCellManager", () => {
  const cfg = buildTenantConfig(input);
  it("provisions a hardened, loopback-published, resource-limited container and is idempotent", async () => {
    const { r, calls } = runner(); const m = new DockerCellManager(r, 20000);
    const c = await m.provision(cfg); await m.provision(cfg);
    expect(calls.filter((x) => x[1] === "create")).toHaveLength(1);
    const args = calls[0]!.join(" ");
    expect(args).toContain("--read-only"); expect(args).toContain("--cap-drop=ALL"); expect(args).toContain("no-new-privileges"); expect(args).toContain("127.0.0.1:20000:8080"); expect(args).toContain("--memory=1024m");
    expect(args).not.toContain("0.0.0.0"); expect(c.port).toBe(20000);
  });
  it("allocates distinct ports per tenant and enforces the cell quota", async () => {
    const { r } = runner(); const m = new DockerCellManager(r, 20000, { maxCells: 2, memoryMb: 512, cpus: 1, pids: 100 });
    const a = await m.provision(cfg), b = await m.provision({ ...cfg, orgId: "22222222-2222-2222-2222-222222222222" });
    expect(a.port).not.toBe(b.port);
    await expect(m.provision({ ...cfg, orgId: "33333333-3333-3333-3333-333333333333" })).rejects.toThrow("quota");
  });
  it("refuses invalid configs and images outside the pinned set", async () => {
    const m = new DockerCellManager(runner().r, 20000, undefined, ["registry.example/openclaw:other"]);
    await expect(m.provision(cfg)).rejects.toThrow("allowed");
    await expect(new DockerCellManager(runner().r, 20000).provision({ ...cfg, hostExec: { default: "allow" as never, allowlist: [] } })).rejects.toThrow(CellError);
  });
  it("start/stop/destroy lifecycle and failure surfaces", async () => {
    const ok = new DockerCellManager(runner().r, 20000); await ok.provision(cfg);
    await ok.start(cfg.orgId); expect(ok.get(cfg.orgId)!.status).toBe("running");
    await ok.stop(cfg.orgId); expect(ok.get(cfg.orgId)!.status).toBe("stopped");
    await ok.destroy(cfg.orgId, true); expect(ok.get(cfg.orgId)).toBeUndefined();
    const bad = new DockerCellManager(runner({ start: { code: 1, stderr: "nope" } }).r, 20000); await bad.provision(cfg);
    await expect(bad.start(cfg.orgId)).rejects.toThrow("docker start failed"); expect(bad.get(cfg.orgId)!.status).toBe("unhealthy");
    await expect(ok.start("missing")).rejects.toThrow("no cell");
  });
  it("health detects non-running containers; restartUnhealthy is bounded; version drift reported", async () => {
    const m = new DockerCellManager(runner({ inspect: { code: 0, stdout: "exited|" } }).r, 20000, undefined, [cfg.image]);
    await m.provision(cfg); await m.start(cfg.orgId);
    expect((await m.health(cfg.orgId)).healthy).toBe(false); expect(m.get(cfg.orgId)!.status).toBe("unhealthy");
    expect(await m.restartUnhealthy(cfg.orgId, 2)).toBe(false);
    const drift = new DockerCellManager(runner().r, 20000, undefined, ["other:1"]); (drift as any).cells.set("o", { orgId: "o", image: "old:1", port: 1, instanceId: "i", status: "running" });
    expect(drift.versionDrift()).toHaveLength(1);
    const healthy = new DockerCellManager(runner({ inspect: { code: 0, stdout: "running|healthy" } }).r, 20000); await healthy.provision(cfg);
    expect((await healthy.health(cfg.orgId)).healthy).toBe(true);
  });
});
