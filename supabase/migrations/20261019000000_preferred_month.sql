-- Mês preferido indicado por quem deixa interesse
alter table public.leads
  add column if not exists preferred_month text
  check (preferred_month is null or preferred_month in ('marco', 'abril', 'maio'));
