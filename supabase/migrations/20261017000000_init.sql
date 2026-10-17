-- ============================================================
-- KUDOS · Backyard 24h — schema inicial
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- LEADS (interesse / cliques) ----------
create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  type        text not null check (type in ('individual','team')),
  intent      text not null check (intent in ('notify','pay_click')),
  email       text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  team_name   text check (team_name is null or char_length(team_name) <= 80),
  -- e-mail é obrigatório quando a intenção é "notify"
  constraint leads_notify_requires_email check (intent <> 'notify' or email is not null)
);

create index if not exists leads_email_idx on public.leads (lower(email));
create index if not exists leads_created_idx on public.leads (created_at desc);

-- ---------- RESERVATIONS (pagamentos confirmados pela Stripe) ----------
create table if not exists public.reservations (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  type                    text not null check (type in ('individual','team')),
  email                   text not null,
  name                    text,
  amount_cents            integer not null,
  currency                text not null default 'eur',
  stripe_session_id       text not null unique,
  stripe_payment_intent   text unique,
  stripe_customer_id      text,
  client_reference_id     text,
  status                  text not null default 'paid' check (status in ('paid','refunded')),
  refunded_at             timestamptz
);

create index if not exists reservations_type_idx on public.reservations (type) where status = 'paid';

-- ---------- RLS ----------
alter table public.leads        enable row level security;
alter table public.reservations enable row level security;

-- Anon: só pode INSERIR leads. Nunca ler, alterar ou apagar.
drop policy if exists "anon can insert leads" on public.leads;
create policy "anon can insert leads"
  on public.leads for insert
  to anon
  with check (true);

-- Ninguém (anon/authenticated) toca em reservations — só o service_role (webhook) escreve.
-- (sem políticas = acesso negado por defeito)

-- Revogar privilégios extra ao anon por segurança
revoke all on public.leads from anon;
grant insert on public.leads to anon;
revoke all on public.reservations from anon, authenticated;

-- ---------- Rate limiting simples (máx. 5 leads / e-mail / hora) ----------
create or replace function public.leads_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and (
    select count(*) from public.leads
    where lower(email) = lower(new.email) and created_at > now() - interval '1 hour'
  ) >= 5 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists leads_rate_limit_trg on public.leads;
create trigger leads_rate_limit_trg before insert on public.leads
  for each row execute function public.leads_rate_limit();

-- ---------- Vista de lugares disponíveis (para mostrar "7 de 10") ----------
create or replace view public.availability as
select
  'individual'::text as type, 10 - count(*) filter (where type = 'individual' and status = 'paid') as remaining, 10 as total
from public.reservations
union all
select
  'team', 5 - count(*) filter (where type = 'team' and status = 'paid'), 5
from public.reservations;

grant select on public.availability to anon;
