// Console › Clients. Keys are created by RPCs, returned once and stored only as sha256.

import { db, orThrow } from "@/lib/supabase-query";

export type ClientRow = {
  id: string;
  name: string;
  contact_email: string;
  key_prefix: string;
  status: "active" | "revoked";
  created_at: string;
  last_seen_at: string | null;
  last_seq: number;
};

export async function fetchClients(): Promise<ClientRow[]> {
  return (orThrow(
    await db().from("clients").select("id, name, contact_email, key_prefix, status, created_at, last_seen_at, last_seq").order("name"),
  ) ?? []) as ClientRow[];
}

export async function createClient(name: string, contactEmail: string): Promise<string> {
  const rows = orThrow(await db().rpc("create_client", { p_name: name.trim(), p_contact_email: contactEmail.trim() })) ?? [];
  return rows[0].client_key;
}

export async function rotateClientKey(id: string): Promise<string> {
  return orThrow(await db().rpc("rotate_client_key", { p_client_id: id })) as string;
}

export async function revokeClient(id: string): Promise<void> {
  orThrow(await db().rpc("revoke_client", { p_client_id: id }));
}
