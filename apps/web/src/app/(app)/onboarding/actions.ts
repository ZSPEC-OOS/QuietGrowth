"use server";
import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";

export async function analyze(_p: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const url = String(form.get("url") ?? "");
  try { await api("/v1/onboarding/analyze", { method: "POST", body: { url } }); }
  catch (e) { return { error: e instanceof ApiError && e.status === 422 ? "That URL cannot be analysed (it must be a public http(s) site)." : "Could not analyse that URL." }; }
  redirect("/onboarding?step=2");
}

export async function defineFunnel(_p: { error?: string; errors?: string[] } | undefined, form: FormData): Promise<{ error?: string; errors?: string[] }> {
  const prod = await api<{ product: { id: string } | null }>("/v1/product");
  if (!prod.product) return { error: "Analyse your product first." };
  const num = Number(form.get("retentionWindowDays"));
  try {
    await api("/v1/funnel/define", { method: "POST", body: {
      productId: prod.product.id, signupEvent: String(form.get("signupEvent")), activationEvent: String(form.get("activationEvent")), primaryConversion: String(form.get("primaryConversion")),
      churnEvent: String(form.get("churnEvent") || "") || undefined, retentionEvent: String(form.get("retentionEvent") || "") || undefined,
      retentionWindowDays: num, billingSource: String(form.get("billingSource")), acquisitionObjective: "net new retained subscribers",
      guardrails: String(form.get("guardrails") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    } });
  } catch (e) { if (e instanceof ApiError && e.status === 422) return { errors: (e.body as { errors?: string[] })?.errors ?? ["Invalid funnel definition."] }; return { error: "Could not save the funnel." }; }
  redirect("/onboarding?step=3");
}
