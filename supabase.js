// ════════════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT WRAPPER — Shared-Login Version
// One shared account; all data belongs to the authenticated user.
// ════════════════════════════════════════════════════════════════════════════
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = !!(SUPABASE_URL && SUPABASE_KEY);

export const supabase = supabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// ─── AUTH ──────────────────────────────────────────────────────────────────
export async function signUp(email, password) {
  if (!supabase) throw new Error("Supabase not configured");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  if (!supabase) throw new Error("Supabase not configured");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function resetPassword(email) {
  if (!supabase) throw new Error("Supabase not configured");
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}

export async function getCurrentUser() {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export function onAuthChange(callback) {
  if (!supabase) return () => {};
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => subscription.unsubscribe();
}

// ─── DATA CRUD ─────────────────────────────────────────────────────────────
// All tables share the same shape: { id, owner_id, data, created_at, updated_at }.
// We store the whole item inside `data` so the schema can evolve without
// database migrations.

export async function loadAll(table) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(table).select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(row => ({
    ...row.data,
    id: row.id,
    _meta: { created_at: row.created_at, updated_at: row.updated_at },
  }));
}

export async function upsert(table, item) {
  if (!supabase) throw new Error("Supabase not configured");
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in");
  // Strip wrapper metadata before saving
  const { _meta, ...itemData } = item;
  const row = {
    id: item.id,
    owner_id: user.id,
    data: itemData,
  };
  const { data, error } = await supabase
    .from(table).upsert(row, { onConflict: "id" })
    .select().single();
  if (error) throw error;
  return { ...data.data, id: data.id, _meta: { created_at: data.created_at, updated_at: data.updated_at } };
}

export async function remove(table, id) {
  if (!supabase) throw new Error("Supabase not configured");
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw error;
}

// ─── SETTINGS (single row per user) ────────────────────────────────────────
export async function loadSettings() {
  if (!supabase) return {};
  const user = await getCurrentUser();
  if (!user) return {};
  const { data, error } = await supabase
    .from("user_settings").select("data").eq("owner_id", user.id).maybeSingle();
  if (error) throw error;
  return data?.data || {};
}

export async function saveSettings(settings) {
  if (!supabase) throw new Error("Supabase not configured");
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in");
  const { error } = await supabase
    .from("user_settings")
    .upsert({ owner_id: user.id, data: settings }, { onConflict: "owner_id" });
  if (error) throw error;
}

// ─── REALTIME ──────────────────────────────────────────────────────────────
// Subscribes to changes on a table; the callback gets the entire payload.
export function subscribeToTable(table, onChange) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`${table}_changes`)
    .on("postgres_changes", { event: "*", schema: "public", table }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
