import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import SelectorFecha from '@/components/SelectorFecha';
import type { User } from '@supabase/supabase-js';
import { Redirect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { useThemeMode } from '@/components/ThemeMode';
import { supabase } from '@/src/services/supabase';
import { notificarCambio, usePulsoDatos } from '@/src/utils/cambios';
import { confirmar } from '@/src/utils/confirmar';
import { formatChileanPesos } from '@/src/utils/currency';
import { formatearMontoEnEntrada, limpiarMontoParaEstado } from '@/src/utils/moneda-formato';
import { iconoNormalizado, textoEtiqueta } from '@/src/utils/etiqueta';

type CuentaOpt = { id: number; nombre: string; tipo: string | null; banco: string | null };
type CategoriaOpt = { id: number; nombre: string };
type SubcatOpt = { id: number; nombre: string; categoryId: number };
type EtiquetaOpt = { id: number; nombre: string; icono?: string | null };

type Recurrente = {
  id: number;
  tipo: 'gasto' | 'ingreso';
  nombre: string;
  monto: number;
  diaDelMes: number | null;
  cuentaId: number | null;
  categoriaId: number | null;
  subcategoriaId: number | null;
  etiquetaIds: number[];
  activo: boolean;
  ultimoPeriodo: string | null;
};

type PendienteInfo = {
  rec: Recurrente;
  periodo: string;
  fechaBase: string;
  diaVencimiento: number;
};

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function formatFecha(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseFecha(value: string) {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function inputAmount(value: string) {
  const normalized = value.trim().replace(/\s/g, '');
  if (!normalized) return null;
  let decimalValue = normalized;
  if (normalized.includes(',')) {
    // coma = decimales; los puntos eran separadores de miles
    decimalValue = normalized.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) {
    // puntos como separador de miles (ej: 12.990 -> 12990)
    decimalValue = normalized.replace(/\./g, '');
  }
  const amount = Number(decimalValue);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function titleCase(value: string) {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) =>
      word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : ''
    )
    .join(' ');
}

function inputAmountText(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }
  return null;
}

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// Calcula el periodo (mes) pendiente de confirmar para un recurrente.
function pendienteDe(
  rec: Recurrente,
  hoy: Date
): PendienteInfo | null {
  if (!rec.activo) return null;
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  const ultimoDia = new Date(y, m + 1, 0).getDate();
  const diaVencimiento = rec.diaDelMes ?? 1;
  const dia = Math.min(diaVencimiento, ultimoDia);
  if (hoy.getDate() < dia) return null;
  const periodo = `${y}-${pad2(m + 1)}-01`;
  if (rec.ultimoPeriodo && rec.ultimoPeriodo >= periodo) return null;
  return { rec, periodo, fechaBase: `${y}-${pad2(m + 1)}-${pad2(dia)}`, diaVencimiento };
}

export default function IngresosGastosScreen() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [cuentaOptions, setCuentaOptions] = useState<CuentaOpt[]>([]);
  const [categoriaOptions, setCategoriaOptions] = useState<CategoriaOpt[]>([]);
  const [subcategoriaOptions, setSubcategoriaOptions] = useState<SubcatOpt[]>([]);
  const [etiquetaOptions, setEtiquetaOptions] = useState<EtiquetaOpt[]>([]);

  const [recurrentes, setRecurrentes] = useState<Recurrente[]>([]);
  const [recurrentesLoading, setRecurrentesLoading] = useState(false);
  const [recurrentesReload, setRecurrentesReload] = useState(0);
  const [listaError, setListaError] = useState('');
  // Pulso global: re-carga catálogos cuando Mi cuenta edita categorías o
  // etiquetas y cuando esta pantalla vuelve a tomar foco.
  const pulsoDatos = usePulsoDatos();

  // Formulario rápido (gasto sin boleta / ingreso adicional / transferencia)
  const [qTipo, setQTipo] = useState<'gasto' | 'ingreso' | 'transferencia'>('gasto');
  const [qNombre, setQNombre] = useState('');
  const [qMonto, setQMonto] = useState('');
  const [qFecha, setQFecha] = useState(formatFecha(new Date()));
  const [qCuentaId, setCuentaId] = useState<number | null>(null);
  const [qCuentaDestinoId, setCuentaDestinoId] = useState<number | null>(null);
  const [qCategoriaId, setQCategoriaId] = useState<number | null>(null);
  const [qSubcatId, setQSubcatId] = useState<number | null>(null);
  const [qTagIds, setQTagIds] = useState<number[]>([]);
  const [qSaving, setQSaving] = useState(false);

  // Confirmación de pendiente recurrente
  const [pendiente, setPendiente] = useState<PendienteInfo | null>(null);
  const [pMonto, setPMonto] = useState('');
  const [pFecha, setPFecha] = useState('');
  const [pSaving, setPSaving] = useState(false);

  // Modal crear/editar recurrente
  const [recOpen, setRecOpen] = useState(false);
  const [recEditando, setRecEditando] = useState<Recurrente | null>(null);
  const [rTipo, setRTipo] = useState<'gasto' | 'ingreso'>('gasto');
  const [rNombre, setRNombre] = useState('');
  const [rMonto, setRMonto] = useState('');
  const [rDia, setRDia] = useState('');
  const [rCuentaId, setRCuentaId] = useState<number | null>(null);
  const [rCategoriaId, setRCategoriaId] = useState<number | null>(null);
  const [rSubcatId, setRSubcatId] = useState<number | null>(null);
  const [rTagIds, setRTagIds] = useState<number[]>([]);
  const [rSaving, setRSaving] = useState(false);

  const authEventReceived = useRef(false);
  const { colorScheme } = useThemeMode();

  useEffect(() => {
    let isMounted = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventReceived.current = true;
      if (isMounted) {
        setUser(session?.user ?? null);
        setLoading(false);
      }
    });

    supabase.auth
      .getUser()
      .then(({ data: { user: currentUser } }) => {
        if (!isMounted || authEventReceived.current) return;
        setUser(currentUser);
        setLoading(false);
      })
      .catch(() => {
        if (!isMounted || authEventReceived.current) return;
        setLoading(false);
      });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setCuentaOptions([]);
      setCategoriaOptions([]);
      setSubcategoriaOptions([]);
      setEtiquetaOptions([]);
      return;
    }
    let isMounted = true;

    async function loadCatalog() {
      const [cuentaResult, categoriaResult, subcategoriaResult, tagResult] =
        await Promise.all([
          supabase
            .from('cuentas')
            .select('id, nombre, tipo, banco')
            .eq('user_id', userId)
            .order('nombre'),
          supabase
            .from('categorias')
            .select('id, nombre, user_id')
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order('nombre'),
          supabase
            .from('subcategorias')
            .select('id, nombre, categoria_id')
            .order('nombre'),
          supabase
            .from('etiquetas')
            .select('id, nombre, icono, user_id')
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order('nombre'),
        ]);
      if (!isMounted) return;
      const mapSimple = (rows: unknown[], source: unknown) =>
        (rows ?? [])
          .map((row) => {
            const record = row as { id: unknown; nombre: unknown };
            const id = record.id;
            const nombre = record.nombre;
            if (typeof id !== 'number' || typeof nombre !== 'string') return null;
            return { id, nombre: nombre.trim() };
          })
          .filter((item): item is { id: number; nombre: string } => item !== null);
      const cuentaList = (cuentaResult.data ?? []).flatMap(
        (row): CuentaOpt[] => {
          const record = row as {
            id: unknown;
            nombre: unknown;
            tipo: unknown;
            banco: unknown;
          };
          if (
            typeof record.id !== 'number' ||
            typeof record.nombre !== 'string'
          ) {
            return [];
          }
          return [
            {
              id: record.id,
              nombre: record.nombre.trim(),
              tipo: typeof record.tipo === 'string' ? record.tipo : null,
              banco: typeof record.banco === 'string' ? record.banco.trim() || null : null,
            },
          ];
        }
      );
      setCuentaOptions(cuentaList);
      // Toda transacción requiere cuenta: deja la primera por defecto.
      setCuentaId((previa) => previa ?? cuentaList[0]?.id ?? null);
      setCategoriaOptions(
        mapSimple(categoriaResult.data ?? [], categoriaResult)
      );
      const subcatRows = (subcategoriaResult.data ?? []) as {
        id: unknown;
        nombre: unknown;
        categoria_id: unknown;
      }[];
      setSubcategoriaOptions(
        subcatRows.flatMap((row) => {
          const id = row.id;
          const nombre = row.nombre;
          const categoriaId = row.categoria_id;
          if (
            typeof id !== 'number' ||
            typeof nombre !== 'string' ||
            typeof categoriaId !== 'number'
          ) {
            return [];
          }
          return [
            {
              id,
              nombre: nombre.trim(),
              categoryId: categoriaId,
            },
          ];
        })
      );
      const etiquetasCargadas = (tagResult.data ?? []).flatMap(
        (row): EtiquetaOpt[] => {
          const record = row as {
            id: unknown;
            nombre: unknown;
            icono: unknown;
          };
          if (
            typeof record?.id !== 'number' ||
            typeof record?.nombre !== 'string'
          ) {
            return [];
          }
          return [
            {
              id: record.id,
              nombre: record.nombre.trim(),
              icono: iconoNormalizado(record.icono),
            },
          ];
        }
      );
      setEtiquetaOptions(etiquetasCargadas);
    }

    void loadCatalog();
    return () => {
      isMounted = false;
    };
  }, [user?.id, pulsoDatos]);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setRecurrentes([]);
      setRecurrentesLoading(false);
      return;
    }
    let isMounted = true;
    setRecurrentesLoading(true);
    setListaError('');

    async function loadRecurrentes() {
      try {
        const { data, error: loadError } = await supabase
          .from('recurrentes')
          .select(
            'id, tipo, nombre, monto, dia_del_mes, cuenta_id, categoria_id, subcategoria_id, etiqueta_ids, activo, ultimo_periodo'
          )
          .eq('user_id', userId)
          .order('nombre');

        if (loadError) throw loadError;
        if (!isMounted) return;

        const rows = (data ?? []) as Record<string, unknown>[];
        setRecurrentes(
          rows.flatMap((row): Recurrente[] => {
            const id = row.id;
            const tipo = row.tipo;
            const nombre = row.nombre;
            if (
              typeof id !== 'number' ||
              (tipo !== 'gasto' && tipo !== 'ingreso') ||
              typeof nombre !== 'string' ||
              !nombre.trim() ||
              inputAmountText(row.monto) === null
            ) {
              return [];
            }
            return [
              {
                id,
                tipo,
                nombre: nombre.trim(),
                monto: Number(inputAmountText(row.monto)),
                diaDelMes: readNumber(row.dia_del_mes),
                cuentaId: readNumber(row.cuenta_id),
                categoriaId: readNumber(row.categoria_id),
                subcategoriaId: readNumber(row.subcategoria_id),
                etiquetaIds: Array.isArray(row.etiqueta_ids)
                  ? row.etiqueta_ids.filter(
                      (value): value is number => typeof value === 'number'
                    )
                  : [],
                activo: row.activo !== false,
                ultimoPeriodo: readText(row.ultimo_periodo),
              },
            ];
          })
        );
      } catch (loadError: unknown) {
        if (isMounted) {
          setListaError(
            `No se pudieron cargar los recurrentes: ${
              loadError instanceof Error ? loadError.message : 'Error desconocido'
            }`
          );
        }
      } finally {
        if (isMounted) setRecurrentesLoading(false);
      }
    }

    void loadRecurrentes();
    return () => {
      isMounted = false;
    };
  }, [user?.id, recurrentesReload, pulsoDatos]);

  const hoy = new Date();
  const pendientes = recurrentes
    .map((rec) => pendienteDe(rec, hoy))
    .filter((item): item is PendienteInfo => item !== null);

  function toggleTag(list: number[], id: number) {
    return list.includes(id)
      ? list.filter((value) => value !== id)
      : [...list, id];
  }

  function abrirConfirmacion(info: PendienteInfo) {
    setPendiente(info);
    setPMonto(String(info.rec.monto));
    setPFecha(info.fechaBase);
    setError('');
    setMessage('');
  }

  async function resolverComercio(nombre: string): Promise<number | null> {
    const limpio = titleCase(nombre);
    if (!limpio) return null;
    const { data: found } = await supabase
      .from('comercios')
      .select('id')
      .ilike('nombre', limpio)
      .limit(1);
    if (found && found.length > 0) {
      const id = (found[0] as { id: unknown }).id;
      return typeof id === 'number' ? id : null;
    }
    const { data: created, error: insertError } = await supabase
      .from('comercios')
      .insert({ nombre: limpio })
      .select('id');
    if (insertError) return null;
    if (created && created.length > 0) {
      const id = (created[0] as { id: unknown }).id;
      return typeof id === 'number' ? id : null;
    }
    return null;
  }

  async function guardarEtiquetas(transaccionId: number, tagIds: number[]) {
    if (tagIds.length === 0) return;
    await supabase
      .from('transaccion_etiquetas')
      .insert(
        tagIds.map((etiquetaId) => ({
          transaccion_id: transaccionId,
          etiqueta_id: etiquetaId,
        }))
      );
  }

  async function confirmarPendiente() {
    if (!user || !pendiente || pSaving) return;
    const monto = inputAmount(limpiarMontoParaEstado(pMonto));
    if (monto === null) {
      setError('Escribe un monto válido para el registro.');
      return;
    }
    if (pendiente.rec.cuentaId === null) {
      setError(
        'Este recurrente no tiene cuenta: edítalo en la lista y elige una.'
      );
      return;
    }
    setPSaving(true);
    setError('');
    try {
      const comercioId = await resolverComercio(pendiente.rec.nombre);
      const { data, error: insertError } = await supabase
        .from('transacciones')
        .insert({
          user_id: user.id,
          cuenta_id: pendiente.rec.cuentaId,
          comercio_id: comercioId,
          categoria_id: pendiente.rec.categoriaId,
          subcategoria_id: pendiente.rec.subcategoriaId,
          tipo: pendiente.rec.tipo,
          fecha: pFecha,
          total: String(monto),
          es_recurrente: true,
          frecuencia: 'mensual',
        })
        .select('id');
      if (insertError) throw insertError;
      const transaccionId = (data as { id: number }[] | null)?.[0]?.id;
      if (typeof transaccionId !== 'number') {
        throw new Error('La base de datos no devolvió la transacción creada.');
      }
      await guardarEtiquetas(transaccionId, pendiente.rec.etiquetaIds);
      const { error: updateError } = await supabase
        .from('recurrentes')
        .update({
          ultimo_periodo: pendiente.periodo,
          actualizado_en: new Date().toISOString(),
        })
        .eq('id', pendiente.rec.id);
      if (updateError) throw updateError;
      setMessage(
        `${pendiente.rec.nombre} registrado por ${formatChileanPesos(monto)}.`
      );
      setPendiente(null);
      setRecurrentesReload((value) => value + 1);
      // Transacción nueva: Movimientos y Presupuestos deben recalcular.
      notificarCambio();
    } catch (saveError: unknown) {
      setError(
        `No se pudo registrar: ${
          saveError instanceof Error ? saveError.message : 'Error desconocido'
        }`
      );
    } finally {
      setPSaving(false);
    }
  }

  async function saltarPendiente(info: PendienteInfo) {
    if (!user || pSaving) return;
    setPSaving(true);
    setError('');
    try {
      const { error: updateError } = await supabase
        .from('recurrentes')
        .update({
          ultimo_periodo: info.periodo,
          actualizado_en: new Date().toISOString(),
        })
        .eq('id', info.rec.id);
      if (updateError) throw updateError;
      setMessage(
        `${info.rec.nombre} de este mes marcado como pendiente resuelto.`
      );
      setRecurrentesReload((value) => value + 1);
    } catch (skipError: unknown) {
      setError(
        `No se pudo actualizar el recurrente: ${
          skipError instanceof Error ? skipError.message : 'Error desconocido'
        }`
      );
    } finally {
      setPSaving(false);
    }
  }

  function abrirRecurrente(rec: Recurrente | null) {
    if (rec) {
      setRecEditando(rec);
      setRTipo(rec.tipo);
      setRNombre(rec.nombre);
      setRMonto(String(rec.monto));
      setRDia(rec.diaDelMes ? String(rec.diaDelMes) : '');
      setRCuentaId(rec.cuentaId);
      setRCategoriaId(rec.categoriaId);
      setRSubcatId(rec.subcategoriaId);
      setRTagIds(rec.etiquetaIds);
    } else {
      setRecEditando(null);
      setRTipo('gasto');
      setRNombre('');
      setRMonto('');
      setRDia('');
      setRCuentaId(cuentaOptions[0]?.id ?? null);
      setRCategoriaId(null);
      setRSubcatId(null);
      setRTagIds([]);
    }
    setError('');
    setMessage('');
    setRecOpen(true);
  }

  async function guardarRecurrente() {
    if (!user || rSaving) return;
    const nombre = rNombre.trim();
    const monto = inputAmount(limpiarMontoParaEstado(rMonto));
    if (!nombre) {
      setError('Escribe un nombre para el recurrente (ej: Sueldo, Arriendo).');
      return;
    }
    if (monto === null) {
      setError('Escribe un monto base válido.');
      return;
    }
    let dia: number | null = null;
    if (rDia.trim()) {
      const parsed = Number(rDia.trim());
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 31 || !Number.isInteger(parsed)) {
        setError('El día del mes debe ser un número entre 1 y 31.');
        return;
      }
      dia = Math.floor(parsed);
    }
    if (rSubcatId !== null && rCategoriaId === null) {
      setError('Para subcategoría primero elige una categoría.');
      return;
    }
    if (rCuentaId === null) {
      setError(
        'Los recurrentes necesitan una cuenta (crea una en "Mi cuenta" si aún no tienes).'
      );
      return;
    }
    setRSaving(true);
    setError('');
    try {
      const payload = {
        user_id: user.id,
        tipo: rTipo,
        nombre,
        monto: String(monto),
        frecuencia: 'mensual',
        dia_del_mes: dia,
        cuenta_id: rCuentaId,
        categoria_id: rCategoriaId,
        subcategoria_id: rCategoriaId === null ? null : rSubcatId,
        etiqueta_ids: rTagIds,
        actualizado_en: new Date().toISOString(),
      };
      if (recEditando) {
        const { error: updateError } = await supabase
          .from('recurrentes')
          .update(payload)
          .eq('id', recEditando.id);
        if (updateError) throw updateError;
        setMessage(`Recurrente "${nombre}" actualizado.`);
      } else {
        const { error: insertError } = await supabase
          .from('recurrentes')
          .insert(payload);
        if (insertError) throw insertError;
        setMessage(`Recurrente "${nombre}" creado.`);
      }
      setRecOpen(false);
      setRecurrentesReload((value) => value + 1);
    } catch (saveError: unknown) {
      setError(
        `No se pudo guardar el recurrente: ${
          saveError instanceof Error ? saveError.message : 'Error desconocido'
        }`
      );
    } finally {
      setRSaving(false);
    }
  }

  function eliminarRecurrente(rec: Recurrente) {
    confirmar(
      'Eliminar recurrente',
      `¿Eliminar "${rec.nombre}"? Esta acción no se puede deshacer.`,
      () => {
        void (async () => {
          const { error: deleteError } = await supabase
            .from('recurrentes')
            .delete()
            .eq('id', rec.id);
          if (deleteError) {
            setError(
              `No se pudo eliminar: ${deleteError.message}`
            );
            return;
          }
          setRecurrentesReload((value) => value + 1);
        })();
      }
    );
  }

  async function alternarActivo(rec: Recurrente) {
    const { error: updateError } = await supabase
      .from('recurrentes')
      .update({
        activo: !rec.activo,
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', rec.id);
    if (updateError) {
      setError(`No se pudo actualizar: ${updateError.message}`);
      return;
    }
    setRecurrentesReload((value) => value + 1);
  }

  async function enviarRapido() {
    if (!user || qSaving) return;
    const nombre = qNombre.trim();
    const monto = inputAmount(limpiarMontoParaEstado(qMonto));
    const esTransferencia = qTipo === 'transferencia';
    if (monto === null) {
      setError('Escribe un monto válido mayor que cero.');
      return;
    }
    if (!esTransferencia && !nombre) {
      setError('Escribe un nombre (ej: "Farmacia", "Sueldo freelance").');
      return;
    }
    if (!esTransferencia && qSubcatId !== null && qCategoriaId === null) {
      setError('Para subcategoría primero elige una categoría.');
      return;
    }
    if (!esTransferencia && qCuentaId === null) {
      setError(
        'Elige la cuenta asociada (crea una en "Mi cuenta" si aún no tienes).'
      );
      return;
    }
    if (esTransferencia) {
      if (qCuentaId === null || qCuentaDestinoId === null) {
        setError('Elige la cuenta de origen y la cuenta de destino.');
        return;
      }
      if (qCuentaId === qCuentaDestinoId) {
        setError('La cuenta de origen y la de destino deben ser distintas.');
        return;
      }
    }
    setQSaving(true);
    setError('');
    setMessage('');
    try {
      if (esTransferencia) {
        const origen = cuentaOptions.find((cuenta) => cuenta.id === qCuentaId);
        const destino = cuentaOptions.find(
          (cuenta) => cuenta.id === qCuentaDestinoId
        );
        const origenNombre = origen?.nombre ?? 'otra cuenta';
        const destinoNombre = destino?.nombre ?? 'otra cuenta';
        // Si el destino es una tarjeta de crédito, el movimiento es el pago de
        // la tarjeta (baja la deuda/recupera cupo y descuenta la cuenta origen).
        // Si el origen es la tarjeta, es un avance (sube la deuda).
        const esPagoTarjeta = destino?.tipo === 'credito';
        const esAvanceTarjeta = !esPagoTarjeta && origen?.tipo === 'credito';
        const etiquetaTransferencia = esPagoTarjeta
          ? `Pago tarjeta · ${destinoNombre}`
          : esAvanceTarjeta
            ? `Avance tarjeta · ${origenNombre}`
            : `Transferencia ${origenNombre} → ${destinoNombre}`;
        // Par simétrico gasto(sale)+ingreso(llega): el trigger trg_transacciones_saldo
        // mueve ambos saldos y el Resumen netea a cero (no es gasto ni ganancia real).
        const comercioId = await resolverComercio(etiquetaTransferencia);
        const { error: salidaError } = await supabase
          .from('transacciones')
          .insert({
            user_id: user.id,
            cuenta_id: qCuentaId,
            comercio_id: comercioId,
            categoria_id: null,
            subcategoria_id: null,
            tipo: 'gasto',
            fecha: qFecha,
            total: String(monto),
          })
          .select('id');
        if (salidaError) throw salidaError;
        const { error: llegadaError } = await supabase
          .from('transacciones')
          .insert({
            user_id: user.id,
            cuenta_id: qCuentaDestinoId,
            comercio_id: comercioId,
            categoria_id: null,
            subcategoria_id: null,
            tipo: 'ingreso',
            fecha: qFecha,
            total: String(monto),
          })
          .select('id');
        if (llegadaError) throw llegadaError;
        setMessage(
          esPagoTarjeta
            ? `Pago de ${formatChileanPesos(
                monto
              )} a la tarjeta ${destinoNombre} registrado. Recuperaste ese cupo.`
            : esAvanceTarjeta
              ? `Avance de ${formatChileanPesos(
                  monto
                )} desde la tarjeta ${origenNombre} registrado.`
              : `Transferencia de ${formatChileanPesos(
                  monto
                )} desde ${origenNombre} hacia ${destinoNombre} registrada.`
        );
      } else {
        const comercioId = await resolverComercio(qNombre);
        const { data, error: insertError } = await supabase
          .from('transacciones')
          .insert({
            user_id: user.id,
            cuenta_id: qCuentaId,
            comercio_id: comercioId,
            categoria_id: qCategoriaId,
            subcategoria_id: qCategoriaId === null ? null : qSubcatId,
            tipo: qTipo,
            fecha: qFecha,
            total: String(monto),
          })
          .select('id');
        if (insertError) throw insertError;
        const transaccionId = (data as { id: number }[] | null)?.[0]?.id;
        if (typeof transaccionId !== 'number') {
          throw new Error('La base de datos no devolvió la transacción creada.');
        }
        await guardarEtiquetas(transaccionId, qTagIds);
        setMessage(
          `${qTipo === 'gasto' ? 'Gasto' : 'Ingreso'} registrado por ${formatChileanPesos(monto)}.`
        );
      }
      setQNombre('');
      setQMonto('');
      setQFecha(formatFecha(new Date()));
      // Gasto/ingreso/transferencia nueva: Movimientos y Presupuestos
      // deben recalcularse sin recargar la página.
      notificarCambio();
    } catch (saveError: unknown) {
      setError(
        `No se pudo registrar: ${
          saveError instanceof Error ? saveError.message : 'Error desconocido'
        }`
      );
    } finally {
      setQSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  const inputColors = {
    borderColor: colorScheme === 'dark' ? '#4b5563' : '#d1d5db',
    backgroundColor: colorScheme === 'dark' ? '#111827' : '#ffffff',
    color: colorScheme === 'dark' ? '#f9fafb' : '#111827',
  };
  const inputStyle: TextStyle[] = [styles.input, inputColors];
  const inputBoxStyle: ViewStyle[] = [
    styles.input,
    {
      borderColor: inputColors.borderColor,
      backgroundColor: inputColors.backgroundColor,
    },
  ];
  // Chips inactivos con buen contraste en ambos temas.
  const chipInactivo: ViewStyle[] = [
    styles.chip,
    {
      borderColor: colorScheme === 'dark' ? '#94a3b8' : '#c7d2fe',
      backgroundColor: colorScheme === 'dark' ? '#1e293b' : '#e0e7ff',
    },
  ];
  const chipTextoInactivo: TextStyle[] = [
    { fontSize: 13, fontWeight: '600' },
    { color: colorScheme === 'dark' ? '#e2e8f0' : '#4338ca' },
  ];
  const periodoLabel = pendiente
    ? `${MESES[Number(pendiente.periodo.slice(5, 7)) - 1]} ${pendiente.periodo.slice(0, 4)}`
    : '';
  const cuentaNombrePendiente =
    pendiente?.rec.cuentaId != null
      ? cuentaOptions.find((cuenta) => cuenta.id === pendiente.rec.cuentaId)?.nombre ??
        'Cuenta elegida'
      : 'Sin cuenta';
  const subcategoriaOptionsFiltradas = subcategoriaOptions.filter(
    (sub) => sub.categoryId === qCategoriaId
  );
  const rSubcatOptionsFiltradas = subcategoriaOptions.filter(
    (sub) => sub.categoryId === rCategoriaId
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Ingresos y gastos</Text>
      <Text style={styles.subtitle} lightColor="#6b7280" darkColor="#9ca3af">
        Registra gastos sin boleta, ingresos y recurrentes como tu sueldo o arriendo.
      </Text>

      {pendientes.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Pendientes de confirmar</Text>
          {pendientes.map((info) => (
            <View
              key={`pend-${info.rec.id}`}
              style={styles.pendienteCard}
              lightColor="#fff7ed"
              darkColor="#431407"
            >
              <Text style={styles.pendienteTitulo}>
                {info.rec.tipo === 'ingreso' ? '⬆️' : '⬇️'} {info.rec.nombre} —{' '}
                {periodoLabel}
              </Text>
              <Text
                style={styles.pendienteDetalle}
                lightColor="#9a3412"
                darkColor="#fdba74"
              >
                Base {formatChileanPesos(info.rec.monto)} ·{' '}
                {info.rec.diaDelMes ? `día ${info.diaVencimiento}` : 'cada mes'} ·{' '}
                {cuentaOptions.find((cuenta) => cuenta.id === info.rec.cuentaId)
                  ?.nombre ?? 'sin cuenta'}
              </Text>
              <View
                style={styles.pendienteBotones}
                lightColor="transparent"
                darkColor="transparent"
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => abrirConfirmacion(info)}
                  style={styles.pendienteRegistrar}
                >
                  <Text style={styles.pendienteRegistrarText}>Registrar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => void saltarPendiente(info)}
                  style={styles.pendienteSaltar}
                >
                  <Text style={styles.pendienteSaltarText}>Saltar este mes</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Registro rápido</Text>
      <View style={styles.card} lightColor="#ffffff" darkColor="#1f2937">
        <View
          style={styles.chipRow}
          lightColor="transparent"
          darkColor="transparent"
        >
          {(['gasto', 'ingreso', 'transferencia'] as const).map((tipoOpcion) => (
            <TouchableOpacity
              key={tipoOpcion}
              accessibilityRole="button"
              onPress={() => {
                setQTipo(tipoOpcion);
                if (tipoOpcion === 'transferencia') {
                  // Preselección cómoda: una cuenta distinta a la de origen
                  setCuentaDestinoId(
                    (previa) =>
                      previa ??
                      cuentaOptions.find((cuenta) => cuenta.id !== qCuentaId)?.id ??
                      null
                  );
                }
              }}
              style={[chipInactivo, qTipo === tipoOpcion && styles.chipActivo]}
            >
              <Text
                style={[
                  chipTextoInactivo,
                  qTipo === tipoOpcion ? styles.chipTextActivo : null,
                ]}
              >
                {tipoOpcion === 'gasto'
                  ? '⬇️ Gasto'
                  : tipoOpcion === 'ingreso'
                    ? '⬆️ Ingreso'
                    : '🔁 Transferencia'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {qTipo !== 'transferencia' ? (
          <TextInput
            style={inputStyle}
            value={qNombre}
            onChangeText={setQNombre}
            placeholder="Descripción (ej: Farmacia, Sueldo freelance)"
            placeholderTextColor={colorScheme === 'dark' ? '#9ca3af' : '#6b7280'}
            autoCapitalize="sentences"
          />
        ) : null}
        <TextInput
          style={inputStyle}
          value={qMonto}
          onChangeText={(texto) => {
            const formateado = formatearMontoEnEntrada(texto);
            setQMonto(formateado);
          }}
          placeholder="Monto (ej: 12.990)"
          placeholderTextColor={colorScheme === 'dark' ? '#9ca3af' : '#6b7280'}
          keyboardType={Platform.OS === 'web' ? 'default' : 'numeric'}
        />

        <SelectorFecha
          valor={qFecha}
          alCambiar={setQFecha}
          contenedorEstilo={inputBoxStyle}
          textoEstilo={[
            styles.fechaText,
            { color: colorScheme === 'dark' ? '#f9fafb' : '#111827' },
          ]}
          accesibilidadLabel="Fecha del registro rápido"
          bloquearFuturo
        />

        {qTipo === 'transferencia' ? (
          <>
            <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
              Cuenta origen (sale el dinero)
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              style={styles.chipScroll}
            >
              {cuentaOptions.map((cuenta) => (
                <TouchableOpacity
                  key={cuenta.id}
                  accessibilityRole="button"
                  onPress={() => setCuentaId(cuenta.id)}
                  style={[chipInactivo, qCuentaId === cuenta.id && styles.chipActivo]}
                >
                  <Text
                    style={[
                      chipTextoInactivo,
                      qCuentaId === cuenta.id ? styles.chipTextActivo : null,
                    ]}
                  >
                    {cuenta.banco ? `${cuenta.nombre} · ${cuenta.banco}` : cuenta.nombre}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
              Cuenta destino (llega el dinero)
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              style={styles.chipScroll}
            >
              {cuentaOptions.map((cuenta) => (
                <TouchableOpacity
                  key={cuenta.id}
                  accessibilityRole="button"
                  onPress={() => setCuentaDestinoId(cuenta.id)}
                  style={[
                    chipInactivo,
                    qCuentaDestinoId === cuenta.id && styles.chipActivo,
                  ]}
                >
                  <Text
                    style={[
                      chipTextoInactivo,
                      qCuentaDestinoId === cuenta.id ? styles.chipTextActivo : null,
                    ]}
                  >
                    {cuenta.nombre}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        ) : (
          <>
            <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
              Cuenta
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              style={styles.chipScroll}
            >
              {cuentaOptions.map((cuenta) => (
                <TouchableOpacity
                  key={cuenta.id}
                  accessibilityRole="button"
                  onPress={() => setCuentaId(cuenta.id)}
                  style={[chipInactivo, qCuentaId === cuenta.id && styles.chipActivo]}
                >
                  <Text
                    style={[
                      chipTextoInactivo,
                      qCuentaId === cuenta.id ? styles.chipTextActivo : null,
                    ]}
                  >
                    {cuenta.banco ? `${cuenta.nombre} · ${cuenta.banco}` : cuenta.nombre}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        )}

        {qTipo !== 'transferencia' ? (
          <>
        <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
          Categoría
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
          style={styles.chipScroll}
        >
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              setQCategoriaId(null);
              setQSubcatId(null);
            }}
            style={[chipInactivo, qCategoriaId === null && styles.chipActivo]}
          >
            <Text
              style={[
                chipTextoInactivo,
                qCategoriaId === null ? styles.chipTextActivo : null,
              ]}
            >
              Sin categoría
            </Text>
          </TouchableOpacity>
          {categoriaOptions.map((categoria) => (
            <TouchableOpacity
              key={categoria.id}
              accessibilityRole="button"
              onPress={() => {
                setQCategoriaId(categoria.id);
                setQSubcatId(null);
              }}
              style={[chipInactivo, qCategoriaId === categoria.id && styles.chipActivo]}
            >
              <Text
                style={[
                  chipTextoInactivo,
                  qCategoriaId === categoria.id ? styles.chipTextActivo : null,
                ]}
              >
                {categoria.nombre}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {qCategoriaId !== null && subcategoriaOptionsFiltradas.length > 0 ? (
          <>
            <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
              Subcategoría
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              style={styles.chipScroll}
            >
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setQSubcatId(null)}
                style={[chipInactivo, qSubcatId === null && styles.chipActivo]}
              >
                <Text
                  style={[
                    chipTextoInactivo,
                    qSubcatId === null ? styles.chipTextActivo : null,
                  ]}
                >
                  Ninguna
                </Text>
              </TouchableOpacity>
              {subcategoriaOptionsFiltradas.map((subcat) => (
                <TouchableOpacity
                  key={subcat.id}
                  accessibilityRole="button"
                  onPress={() => setQSubcatId(subcat.id)}
                  style={[chipInactivo, qSubcatId === subcat.id && styles.chipActivo]}
                >
                  <Text
                    style={[
                      chipTextoInactivo,
                      qSubcatId === subcat.id ? styles.chipTextActivo : null,
                    ]}
                  >
                    {subcat.nombre}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        ) : null}

        {etiquetaOptions.length > 0 ? (
          <>
            <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
              Etiquetas
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              style={styles.chipScroll}
            >
              {etiquetaOptions.map((etiqueta) => (
                <TouchableOpacity
                  key={etiqueta.id}
                  accessibilityRole="button"
                  onPress={() => setQTagIds((previo) => toggleTag(previo, etiqueta.id))}
                  style={[
                    chipInactivo,
                    qTagIds.includes(etiqueta.id) && styles.chipActivo,
                  ]}
                >
                  <Text
                    style={[
                      chipTextoInactivo,
                      qTagIds.includes(etiqueta.id)
                        ? styles.chipTextActivo
                        : null,
                    ]}
                  >
                    {textoEtiqueta(etiqueta)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        ) : null}
          </>
        ) : null}

        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void enviarRapido()}
          disabled={qSaving}
          style={styles.guardarButton}
        >
          <Text style={styles.guardarText}>
            {qSaving ? 'Registrando...' : 'Registrar'}
          </Text>
        </TouchableOpacity>
      </View>

      {message ? (
        <Text style={styles.message} lightColor="#15803d" darkColor="#86efac">
          {message}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
          {error}
        </Text>
      ) : null}

      <View
        style={styles.seccionHeader}
        lightColor="transparent"
        darkColor="transparent"
      >
        <Text style={styles.sectionTitle}>Recurrentes</Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => abrirRecurrente(null)}
        >
          <Text style={styles.agregarText}>＋ Nuevo</Text>
        </TouchableOpacity>
      </View>

      {recurrentesLoading ? (
        <ActivityIndicator style={styles.listaSpinner} color="#4f46e5" />
      ) : listaError ? (
        <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
          {listaError}
        </Text>
      ) : recurrentes.length === 0 ? (
        <Text style={styles.vacio} lightColor="#6b7280" darkColor="#9ca3af">
          No tienes recurrentes. Agrega tu sueldo o el arriendo y la app te
          recordará cada mes.
        </Text>
      ) : (
        recurrentes.map((rec) => {
          const pendienteInfo = pendienteDe(rec, hoy);
          const resueltoMes =
            rec.ultimoPeriodo &&
            rec.ultimoPeriodo >=
              `${hoy.getFullYear()}-${pad2(hoy.getMonth() + 1)}-01`;
          const cuentaNombre = cuentaOptions.find(
            (cuenta) => cuenta.id === rec.cuentaId
          )?.nombre;
          return (
            <View
              key={rec.id}
              style={styles.card}
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              <View
                style={styles.recHeader}
                lightColor="transparent"
                darkColor="transparent"
              >
                <View
                  style={styles.recInfo}
                  lightColor="transparent"
                  darkColor="transparent"
                >
                  <Text style={styles.recNombre}>
                    {rec.tipo === 'ingreso' ? '⬆️' : '⬇️'} {rec.nombre}
                    {!rec.activo ? ' (pausado)' : ''}
                  </Text>
                  <Text
                    style={styles.recDetalle}
                    lightColor="#6b7280"
                    darkColor="#9ca3af"
                  >
                    {formatChileanPesos(rec.monto)}
                    {rec.diaDelMes ? ` · día ${rec.diaDelMes} de cada mes` : ' · cada mes'}
                    {cuentaNombre ? ` · ${cuentaNombre}` : ''}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.recEstado,
                    {
                      color: !rec.activo
                        ? '#9ca3af'
                        : pendienteInfo
                          ? '#d97706'
                          : '#15803d',
                    },
                  ]}
                >
                  {!rec.activo
                    ? '⏸ pausado'
                    : pendienteInfo
                      ? '⏳ pendiente'
                      : resueltoMes
                        ? '✓ registrado'
                        : '—'}
                </Text>
              </View>
              <View
                style={styles.recAcciones}
                lightColor="transparent"
                darkColor="transparent"
              >
                {pendienteInfo ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => abrirConfirmacion(pendienteInfo)}
                    style={styles.miniBoton}
                  >
                    <Text style={styles.miniBotonText}>
                      Registrar este mes
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => alternarActivo(rec)}
                  style={styles.miniBoton}
                >
                  <Text style={styles.miniBotonText}>
                    {rec.activo ? 'Pausar' : 'Activar'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => abrirRecurrente(rec)}
                  style={styles.miniBoton}
                >
                  <Text style={styles.miniBotonText}>Editar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => eliminarRecurrente(rec)}
                  style={styles.miniBoton}
                >
                  <Text style={styles.miniBotonTextEliminar}>Eliminar</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })
      )}

      <Modal
        visible={pendiente !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPendiente(null)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setPendiente(null)}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View
              style={styles.modalCard}
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              {pendiente ? (
                <>
                  <Text style={styles.modalTitle}>
                    Registrar {pendiente.rec.nombre} — {periodoLabel}
                  </Text>
                  <Text
                    style={styles.modalSub}
                    lightColor="#6b7280"
                    darkColor="#9ca3af"
                  >
                    Revisa el monto real y la fecha del pago.
                  </Text>
                  <TextInput
                    style={inputStyle}
                    value={pMonto}
                    onChangeText={(texto) => setPMonto(formatearMontoEnEntrada(texto))}
                    placeholder="Monto real"
                    placeholderTextColor={
                      colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                    }
                    keyboardType={Platform.OS === 'web' ? 'default' : 'numeric'}
                  />
                  <SelectorFecha
                    valor={pFecha}
                    alCambiar={setPFecha}
                    contenedorEstilo={inputBoxStyle}
                    textoEstilo={[
                      styles.fechaText,
                      { color: colorScheme === 'dark' ? '#f9fafb' : '#111827' },
                    ]}
                    accesibilidadLabel="Fecha del pago recurrente"
                    bloquearFuturo
                  />
                  <Text
                    style={styles.modalSub}
                    lightColor="#6b7280"
                    darkColor="#9ca3af"
                  >
                    {cuentaNombrePendiente}
                  </Text>
                  {error ? (
                    <Text
                      style={styles.error}
                      lightColor="#b91c1c"
                      darkColor="#fca5a5"
                    >
                      {error}
                    </Text>
                  ) : null}
                  <View
                    style={styles.nameActions}
                    lightColor="transparent"
                    darkColor="transparent"
                  >
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => void confirmarPendiente()}
                      disabled={pSaving}
                      style={styles.confirmButton}
                    >
                      <Text style={styles.confirmText}>
                        {pSaving ? 'Guardando...' : 'Registrar'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => {
                        setPendiente(null);
                        setError('');
                      }}
                      disabled={pSaving}
                      style={styles.cancelButton}
                    >
                      <Text style={styles.cancelText}>Cancelar</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={recOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRecOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => {
            if (!rSaving) setRecOpen(false);
          }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View
              style={styles.modalCard}
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              <Text style={styles.modalTitle}>
                {recEditando ? 'Editar recurrente' : 'Nuevo recurrente'}
              </Text>
              <View
                style={styles.chipRow}
                lightColor="transparent"
                darkColor="transparent"
              >
                {(['gasto', 'ingreso'] as const).map((tipoOpcion) => (
                  <TouchableOpacity
                    key={tipoOpcion}
                    accessibilityRole="button"
                    onPress={() => setRTipo(tipoOpcion)}
                    style={[chipInactivo, rTipo === tipoOpcion && styles.chipActivo]}
                  >
                    <Text
                      style={[
                        chipTextoInactivo,
                        rTipo === tipoOpcion ? styles.chipTextActivo : null,
                      ]}
                    >
                      {tipoOpcion === 'gasto' ? '⬇️ Gasto' : '⬆️ Ingreso'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={inputStyle}
                value={rNombre}
                onChangeText={setRNombre}
                placeholder="Nombre (ej: Sueldo, Arriendo)"
                placeholderTextColor={colorScheme === 'dark' ? '#9ca3af' : '#6b7280'}
                autoCapitalize="sentences"
              />
              <TextInput
                style={inputStyle}
                value={rMonto}
                onChangeText={(texto) => setRMonto(formatearMontoEnEntrada(texto))}
                placeholder="Monto base (ej: 950.000)"
                placeholderTextColor={colorScheme === 'dark' ? '#9ca3af' : '#6b7280'}
                keyboardType={Platform.OS === 'web' ? 'default' : 'numeric'}
              />
              <TextInput
                style={inputStyle}
                value={rDia}
                onChangeText={setRDia}
                placeholder="Día del mes (1-31, vacío = cada mes)"
                placeholderTextColor={colorScheme === 'dark' ? '#9ca3af' : '#6b7280'}
                keyboardType={Platform.OS === 'web' ? 'default' : 'number-pad'}
              />

              <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
                Cuenta
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
                style={styles.chipScroll}
              >
                {cuentaOptions.map((cuenta) => (
                  <TouchableOpacity
                    key={cuenta.id}
                    accessibilityRole="button"
                    onPress={() => setRCuentaId(cuenta.id)}
                    style={[chipInactivo, rCuentaId === cuenta.id && styles.chipActivo]}
                  >
                    <Text
                      style={[
                        chipTextoInactivo,
                        rCuentaId === cuenta.id ? styles.chipTextActivo : null,
                      ]}
                    >
                      {cuenta.banco ? `${cuenta.nombre} · ${cuenta.banco}` : cuenta.nombre}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
                Categoría
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
                style={styles.chipScroll}
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => {
                    setRCategoriaId(null);
                    setRSubcatId(null);
                  }}
                  style={[chipInactivo, rCategoriaId === null && styles.chipActivo]}
                >
                  <Text
                    style={[
                      chipTextoInactivo,
                      rCategoriaId === null ? styles.chipTextActivo : null,
                    ]}
                  >
                    Sin categoría
                  </Text>
                </TouchableOpacity>
                {categoriaOptions.map((categoria) => (
                  <TouchableOpacity
                    key={categoria.id}
                    accessibilityRole="button"
                    onPress={() => {
                      setRCategoriaId(categoria.id);
                      setRSubcatId(null);
                    }}
                    style={[
                      chipInactivo,
                      rCategoriaId === categoria.id && styles.chipActivo,
                    ]}
                  >
                    <Text
                      style={[
                        chipTextoInactivo,
                        rCategoriaId === categoria.id
                          ? styles.chipTextActivo
                          : null,
                      ]}
                    >
                      {categoria.nombre}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {rCategoriaId !== null && rSubcatOptionsFiltradas.length > 0 ? (
                <>
                  <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
                    Subcategoría
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipRow}
                    style={styles.chipScroll}
                  >
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => setRSubcatId(null)}
                      style={[chipInactivo, rSubcatId === null && styles.chipActivo]}
                    >
                      <Text
                        style={[
                          chipTextoInactivo,
                          rSubcatId === null ? styles.chipTextActivo : null,
                        ]}
                      >
                        Ninguna
                      </Text>
                    </TouchableOpacity>
                    {rSubcatOptionsFiltradas.map((subcat) => (
                      <TouchableOpacity
                        key={subcat.id}
                        accessibilityRole="button"
                        onPress={() => setRSubcatId(subcat.id)}
                        style={[
                          chipInactivo,
                          rSubcatId === subcat.id && styles.chipActivo,
                        ]}
                      >
                        <Text
                          style={[
                            chipTextoInactivo,
                            rSubcatId === subcat.id ? styles.chipTextActivo : null,
                          ]}
                        >
                          {subcat.nombre}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </>
              ) : null}

              {etiquetaOptions.length > 0 ? (
                <>
                  <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
                    Etiquetas
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipRow}
                    style={styles.chipScroll}
                  >
                    {etiquetaOptions.map((etiqueta) => (
                      <TouchableOpacity
                        key={etiqueta.id}
                        accessibilityRole="button"
                        onPress={() =>
                          setRTagIds((previo) => toggleTag(previo, etiqueta.id))
                        }
                        style={[
                          chipInactivo,
                          rTagIds.includes(etiqueta.id) && styles.chipActivo,
                        ]}
                      >
                        <Text
                          style={[
                            chipTextoInactivo,
                            rTagIds.includes(etiqueta.id)
                              ? styles.chipTextActivo
                              : null,
                          ]}
                        >
                          {textoEtiqueta(etiqueta)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </>
              ) : null}

              {error ? (
                <Text
                  style={styles.error}
                  lightColor="#b91c1c"
                  darkColor="#fca5a5"
                >
                  {error}
                </Text>
              ) : null}

              <View
                style={styles.nameActions}
                lightColor="transparent"
                darkColor="transparent"
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => void guardarRecurrente()}
                  disabled={rSaving}
                  style={styles.confirmButton}
                >
                  <Text style={styles.confirmText}>
                    {rSaving ? 'Guardando...' : 'Guardar'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => {
                    setRecOpen(false);
                    setError('');
                  }}
                  disabled={rSaving}
                  style={styles.cancelButton}
                >
                  <Text style={styles.cancelText}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    flexGrow: 1,
    padding: 24,
    paddingBottom: 36,
  },
  heading: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 16,
    marginTop: 6,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 10,
  },
  seccionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  agregarText: {
    color: '#4f46e5',
    fontWeight: '600',
    fontSize: 15,
  },
  pendienteCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    backgroundColor: '#fff7ed',
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  pendienteTitulo: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  pendienteDetalle: {
    fontSize: 13,
    marginBottom: 10,
  },
  pendienteBotones: {
    flexDirection: 'row',
    gap: 10,
  },
  pendienteRegistrar: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#c2410c',
  },
  pendienteRegistrarText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  pendienteSaltar: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  pendienteSaltarText: {
    color: '#c2410c',
    fontWeight: '600',
  },
  card: {
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
  },
  chipScroll: {
    flexGrow: 0,
    marginBottom: 8,
  },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#e0e7ff',
  },
  chipActivo: {
    backgroundColor: '#4f46e5',
    borderColor: '#4f46e5',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextActivo: {
    color: '#ffffff',
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 10,
  },
  fechaText: {
    fontSize: 15,
  },
  labelMini: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
    marginBottom: 6,
  },
  guardarButton: {
    alignItems: 'center',
    padding: 13,
    borderRadius: 10,
    backgroundColor: '#4f46e5',
    marginTop: 6,
  },
  guardarText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  listaSpinner: {
    marginVertical: 14,
  },
  vacio: {
    fontSize: 15,
    marginBottom: 12,
  },
  recHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  recInfo: {
    flex: 1,
  },
  recNombre: {
    fontSize: 16,
    fontWeight: '600',
  },
  recDetalle: {
    fontSize: 13,
    marginTop: 3,
  },
  recEstado: {
    fontSize: 13,
    fontWeight: '600',
  },
  recAcciones: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  miniBoton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#e0e7ff',
  },
  miniBotonText: {
    color: '#4338ca',
    fontWeight: '600',
    fontSize: 12,
  },
  miniBotonTextEliminar: {
    color: '#b91c1c',
    fontWeight: '600',
    fontSize: 12,
  },
  message: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 10,
  },
  error: {
    fontSize: 14,
    marginTop: 10,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    borderRadius: 18,
    padding: 24,
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  modalSub: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  nameActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginTop: 8,
  },
  confirmButton: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#4f46e5',
  },
  confirmText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  cancelButton: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  cancelText: {
    fontWeight: '600',
  },
});
