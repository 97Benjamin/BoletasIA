create table if not exists public.transaccion_item_etiquetas (
  transaccion_item_id integer not null
    references public.transaccion_items(id) on delete cascade,
  etiqueta_id integer not null
    references public.etiquetas(id) on delete cascade,
  primary key (transaccion_item_id, etiqueta_id)
);

alter table public.transaccion_item_etiquetas enable row level security;

grant select, insert, delete
  on public.transaccion_item_etiquetas
  to authenticated;

drop policy if exists "Users can read their item labels"
  on public.transaccion_item_etiquetas;
create policy "Users can read their item labels"
  on public.transaccion_item_etiquetas
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.transaccion_items as item
      join public.transacciones as txn
        on txn.id = item.transaccion_id
      where item.id = transaccion_item_id
        and txn.user_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.etiquetas as tag
      where tag.id = etiqueta_id
        and tag.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users can attach their labels to their items"
  on public.transaccion_item_etiquetas;
create policy "Users can attach their labels to their items"
  on public.transaccion_item_etiquetas
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.transaccion_items as item
      join public.transacciones as txn
        on txn.id = item.transaccion_id
      where item.id = transaccion_item_id
        and txn.user_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.etiquetas as tag
      where tag.id = etiqueta_id
        and tag.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users can remove their labels from their items"
  on public.transaccion_item_etiquetas;
create policy "Users can remove their labels from their items"
  on public.transaccion_item_etiquetas
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.transaccion_items as item
      join public.transacciones as txn
        on txn.id = item.transaccion_id
      where item.id = transaccion_item_id
        and txn.user_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.etiquetas as tag
      where tag.id = etiqueta_id
        and tag.user_id = (select auth.uid())
    )
  );
