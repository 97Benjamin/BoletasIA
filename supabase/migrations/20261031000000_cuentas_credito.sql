-- Cuentas de tarjeta de crédito (Fase 1).
--
-- Convención: para tipo = 'credito', cuentas.saldo_actual guarda el CUPO
-- DISPONIBLE (no el saldo de una cuenta de dinero). La deuda se deriva:
--   deuda = cupo - saldo_actual
-- El trigger sincronizar_saldo_cuenta no cambia: un gasto con la tarjeta
-- reduce el cupo disponible y un pago (ingreso) lo recupera.
--
-- Las tarjetas de crédito quedan fuera del total "estado de resultado":
-- ni el cupo suma ni la deuda resta. El pago se hace con una transferencia
-- desde una cuenta de efectivo/débito, que sí descuenta el total.

alter table public.cuentas
  add column if not exists cupo numeric,
  add column if not exists dia_corte smallint,
  add column if not exists dia_pago smallint;

alter table public.cuentas
  drop constraint if exists cuentas_cupo_check,
  drop constraint if exists cuentas_dia_corte_check,
  drop constraint if exists cuentas_dia_pago_check;

alter table public.cuentas
  add constraint cuentas_cupo_check check (cupo is null or cupo >= 0),
  add constraint cuentas_dia_corte_check check (dia_corte between 1 and 28),
  add constraint cuentas_dia_pago_check check (dia_pago between 1 and 28);
