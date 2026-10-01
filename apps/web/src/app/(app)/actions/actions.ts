"use server";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

export async function decide(form: FormData): Promise<void> {
  const id = String(form.get("id"));
  const op = String(form.get("op"));
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  if (op === "approve") { await api(`/v1/actions/${id}/approve`, { method: "POST", body: {} }); await api(`/v1/actions/${id}/run`, { method: "POST", body: {} }).catch(() => undefined); }
  else if (op === "reject") await api(`/v1/actions/${id}/reject`, { method: "POST", body: { reason: String(form.get("reason") || "Rejected by owner") } });
  revalidatePath("/actions");
}
