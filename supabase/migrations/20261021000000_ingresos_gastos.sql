-- Tab "Ingresos y gastos": definiciones recurrentes (sueldo, arriendo, etc.).
-- La transacción se crea solo cuando el usuario confirma el periodo vencido.

create table if not exists public.recurrentes (
  id integer generated always as identity primary key,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  tipo text not null
    check (tipo in ('gasto', 'ingreso')),
  nombre text not null,
  monto numeric not null check (monto > 0),
  frecuencia text not null default 'mensual'
    check (frecuencia in ('mensual', 'semanal', 'anual')),
  dia_del_mes integer
    check (dia_del_mes is null or (dia_del_mes between 1 and 31)),
  cuenta_id integer
    references public.cuentas(id) on delete set null,
  categoria_id integer
    references public.categorias(id) on delete set null,
  subcategoria_id integer
    references public.subcategorias(id) on delete set null,
  etiqueta_ids integer[] not null default '{}',
  activo boolean not null default true,
  -- 'YYYY-MM-01': periodo (mes) ya resuelto por el usuario
  ultimo_periodo date,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table public.recurrentes enable row level security;

grant select, insert, update, delete
  on public.recurrentes
  to authenticated;

drop policy if exists "Users can read own recurrentes"
  on public.recurrentes;
create policy "Users can read own recurrentes"
  on public.recurrentes
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users can create own recurrentes"
  on public.recurrentes;
create policy "Users can create own recurrentes"
  on public.recurrentes
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own recurrentes"
  on public.recurrentes;
create policy "Users can update own recurrentes"
  on public.recurrentes
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own recurrentes"
  on public.recurrentes;
create policy "Users can delete own recurrentes"
  on public.recurrentes
  for delete
  to authenticated
  using (user_id = (select auth.uid()));
