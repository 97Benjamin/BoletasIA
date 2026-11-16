alter table public.cuentas
  add column if not exists tasa_crecimiento numeric;
alter table public.cuentas
  add constraint cuentas_tasa_check check (tasa_crecimiento is null or tasa_crecimiento >= 0);
