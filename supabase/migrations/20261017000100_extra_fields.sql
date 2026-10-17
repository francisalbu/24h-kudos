-- ============================================================
-- Campos extra: contexto dos leads, dados completos do pagamento, log de eventos Stripe
-- ============================================================

-- ---------- LEADS: contexto de onde veio ----------
alter table public.leads
  add column if not exists source       text,           -- utm_source / referrer
  add column if not exists utm_campaign text,
  add column if not exists utm_medium   text,
  add column if not exists referrer     text,
  add column if not exists user_agent   text,
  add column if not exists locale       text,
  add column if not exists reference    text;           -- client_reference_id enviado à Stripe (liga lead -> reserva)

create index if not exists leads_reference_idx on public.leads (reference);

-- ---------- RESERVATIONS: tudo o que a Stripe devolve ----------
alter table public.reservations
  add column if not exists phone          text,
  add column if not exists amount_refunded_cents integer not null default 0,
  add column if not exists payment_status text,         -- paid / unpaid / no_payment_required
  add column if not exists payment_method text,         -- card, mbway, ...
  add column if not exists receipt_url    text,
  add column if not exists billing_country text,
  add column if not exists metadata       jsonb,        -- metadata do payment link
  add column if not exists raw            jsonb,        -- sessão completa (auditoria)
  add column if not exists updated_at     timestamptz not null default now();

alter table public.reservations drop constraint if exists reservations_status_check;
alter table public.reservations add constraint reservations_status_check
  check (status in ('paid','refunded','partially_refunded','disputed'));

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists reservations_touch on public.reservations;
create trigger reservations_touch before update on public.reservations
  for each row execute function public.touch_updated_at();

-- ---------- STRIPE EVENTS: log bruto de todos os webhooks (idempotência + auditoria) ----------
create table if not exists public.stripe_events (
  id          text primary key,          -- evt_...
  type        text not null,
  created_at  timestamptz not null default now(),
  payload     jsonb not null,
  processed   boolean not null default false,
  error       text
);

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;

-- ---------- Vista "quem pagou" (só para ti no dashboard) ----------
create or replace view public.founders as
select type, name, email, phone, amount_cents / 100.0 as amount_eur, status, created_at
from public.reservations
order by created_at;
revoke all on public.founders from anon, authenticated;
