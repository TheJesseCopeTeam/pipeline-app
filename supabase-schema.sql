-- ════════════════════════════════════════════════════════════════════════════
-- THE JESSE COPE TEAM — Pipeline App Schema (Shared-Login Version)
-- Run this whole file in Supabase SQL Editor once during setup.
-- ────────────────────────────────────────────────────────────────────────────
-- This is the SHARED-LOGIN version: one account that you and your co-broker
-- both use. All data belongs to the single authenticated user.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Extensions ────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ────────────────────────────────────────────────────────────────────────────
-- TABLES
-- All tables follow the same pattern: id, owner_id (the user), data jsonb,
-- created_at, updated_at. data is a JSONB blob so the schema can evolve
-- without database migrations.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists transactions (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references auth.users on delete cascade,
  data jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists transactions_owner_idx on transactions(owner_id);

create table if not exists future_listings (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references auth.users on delete cascade,
  data jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists future_listings_owner_idx on future_listings(owner_id);

create table if not exists future_buyers (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references auth.users on delete cascade,
  data jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists future_buyers_owner_idx on future_buyers(owner_id);

create table if not exists vendors (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references auth.users on delete cascade,
  data jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists vendors_owner_idx on vendors(owner_id);

-- Settings — single row per user for app preferences (templates, widget layout, etc.)
create table if not exists user_settings (
  owner_id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- Critical: only the owner can read/write their data.
-- ────────────────────────────────────────────────────────────────────────────

alter table transactions    enable row level security;
alter table future_listings enable row level security;
alter table future_buyers   enable row level security;
alter table vendors         enable row level security;
alter table user_settings   enable row level security;

-- Transactions
create policy "transactions_owner_all" on transactions for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Future listings
create policy "future_listings_owner_all" on future_listings for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Future buyers
create policy "future_buyers_owner_all" on future_buyers for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Vendors
create policy "vendors_owner_all" on vendors for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Settings
create policy "user_settings_owner_all" on user_settings for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────────
-- TRIGGER: auto-update updated_at on row changes
-- ────────────────────────────────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists transactions_updated_at on transactions;
create trigger transactions_updated_at before update on transactions
  for each row execute function set_updated_at();

drop trigger if exists future_listings_updated_at on future_listings;
create trigger future_listings_updated_at before update on future_listings
  for each row execute function set_updated_at();

drop trigger if exists future_buyers_updated_at on future_buyers;
create trigger future_buyers_updated_at before update on future_buyers
  for each row execute function set_updated_at();

drop trigger if exists vendors_updated_at on vendors;
create trigger vendors_updated_at before update on vendors
  for each row execute function set_updated_at();

drop trigger if exists user_settings_updated_at on user_settings;
create trigger user_settings_updated_at before update on user_settings
  for each row execute function set_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- SETUP COMPLETE
-- After running this, create your account at the app login page.
-- The app will recognize you and start syncing your data automatically.
-- ════════════════════════════════════════════════════════════════════════════
