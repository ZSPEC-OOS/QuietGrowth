import { describe, expect, it } from "vitest";
import { AssignmentRegistry, resolveFlag } from "./index.js";

const cfg = { experimentId: "e1", treatmentShare: 0.5, enabled: true };
describe("feature flags", () => {
  it("kill switch and disabled always return control", () => {
    expect(resolveFlag({ ...cfg, killSwitch: true }, "u1")).toEqual({ variant: "control", reason: "kill_switch" });
    expect(resolveFlag({ ...cfg, enabled: false }, "u1").variant).toBe("control");
  });
  it("registry keeps first assignment sticky and counts arms", () => {
    const r = new AssignmentRegistry();
    for (let i = 0; i < 200; i++) r.assign(cfg, `u${i}`, 1);
    const before = r.counts("e1");
    for (let i = 0; i < 200; i++) r.assign({ ...cfg, treatmentShare: 0.01 }, `u${i}`, 2);
    expect(r.counts("e1")).toEqual(before);
    expect(before.control).toBeGreaterThan(0); expect(before.treatment).toBeGreaterThan(0);
  });
});
