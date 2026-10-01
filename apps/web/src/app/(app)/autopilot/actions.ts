"use server";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";

export async function savePolicy(_p: { error?: string; ok?: boolean } | undefined, form: FormData): Promise<{ error?: string; ok?: boolean }> {
  const maxModelSpendUsd = Number(form.get("maxModelSpendUsd"));
  const maxActionsPerDay = Number(form.get("maxActionsPerDay"));
  if (!Number.isFinite(maxModelSpendUsd) || maxModelSpendUsd < 0 || !Number.isInteger(maxActionsPerDay) || maxActionsPerDay < 0) return { error: "Enter valid non-negative numbers." };
  try { await api("/v1/autopilot/policy", { method: "POST", body: { maxModelSpendUsd, maxActionsPerDay, mode: "zero_spend", maxExternalSpendUsd: 0 } }); }
  catch (e) { return { error: e instanceof ApiError && e.status === 403 ? "Only the organization owner can change policy." : "Could not save policy." }; }
  revalidatePath("/autopilot");
  return { ok: true };
}
