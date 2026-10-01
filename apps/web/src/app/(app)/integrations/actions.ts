"use server";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
const PROVIDERS = ["stripe", "ga4", "gsc", "github", "email", "google_ads", "deepseek"];
export async function connect(_p: { error?: string; ok?: string } | undefined, form: FormData): Promise<{ error?: string; ok?: string }> {
  const provider = String(form.get("provider")); const credential = String(form.get("credential") ?? "");
  if (!PROVIDERS.includes(provider) || !credential) return { error: "Choose a provider and paste a credential." };
  try { await api(`/v1/integrations/${provider}/connect`, { method: "POST", body: { credential } }); }
  catch (e) { return { error: e instanceof ApiError ? `Could not connect (${e.status}).` : "Could not connect." }; }
  revalidatePath("/integrations");
  return { ok: `${provider} connected.` };
}
