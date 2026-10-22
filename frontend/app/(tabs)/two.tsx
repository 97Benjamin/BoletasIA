import { useEffect, useState, Fragment, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import SelectorFecha from '@/components/SelectorFecha';
import type { User } from '@supabase/supabase-js';
import { Redirect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { useThemeMode } from '@/components/ThemeMode';
import { supabase } from '@/src/services/supabase';
import { formatChileanPesos } from '@/src/utils/currency';

type DatabaseRow = Record<string, unknown>;
type DatabaseId = string | number;

type TransactionItem = {
  product: string;
  price: number | null;
  category: string | null;
  subcategory: string | null;
  tags: string[];
};

type TransactionDetail = {
  id: string;
  date: string | null;
  type: string | null;
  total: number | null;
  frequency: string | null;
  account: string | null;
  accountType: string | null;
  bank: string | null;
  accountBalance: number | null;
  merchant: string | null;
  category: string | null;
  subcategory: string | null;
  extraDetails: Array<{ label: string; value: string }>;
  items: TransactionItem[];
  tags: string[];
  // Datos crudos para edición de artículos
  itemRows?: Array<{
    id: number;
    producto: string;
    precio: number | null;
    categoria_id: number | null;
    subcategoria_id: number | null;
    etiqueta_ids: number[];
  }>;
};

type CuentaOpt = { id: number; nombre: string };
type CategoriaOpt = { id: number; nombre: string };
type SubcatOpt = { id: number; nombre: string; categoryId: number };
type EtiquetaOpt = { id: number; nombre: string };

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
    decimalValue = normalized.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) {
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

function rowsOrThrow(data: unknown, error: { message: string } | null) {
  if (error) throw new Error(error.message);
  return Array.isArray(data)
    ? data.filter(
        (row): row is DatabaseRow =>
          typeof row === 'object' && row !== null && !Array.isArray(row)
      )
    : [];
}

function readId(row: DatabaseRow, key: string): DatabaseId | null {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : null;
}

function readText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readAmount(row: DatabaseRow, key: string): number | null {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function formatFieldName(field: string) {
  return field
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Detecta timestamps ISO (ej: 2026-10-20T16:11:28+00:00) y los muestra
// como en Chile: hora 12h + día/mes/año → "1:11 PM 20/10/2026".
function formatFechaHoraLegible(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const horas = date.getHours();
  const minutos = String(date.getMinutes()).padStart(2, '0');
  const periodo = horas >= 12 ? 'PM' : 'AM';
  const hora12 = horas % 12 === 0 ? 12 : horas % 12;
  return `${hora12}:${minutos} ${periodo} ${date.getDate()}/${
    date.getMonth() + 1
  }/${date.getFullYear()}`;
}

function formatFieldValue(value: unknown) {
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'string') {
    return formatFechaHoraLegible(value) ?? value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (value !== null && value !== undefined) {
    return JSON.stringify(value);
  }
  return '';
}

function indexRows(rows: DatabaseRow[]) {
  return new Map(
    rows.flatMap((row) => {
      const id = readId(row, 'id');
      return id === null ? [] : [[String(id), row] as const];
    })
  );
}

function formatDate(date: string | null) {
  if (!date) return 'Fecha no disponible';
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatAmount(amount: number | null) {
  if (amount === null) return 'Monto no disponible';
  return formatChileanPesos(amount);
}

function groupRows(rows: DatabaseRow[], foreignKey: string) {
  const grouped = new Map<string, DatabaseRow[]>();
  for (const row of rows) {
    const id = readId(row, foreignKey);
    if (id === null) continue;
    const key = String(id);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

export default function TransactionsScreen() {
  const { colorScheme } = useThemeMode();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<TransactionDetail[]>([]);
  const [vista, setVista] = useState<'movimientos' | 'resumen'>('movimientos');

  // --- Lógica de Resumen Robusta ---
  // 1. Obtener todas las fechas disponibles
  const todasLasFechas = transactions.map((t) => new Date(t.date).getTime());
  const minTime = todasLasFechas.length > 0 ? Math.min(...todasLasFechas) : new Date().getTime();
  const maxTime = new Date().getTime();
  
  const primeraFecha = new Date(minTime);
  const hoy = new Date();
  
  // 2. Crear rango de días completo
  const diasEntre = Math.max(1, Math.floor((hoy.getTime() - primeraFecha.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const serieAcumulada: number[] = [];
  const labels: string[] = [];
  
  let saldoAcumulado = 0;
  for (let i = 0; i < diasEntre; i++) {
    const fechaIteracion = new Date(primeraFecha);
    fechaIteracion.setDate(primeraFecha.getDate() + i);
    // Comparación estricta de fecha YYYY-MM-DD
    const fechaStr = fechaIteracion.toISOString().split('T')[0];
    
    // Sumar movimientos de este día específico
    const movsDelDia = transactions.filter(t => t.date === fechaStr);
    movsDelDia.forEach(t => {
      saldoAcumulado += (t.type === 'ingreso' ? t.total : -t.total);
    });
    
    serieAcumulada.push(saldoAcumulado);
    
    // Labels legibles: mostrar inicio, fin y puntos intermedios
    if (i === 0 || i === diasEntre - 1 || i % Math.max(1, Math.floor(diasEntre / 5)) === 0) {
        labels.push(fechaStr.split('-')[2]); // Día
    } else {
        labels.push('');
    }
  }

  const dataChart = {
    labels: labels,
    datasets: [
      {
        data: serieAcumulada,
        strokeWidth: 2,
        color: (opacity = 1) => `rgba(79, 70, 229, ${opacity})`,
        withDots: false,
      },
      {
        // Serie secundaria solo para los puntos donde hubo movimiento
        data: serieAcumulada.map((val, i) => {
            const fechaIteracion = new Date(primeraFecha);
            fechaIteracion.setDate(primeraFecha.getDate() + i);
            const fechaStr = fechaIteracion.toISOString().split('T')[0];
            return transactions.some(t => t.date === fechaStr) ? val : null;
        }),
        withDots: true,
      }
    ],
  };
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  // Catálogos para editar transacciones
  const [cuentaOptions, setCuentaOptions] = useState<CuentaOpt[]>([]);
  const [categoriaOptions, setCategoriaOptions] = useState<CategoriaOpt[]>([]);
  const [subcategoriaOptions, setSubcategoriaOptions] = useState<SubcatOpt[]>([]);
  const [etiquetaOptions, setEtiquetaOptions] = useState<EtiquetaOpt[]>([]);

  const [editOpen, setEditOpen] = useState(false);
  const [editTx, setEditTx] = useState<TransactionDetail | null>(null);
  const [eTipo, setETipo] = useState<'gasto' | 'ingreso'>('gasto');
  const [eNombre, setENombre] = useState('');
  const [eMonto, setEMonto] = useState('');
  const [eFecha, setEFecha] = useState(formatFecha(new Date()));
  const [eCuentaId, setECuentaId] = useState<number | null>(null);
  const [eCategoriaId, setECategoriaId] = useState<number | null>(null);
  const [eSubcatId, setESubcatId] = useState<number | null>(null);
  const [eTagIds, setETagIds] = useState<number[]>([]);
  const [eSaving, setESaving] = useState('');
  const [eMessage, setEMessage] = useState('');
  const [datePickerFor, setDatePickerFor] = useState(false);
  const authEventReceived = useRef(false);
  const [itemEdits, setItemEdits] = useState<Array<{
    id: number;
    producto: string;
    precio: string;
    categoriaId: number | null;
    subcategoriaId: number | null;
    etiquetaIds: number[];
  }>>([]);

  // Recalcula el total de la transacción cuando cambia algún artículo
  // (al abrir el modal no pisa el total original)
  const skipTotalPorArticulos = useRef(true);
  useEffect(() => {
    if (!editOpen) {
      skipTotalPorArticulos.current = true;
      return;
    }
    if (skipTotalPorArticulos.current) {
      skipTotalPorArticulos.current = false;
      return;
    }
    const suma = itemEdits.reduce((acc, it) => {
      const n = it.precio ? Number(inputAmount(it.precio)) : 0;
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
    setEMonto(String(suma));
  }, [itemEdits, editOpen]);

  useEffect(() => {
    let isMounted = true;
    let authEventReceived = false;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventReceived = true;
      if (isMounted) {
        setUser(session?.user ?? null);
        setLoading(false);
      }
    });

    supabase.auth
      .getUser()
      .then(({ data: { user: currentUser }, error: authError }) => {
        if (!isMounted || authEventReceived) return;
        if (authError) {
          setError(`No se pudo validar la sesión: ${authError.message}`);
        } else {
          setUser(currentUser);
        }
        setLoading(false);
      })
      .catch((authError: unknown) => {
        if (!isMounted || authEventReceived) return;
        setError(
          `No se pudo validar la sesión: ${
            authError instanceof Error
              ? authError.message
              : 'Error desconocido'
          }`
        );
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
      const [cuentaResult, categoriaResult, subcatResult, tagResult] =
        await Promise.all([
          supabase
            .from('cuentas')
            .select('id, nombre')
            .eq('user_id', userId)
            .order('nombre'),
          supabase
            .from('categorias')
            .select('id, nombre, user_id')
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order('nombre'),
          supabase
            .from('subcategorias')
            .select('id, nombre, categoria_id, user_id')
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order('nombre'),
          supabase
            .from('etiquetas')
            .select('id, nombre, user_id')
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order('nombre'),
        ]);
      if (!isMounted) return;
      const mapSimple = (rows: unknown[]) =>
        (rows ?? [])
          .map((row) => {
            const record = row as { id: unknown; nombre: unknown };
            if (
              typeof record.id !== 'number' ||
              typeof record.nombre !== 'string'
            ) {
              return null;
            }
            return { id: record.id, nombre: record.nombre.trim() };
          })
          .filter((item): item is CuentaOpt => item !== null);
      setCuentaOptions(mapSimple(cuentaResult.data ?? []));
      setCategoriaOptions(mapSimple(categoriaResult.data ?? []));
      const subcatRows = (subcatResult.data ?? []) as {
        id: unknown;
        nombre: unknown;
        categoria_id: unknown;
      }[];
      setSubcategoriaOptions(
        subcatRows.flatMap((row) => {
          if (
            typeof row.id !== 'number' ||
            typeof row.nombre !== 'string' ||
            typeof row.categoria_id !== 'number'
          ) {
            return [];
          }
          return [
            {
              id: row.id,
              nombre: row.nombre.trim(),
              categoryId: row.categoria_id,
            },
          ];
        })
      );
      setEtiquetaOptions(mapSimple(tagResult.data ?? []));
    }

    void loadCatalog();
    return () => {
      isMounted = false;
    };
  }, [user?.id]);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setTransactions([]);
      setTransactionsLoading(false);
      return;
    }

    let isMounted = true;
    setError('');
    setTransactions([]);
    setTransactionsLoading(true);

    async function loadTransactions() {
      try {
        const { data: transactionData, error: transactionError } =
          await supabase
            .from('transacciones')
            .select('*')
            .eq('user_id', userId)
            .order('fecha', { ascending: false });
        const transactionRows = rowsOrThrow(
          transactionData,
          transactionError
        );

        if (transactionRows.length === 0) {
          if (isMounted) setTransactions([]);
          return;
        }

        const transactionIds = transactionRows
          .map((row) => readId(row, 'id'))
          .filter((id): id is DatabaseId => id !== null);
        const accountIds = [
          ...new Set(
            transactionRows
              .map((row) => readId(row, 'cuenta_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];
        const merchantIds = [
          ...new Set(
            transactionRows
              .map((row) => readId(row, 'comercio_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];
        const categoryIds = [
          ...new Set(
            transactionRows
              .map((row) => readId(row, 'categoria_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];

        const [
          accountResult,
          merchantResult,
          categoryResult,
          itemResult,
          transactionTagResult,
        ] = await Promise.all([
          accountIds.length
            ? supabase.from('cuentas').select('*').in('id', accountIds)
            : Promise.resolve({ data: [], error: null }),
          merchantIds.length
            ? supabase.from('comercios').select('*').in('id', merchantIds)
            : Promise.resolve({ data: [], error: null }),
          categoryIds.length
            ? supabase.from('categorias').select('*').in('id', categoryIds)
            : Promise.resolve({ data: [], error: null }),
          supabase
            .from('transaccion_items')
            .select('*')
            .in('transaccion_id', transactionIds),
          supabase
            .from('transaccion_etiquetas')
            .select('*')
            .in('transaccion_id', transactionIds),
        ]);

        const accountRows = rowsOrThrow(accountResult.data, accountResult.error);
        const merchantRows = rowsOrThrow(
          merchantResult.data,
          merchantResult.error
        );
        const categoryRows = rowsOrThrow(
          categoryResult.data,
          categoryResult.error
        );
        const itemRows = rowsOrThrow(itemResult.data, itemResult.error);
        const transactionTagRows = rowsOrThrow(
          transactionTagResult.data,
          transactionTagResult.error
        );
        const itemIds = itemRows
          .map((row) => readId(row, 'id'))
          .filter((id): id is DatabaseId => id !== null);
        const itemTagResult = itemIds.length
          ? await supabase
              .from('transaccion_item_etiquetas')
              .select('*')
              .in('transaccion_item_id', itemIds)
          : { data: [], error: null };
        const itemTagRows = rowsOrThrow(
          itemTagResult.data,
          itemTagResult.error
        );
        const itemCategoryIds = itemRows
          .map((row) => readId(row, 'categoria_id'))
          .filter((id): id is DatabaseId => id !== null);
        const allCategoryIds = [
          ...new Set([...categoryIds, ...itemCategoryIds.map(String)]),
        ];
        const extraCategoryResult = allCategoryIds.length
          ? await supabase
              .from('categorias')
              .select('*')
              .in('id', allCategoryIds)
          : { data: [], error: null };
        const extraCategoryRows = rowsOrThrow(
          extraCategoryResult.data,
          extraCategoryResult.error
        );
        const itemSubcategoryIds = itemRows
          .map((row) => readId(row, 'subcategoria_id'))
          .filter((id): id is DatabaseId => id !== null);
        const transactionSubcategoryIds = transactionRows
          .map((row) => readId(row, 'subcategoria_id'))
          .filter((id): id is DatabaseId => id !== null);
        const subcategoryIds = [
          ...new Set(
            [...itemSubcategoryIds, ...transactionSubcategoryIds].map(String)
          ),
        ];
        const subcategoryResult = subcategoryIds.length
          ? await supabase
              .from('subcategorias')
              .select('*')
              .in('id', subcategoryIds)
          : { data: [], error: null };
        const subcategoryRows = rowsOrThrow(
          subcategoryResult.data,
          subcategoryResult.error
        );

        const tagIds = [
          ...new Set(
            [...transactionTagRows, ...itemTagRows]
              .map((row) => readId(row, 'etiqueta_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];
        const tagResult = tagIds.length
          ? await supabase.from('etiquetas').select('*').in('id', tagIds)
          : { data: [], error: null };
        const tagRows = rowsOrThrow(tagResult.data, tagResult.error);

        const accountsById = indexRows(accountRows);
        const merchantsById = indexRows(merchantRows);
        const categoriesById = indexRows([
          ...categoryRows,
          ...extraCategoryRows,
        ]);
        const subcategoriesById = indexRows(subcategoryRows);
        const tagsById = indexRows(tagRows);
        const itemsByTransaction = groupRows(itemRows, 'transaccion_id');
        const tagsByItem = groupRows(itemTagRows, 'transaccion_item_id');
        const tagsByTransaction = groupRows(
          transactionTagRows,
          'transaccion_id'
        );

        const results = transactionRows.map((row): TransactionDetail => {
          const account = accountsById.get(String(readId(row, 'cuenta_id')));
          const merchant = merchantsById.get(
            String(readId(row, 'comercio_id'))
          );
          const category = categoriesById.get(
            String(readId(row, 'categoria_id'))
          );
          const subcategory = subcategoriesById.get(
            String(readId(row, 'subcategoria_id'))
          );
          const id = readId(row, 'id');
          const rowItems =
            id === null ? [] : itemsByTransaction.get(String(id)) ?? [];
          const rowTags =
            id === null ? [] : tagsByTransaction.get(String(id)) ?? [];

          return {
            id: id === null ? '—' : String(id),
            date: readText(row, 'fecha'),
            type: readText(row, 'tipo'),
            total: readAmount(row, 'total'),
            frequency: readText(row, 'frecuencia'),
            account: account ? readText(account, 'nombre') : null,
            accountType: account ? readText(account, 'tipo') : null,
            bank: account ? readText(account, 'banco') : null,
            accountBalance: account
              ? readAmount(account, 'saldo_actual')
              : null,
            merchant: merchant ? readText(merchant, 'nombre') : null,
            category: category ? readText(category, 'nombre') : null,
            subcategory: subcategory
              ? readText(subcategory, 'nombre')
              : null,
            extraDetails: Object.entries(row)
              .filter(
                ([key]) =>
                  ![
                    'id',
                    'user_id',
                    'cuenta_id',
                    'comercio_id',
                    'categoria_id',
                    'tipo',
                    'fecha',
                    'total',
                    'frecuencia',
                  ].includes(key)
              )
              .flatMap(([key, value]) => {
                const formattedValue = formatFieldValue(value);
                return formattedValue
                  ? [{ label: formatFieldName(key), value: formattedValue }]
                  : [];
              }),
            items: rowItems.map((item) => ({
              product: readText(item, 'producto') ?? 'Artículo',
              price: readAmount(item, 'precio'),
              category: categoriesById.has(String(readId(item, 'categoria_id')))
                ? readText(
                    categoriesById.get(String(readId(item, 'categoria_id'))) ??
                      {},
                    'nombre'
                  )
                : null,
              subcategory: subcategoriesById.has(
                String(readId(item, 'subcategoria_id'))
              )
                ? readText(
                    subcategoriesById.get(
                      String(readId(item, 'subcategoria_id'))
                    ) ?? {},
                    'nombre'
                  )
                : null,
              tags: (tagsByItem.get(
                String(readId(item, 'id'))
              ) ?? []).flatMap((tagLink) => {
                const tagId = readId(tagLink, 'etiqueta_id');
                const tag =
                  tagId === null ? null : tagsById.get(String(tagId));
                const name = tag ? readText(tag, 'nombre') : null;
                return name ? [name] : [];
              }),
            })),
            itemRows: rowItems.map((item) => ({
              id: Number(readId(item, 'id') ?? 0),
              producto: readText(item, 'producto') ?? '',
              precio: readAmount(item, 'precio'),
              categoria_id:
                readId(item, 'categoria_id') === null
                  ? null
                  : Number(readId(item, 'categoria_id')),
              subcategoria_id:
                readId(item, 'subcategoria_id') === null
                  ? null
                  : Number(readId(item, 'subcategoria_id')),
              etiqueta_ids: (tagsByItem.get(String(readId(item, 'id'))) ?? [])
                .flatMap((tagLink) => {
                  const tagId = readId(tagLink, 'etiqueta_id');
                  return tagId === null ? [] : [Number(tagId)];
                }),
            })),
            tags: rowTags.flatMap((tagLink) => {
              const tagId = readId(tagLink, 'etiqueta_id');
              if (tagId === null) return [];
              const tag = tagsById.get(String(tagId));
              const name = tag ? readText(tag, 'nombre') : null;
              return name ? [name] : [];
            }),
          };
        });

        if (isMounted) setTransactions(results);
      } catch (loadError: unknown) {
        if (isMounted) {
          setError(
            `No se pudieron cargar las transacciones: ${
              loadError instanceof Error
                ? loadError.message
                : 'Error desconocido'
            }`
          );
        }
      } finally {
        if (isMounted) setTransactionsLoading(false);
      }
    }

    void loadTransactions();
    return () => {
      isMounted = false;
    };
  }, [user?.id, reload]);

  function toggleTag(list: number[], id: number) {
    return list.includes(id)
      ? list.filter((value) => value !== id)
      : [...list, id];
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

  function abrirEdicion(tx: TransactionDetail) {
    setEditTx(tx);
    setETipo(tx.type === 'ingreso' ? 'ingreso' : 'gasto');
    setENombre(tx.merchant ?? '');
    setEMonto(tx.total !== null ? String(tx.total) : '');
    setEFecha(tx.date ?? formatFecha(new Date()));
    setECategoriaId(
      tx.category
        ? (categoriaOptions.find((c) => c.nombre === tx.category)?.id ?? null)
        : null
    );
    setESubcatId(
      tx.subcategory
        ? (subcategoriaOptions.find((s) => s.nombre === tx.subcategory)?.id ?? null)
        : null
    );
    setECuentaId(
      tx.account
        ? (cuentaOptions.find((c) => c.nombre === tx.account)?.id ?? null)
        : null
    );
    setETagIds(
      etiquetaOptions
        .filter((tag) => tx.tags.includes(tag.nombre))
        .map((tag) => tag.id)
    );
    // Cargar artículos para edición
    const itemIds = (tx as Record<string, unknown>).itemIds as number[] | undefined;
    const itemData = (tx as Record<string, unknown>).itemRows as Array<{ id: number; producto: string; precio: number | null; categoria_id: number | null; subcategoria_id: number | null; etiqueta_ids: number[] }> | undefined;
    setItemEdits(
      (itemData ?? (tx.items || []).map((item, idx) => ({
        id: itemIds?.[idx] ?? idx + 1,
        producto: item.product ?? '',
        precio: item.price !== null ? String(item.price) : '',
        categoriaId: null,
        subcategoriaId: null,
        etiquetaIds: [],
      }))).map((row: any) => ({
        id: row.id ?? 0,
        producto: row.producto ?? (row.product ?? ''),
        precio: row.precio !== null && typeof row.precio === 'number' ? String(row.precio) : (row.precio ?? ''),
        categoriaId: row.categoriaId ?? row.categoria_id ?? null,
        subcategoriaId: row.subcategoriaId ?? row.subcategoria_id ?? null,
        etiquetaIds: row.etiquetaIds ?? row.etiqueta_ids ?? [],
      }))
    );
    setESaving('');
    setEMessage('');
    setEditOpen(true);
  }

  async function guardarEdicion() {
    if (!editTx || eSaving) return;
    const transaccionId = Number(editTx.id);
    if (!Number.isFinite(transaccionId)) {
      setESaving('ID de transacción inválido.');
      return;
    }
    const monto = inputAmount(eMonto);
    if (monto === null) {
      setESaving('Escribe un monto válido mayor que cero.');
      return;
    }
    if (eCuentaId === null) {
      setESaving(
        'Elige la cuenta asociada (crea una en "Mi cuenta" si aún no tienes).'
      );
      return;
    }
    if (eSubcatId !== null && eCategoriaId === null) {
      setESaving('Para subcategoría primero elige una categoría.');
      return;
    }
    setESaving('Guardando...');
    try {
      const comercioId = await resolverComercio(eNombre);
      const { error: updateError } = await supabase
        .from('transacciones')
        .update({
          tipo: eTipo,
          cuenta_id: eCuentaId,
          comercio_id: comercioId,
          categoria_id: eCategoriaId,
          subcategoria_id: eCategoriaId === null ? null : eSubcatId,
          fecha: eFecha,
          total: String(monto),
          actualizado_en: new Date().toISOString(),
        })
        .eq('id', transaccionId);
      if (updateError) throw updateError;

      // Borrar artículos eliminados de la edición
      const idsOriginales = (editTx.itemRows ?? []).map((r) => r.id);
      const idsActuales = new Set(itemEdits.map((it) => it.id));
      for (const idOrig of idsOriginales) {
        if (!idsActuales.has(idOrig)) {
          await supabase
            .from('transaccion_item_etiquetas')
            .delete()
            .eq('transaccion_item_id', idOrig);
          await supabase
            .from('transaccion_items')
            .delete()
            .eq('id', idOrig);
        }
      }

      // Actualizar / crear artículos y sincronizar sus etiquetas
      for (const item of itemEdits) {
        if (!item.producto.trim()) continue;
        const precioNum = item.precio ? Number(inputAmount(item.precio)) : null;
        if (item.id > 10000 || item.id < 0) {
          // artículo nuevo
          const { data: newItem } = await supabase
            .from('transaccion_items')
            .insert({
              transaccion_id: transaccionId,
              producto: item.producto.trim(),
              precio: precioNum,
              categoria_id: item.categoriaId,
              subcategoria_id: item.subcategoriaId,
            })
            .select('id');
          const newId = (newItem as { id: number }[] | null)?.[0]?.id;
          if (typeof newId === 'number' && (item.etiquetaIds ?? []).length > 0) {
            await supabase.from('transaccion_item_etiquetas').insert(
              item.etiquetaIds.map((etiquetaId) => ({
                transaccion_item_id: newId,
                etiqueta_id: etiquetaId,
              }))
            );
          }
        } else {
          await supabase
            .from('transaccion_items')
            .update({
              producto: item.producto.trim(),
              precio: precioNum,
              categoria_id: item.categoriaId,
              subcategoria_id: item.subcategoriaId,
            })
            .eq('id', item.id);
          await supabase
            .from('transaccion_item_etiquetas')
            .delete()
            .eq('transaccion_item_id', item.id);
          if ((item.etiquetaIds ?? []).length > 0) {
            await supabase.from('transaccion_item_etiquetas').insert(
              item.etiquetaIds.map((etiquetaId) => ({
                transaccion_item_id: item.id,
                etiqueta_id: etiquetaId,
              }))
            );
          }
        }
      }

      // Etiquetas de transacción: reemplazar
      const { error: deleteTagsError } = await supabase
        .from('transaccion_etiquetas')
        .delete()
        .eq('transaccion_id', transaccionId);
      if (deleteTagsError) throw deleteTagsError;
      if (eTagIds.length > 0) {
        const { error: insertTagsError } = await supabase
          .from('transaccion_etiquetas')
          .insert(
            eTagIds.map((etiquetaId) => ({
              transaccion_id: transaccionId,
              etiqueta_id: etiquetaId,
            }))
          );
        if (insertTagsError) throw insertTagsError;
      }

      setEMessage('Transacción actualizada.');
      setEditOpen(false);
      setReload((value) => value + 1);
    } catch (saveError: unknown) {
      setESaving(
        `No se pudo guardar: ${
          saveError instanceof Error ? saveError.message : 'Error desconocido'
        }`
      );
    }
  }

  function eliminarTransaccion(tx: TransactionDetail) {
    Alert.alert(
      'Eliminar transacción',
      `¿Eliminar esta transacción${tx.merchant ? ` de "${tx.merchant}"` : ''}? Se borrarán también sus artículos y etiquetas.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const transaccionId = Number(tx.id);
              if (!Number.isFinite(transaccionId)) return;
              await supabase
                .from('transaccion_etiquetas')
                .delete()
                .eq('transaccion_id', transaccionId);
              await supabase
                .from('transaccion_items')
                .delete()
                .eq('transaccion_id', transaccionId);
              const { error: deleteError } = await supabase
                .from('transacciones')
                .delete()
                .eq('id', transaccionId);
              if (deleteError) {
                setError(`No se pudo eliminar: ${deleteError.message}`);
                return;
              }
              setReload((value) => value + 1);
            })();
          },
        },
      ]
    );
  }

  const subcategoriaOptionsFiltradas = subcategoriaOptions.filter(
    (sub) => sub.categoryId === eCategoriaId
  );
  const eSubcatOptions = subcategoriaOptionsFiltradas;
  // Chips inactivos con buen contraste en ambos temas (igual que en ingresos-gastos)
  const chipInactivo = [
    styles.chip,
    {
      borderColor: colorScheme === 'dark' ? '#94a3b8' : '#c7d2fe',
      backgroundColor: colorScheme === 'dark' ? '#1e293b' : '#e0e7ff',
    },
  ];
  const chipTextoInactivo = [
    { fontSize: 13, fontWeight: '600' as const },
    { color: colorScheme === 'dark' ? '#e2e8f0' : '#4338ca' },
  ];
  // Tarjeta de artículo: gris azulado que armoniza con los chips y los inputs
  const itemCardStyle = [
    styles.itemEditCard,
    colorScheme === 'dark'
      ? { backgroundColor: '#1e293b', borderColor: '#334155' }
      : { backgroundColor: '#f1f5f9', borderColor: '#e2e8f0' },
  ];
  // Botón "Eliminar artículo": rojo sólido compacto (ocupa solo lo del texto)
  const eliminarItemStyle = [
    styles.miniBotonEliminar,
    { backgroundColor: colorScheme === 'dark' ? '#7f1d1d' : '#b91c1c' },
  ];
  const eliminarItemTextStyle = [
    styles.miniBotonEliminarText,
    { color: colorScheme === 'dark' ? '#fecaca' : '#ffffff' },
  ];
  const inputColors = {
    borderColor: colorScheme === 'dark' ? '#4b5563' : '#d1d5db',
    backgroundColor: colorScheme === 'dark' ? '#111827' : '#ffffff',
    color: colorScheme === 'dark' ? '#f9fafb' : '#111827',
  };
  const inputStyle = [
    styles.input,
    {
      borderColor: inputColors.borderColor,
      backgroundColor: inputColors.backgroundColor,
      color: inputColors.color,
    },
  ];
  const inputBoxStyle = [
    styles.input,
    {
      borderColor: inputColors.borderColor,
      backgroundColor: inputColors.backgroundColor,
    },
  ];

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (!user && !error) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Transacciones</Text>
      <Text style={styles.subtitle} lightColor="#6b7280" darkColor="#9ca3af">
        Historial de movimientos de tu cuenta
      </Text>

      {transactionsLoading ? (
        <View style={styles.messageCard} lightColor="#ffffff" darkColor="#1f2937">
          <ActivityIndicator size="large" color="#4f46e5" />
          <Text style={styles.message} lightColor="#6b7280" darkColor="#9ca3af">
            Cargando transacciones...
          </Text>
        </View>
      ) : error ? (
        <View style={styles.messageCard} lightColor="#ffffff" darkColor="#1f2937">
          <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
            {error}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setReload((value) => value + 1)}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : transactions.length === 0 ? (
        <View style={styles.messageCard} lightColor="#ffffff" darkColor="#1f2937">
          <Text style={styles.message} lightColor="#6b7280" darkColor="#9ca3af">
            Todavía no tienes transacciones registradas.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.toggleContainer}>
            <TouchableOpacity onPress={() => setVista('movimientos')} style={[styles.toggleButton, vista === 'movimientos' && styles.toggleButtonActive]}>
              <Text style={vista === 'movimientos' ? styles.toggleTextActive : styles.toggleText}>Movimientos</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setVista('resumen')} style={[styles.toggleButton, vista === 'resumen' && styles.toggleButtonActive]}>
              <Text style={vista === 'resumen' ? styles.toggleTextActive : styles.toggleText}>Resumen</Text>
            </TouchableOpacity>
          </View>

          {vista === 'resumen' ? (
            <View style={styles.card} lightColor="#ffffff" darkColor="#1f2937">
              <Text style={styles.sectionTitle}>Estado de resultados</Text>
              <LineChart
                data={dataChart}
                width={Dimensions.get('window').width - 40}
                height={220}
                chartConfig={{
                  backgroundColor: '#1f2937',
                  backgroundGradientFrom: '#1f2937',
                  backgroundGradientTo: '#111827',
                  color: (opacity = 1) => `rgba(79, 70, 229, ${opacity})`,
                  labelColor: (opacity = 1) => `rgba(156, 163, 175, ${opacity})`,
                }}
                bezier
                style={{ marginVertical: 8, borderRadius: 16 }}
              />
            </View>
          ) : (
            transactions.map((transaction) => (
          <View
            key={transaction.id}
            style={styles.card}
            lightColor="#ffffff"
            darkColor="#1f2937"
          >
            <View style={styles.cardHeader} lightColor="transparent" darkColor="transparent">
              <View lightColor="transparent" darkColor="transparent">
                <Text style={styles.date} lightColor="#6b7280" darkColor="#9ca3af">
                  {formatDate(transaction.date)}
                </Text>
                <Text style={styles.merchant}>
                  {transaction.merchant ?? 'Comercio no especificado'}
                </Text>
              </View>
              <View style={{flexDirection:'row',gap:8}} lightColor="transparent" darkColor="transparent">
                <Text style={styles.total}>
                  {formatAmount(transaction.total)}
                </Text>
                <TouchableOpacity onPress={()=>abrirEdicion(transaction)} style={[styles.editButton,{backgroundColor:'#4f46e5',borderColor:'#4f46e5'}]}>
                  <Text style={[styles.editButtonText,{color:"#ffffff"}]}>✎ Editar</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View
              style={styles.separator}
              lightColor="#e5e7eb"
              darkColor="#374151"
            />

            <View style={styles.detailsGrid} lightColor="transparent" darkColor="transparent">
              <Detail label="Fecha de transacción" value={formatDate(transaction.date)} fullWidth />
              <Detail label="Tipo" value={transaction.type} />
              <Detail label="Categoría" value={transaction.category} />
              <Detail label="Subcategoría" value={transaction.subcategory} />
              <Detail label="Cuenta" value={transaction.account} />
              <Detail label="Banco" value={transaction.bank} />
              <Detail label="Tipo de cuenta" value={transaction.accountType} />
              <Detail
                label="Saldo de la cuenta"
                value={
                  transaction.accountBalance === null
                    ? null
                    : formatAmount(transaction.accountBalance)
                }
              />
              <Detail label="Frecuencia" value={transaction.frequency} />
              {transaction.extraDetails.map((detail) => (
                <Detail
                  key={`${transaction.id}-${detail.label}`}
                  label={detail.label}
                  value={detail.value}
                />
              ))}
            </View>

            {transaction.items.length > 0 ? (
              <>
                <Text style={styles.sectionTitle}>Artículos</Text>
                {transaction.items.map((item, index) => (
                  <View
                    key={`${transaction.id}-item-${index}`}
                    style={styles.itemContainer}
                    lightColor="transparent"
                    darkColor="transparent"
                  >
                    <View
                      style={styles.itemRow}
                      lightColor="transparent"
                      darkColor="transparent"
                    >
                      <Text style={styles.itemName}>{item.product}</Text>
                      <Text style={styles.itemPrice}>
                        {formatAmount(item.price)}
                      </Text>
                    </View>
                    {item.category || item.subcategory || item.tags.length > 0 ? (
                      <Text
                        style={styles.itemMetadata}
                        lightColor="#6b7280"
                        darkColor="#9ca3af"
                      >
                        {[item.category, item.subcategory]
                          .filter(Boolean)
                          .join(' · ')}
                        {item.tags.length > 0
                          ? `${item.category || item.subcategory ? ' · ' : ''}${item.tags
                              .map((tag) => `#${tag}`)
                              .join(' ')}`
                          : ''}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </>
            ) : null}

            {transaction.tags.length > 0 ? (
              <View style={styles.tags} lightColor="transparent" darkColor="transparent">
                {transaction.tags.map((tag) => (
                  <Text
                    key={`${transaction.id}-${tag}`}
                    style={[
                      styles.tag,
                      {
                        backgroundColor:
                          colorScheme === 'dark' ? '#3730a3' : '#e0e7ff',
                      },
                    ]}
                    lightColor="#4338ca"
                    darkColor="#c7d2fe"
                  >
                    #{tag}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ))
      )}
        </>
      )}

      <Modal
        visible={editOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setEditOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setEditOpen(false)}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View style={{ maxHeight: '85%', overflow: 'hidden' }} lightColor="transparent" darkColor="transparent">
            <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 36 }} style={{ maxHeight: 600 }} showsVerticalScrollIndicator={false}>
            <View
              style={[
                styles.modalCard,
                colorScheme === 'dark'
                  ? { backgroundColor: '#111827' }
                  : { backgroundColor: '#ffffff' },
              ]}
            >
              <Text style={styles.modalTitle}>Editar transacción</Text>
              <Text
                style={styles.modalSub}
                lightColor="#6b7280"
                darkColor="#9ca3af"
              >
                {editTx?.merchant ?? 'Sin comercio'} ·{' '}
                {formatAmount(editTx?.total ?? null)}
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
                    onPress={() => setETipo(tipoOpcion)}
                    style={[chipInactivo, eTipo === tipoOpcion && styles.chipActivo]}
                  >
                    <Text
                      style={[
                        chipTextoInactivo,
                        eTipo === tipoOpcion ? styles.chipTextActivo : null,
                      ]}
                    >
                      {tipoOpcion === 'gasto' ? '⬇️ Gasto' : '⬆️ Ingreso'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TextInput
                style={inputStyle}
                value={eNombre}
                onChangeText={setENombre}
                placeholder="Comercio (ej: Panadería La Espiga)"
                placeholderTextColor={
                  colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                }
                autoCapitalize="sentences"
              />
              <TextInput
                style={inputStyle}
                value={eMonto}
                onChangeText={setEMonto}
                placeholder="Monto (ej: 12.990)"
                placeholderTextColor={
                  colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                }
                keyboardType={Platform.OS === 'web' ? 'default' : 'numeric'}
              />

              <SelectorFecha
                valor={eFecha}
                alCambiar={setEFecha}
                contenedorEstilo={inputBoxStyle}
                textoEstilo={[
                  { fontSize: 16, color: colorScheme === 'dark' ? '#f9fafb' : '#111827' },
                ]}
                accesibilidadLabel="Fecha de la transacción"
                bloquearFuturo
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
                    onPress={() => setECuentaId(cuenta.id)}
                    style={[chipInactivo, eCuentaId === cuenta.id && styles.chipActivo]}
                  >
                    <Text
                      style={[
                        chipTextoInactivo,
                        eCuentaId === cuenta.id ? styles.chipTextActivo : null,
                      ]}
                    >
                      {cuenta.nombre}
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
                    setECategoriaId(null);
                    setESubcatId(null);
                  }}
                  style={[chipInactivo, eCategoriaId === null && styles.chipActivo]}
                >
                  <Text
                    style={[
                      chipTextoInactivo,
                      eCategoriaId === null ? styles.chipTextActivo : null,
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
                      setECategoriaId(categoria.id);
                      setESubcatId(null);
                    }}
                    style={[
                      chipInactivo,
                      eCategoriaId === categoria.id && styles.chipActivo,
                    ]}
                  >
                    <Text
                      style={[
                        chipTextoInactivo,
                        eCategoriaId === categoria.id
                          ? styles.chipTextActivo
                          : null,
                      ]}
                    >
                      {categoria.nombre}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {eCategoriaId !== null && eSubcatOptions.length > 0 ? (
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
                      onPress={() => setESubcatId(null)}
                      style={[chipInactivo, eSubcatId === null && styles.chipActivo]}
                    >
                      <Text
                        style={[
                          chipTextoInactivo,
                          eSubcatId === null ? styles.chipTextActivo : null,
                        ]}
                      >
                        Ninguna
                      </Text>
                    </TouchableOpacity>
                    {eSubcatOptions.map((subcat) => (
                      <TouchableOpacity
                        key={subcat.id}
                        accessibilityRole="button"
                        onPress={() => setESubcatId(subcat.id)}
                        style={[
                          chipInactivo,
                          eSubcatId === subcat.id && styles.chipActivo,
                        ]}
                      >
                        <Text
                          style={[
                            chipTextoInactivo,
                            eSubcatId === subcat.id
                              ? styles.chipTextActivo
                              : null,
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
                          setETagIds((previo) => toggleTag(previo, etiqueta.id))
                        }
                        style={[
                          chipInactivo,
                          eTagIds.includes(etiqueta.id) && styles.chipActivo,
                        ]}
                      >
                        <Text
                          style={[
                            chipTextoInactivo,
                            eTagIds.includes(etiqueta.id)
                              ? styles.chipTextActivo
                              : null,
                          ]}
                        >
                          #{etiqueta.nombre}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </>
              ) : null}

              {itemEdits.length > 0 ? (
                <>
                  <Text style={styles.labelMini} lightColor="#6b7280" darkColor="#9ca3af">
                    Artículos de la transacción
                  </Text>
                  {itemEdits.map((item, idx) => (
                    <View
                      key={item.id}
                      style={itemCardStyle}
                    >
                      <TextInput
                        style={inputStyle}
                        value={item.producto}
                        onChangeText={(text) =>
                          setItemEdits((prev) =>
                            prev.map((it, i) =>
                              i === idx ? { ...it, producto: text } : it
                            )
                          )
                        }
                        placeholder="Nombre del artículo"
                        placeholderTextColor={
                          colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                        }
                      />
                      <TextInput
                        style={inputStyle}
                        value={item.precio}
                        onChangeText={(text) =>
                          setItemEdits((prev) =>
                            prev.map((it, i) =>
                              i === idx ? { ...it, precio: text } : it
                            )
                          )
                        }
                        placeholder="Precio (ej: 3.500)"
                        placeholderTextColor={
                          colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                        }
                        keyboardType={Platform.OS === 'web' ? 'default' : 'numeric'}
                      />
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.chipRow}
                        style={styles.chipScroll}
                      >
                        {categoriaOptions.map((cat) => (
                          <TouchableOpacity
                            key={cat.id}
                            accessibilityRole="button"
                            onPress={() =>
                              setItemEdits((prev) =>
                                prev.map((it, i) =>
                                  i === idx
                                    ? { ...it, categoriaId: cat.id, subcategoriaId: null }
                                    : it
                                )
                              )
                            }
                            style={[
                              chipInactivo,
                              item.categoriaId === cat.id && styles.chipActivo,
                            ]}
                          >
                            <Text
                              style={[
                                chipTextoInactivo,
                                item.categoriaId === cat.id
                                  ? styles.chipTextActivo
                                  : null,
                              ]}
                            >
                              {cat.nombre}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.chipRow}
                        style={styles.chipScroll}
                      >
                        {etiquetaOptions.map((tag) => (
                          <TouchableOpacity
                            key={tag.id}
                            accessibilityRole="button"
                            onPress={() =>
                              setItemEdits((prev) =>
                                prev.map((it, i) => {
                                  const ids = it.etiquetaIds ?? [];
                                  const newIds = ids.includes(tag.id)
                                    ? ids.filter((id) => id !== tag.id)
                                    : [...ids, tag.id];
                                  return i === idx
                                    ? { ...it, etiquetaIds: newIds }
                                    : it;
                                })
                              )
                            }
                            style={[
                              chipInactivo,
                              (item.etiquetaIds ?? []).includes(tag.id) &&
                                styles.chipActivo,
                            ]}
                          >
                            <Text
                              style={[
                                chipTextoInactivo,
                                (item.etiquetaIds ?? []).includes(tag.id)
                                  ? styles.chipTextActivo
                                  : null,
                              ]}
                            >
                              #{tag.nombre}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() =>
                          setItemEdits((prev) => prev.filter((_, i) => i !== idx))
                        }
                        style={eliminarItemStyle}
                      >
                        <Text style={eliminarItemTextStyle}>Eliminar artículo</Text>


                      </TouchableOpacity>
                    </View>
                  ))}
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() =>
                      setItemEdits((prev) => [
                        ...prev,
                        {
                          id: Date.now(),
                          producto: '',
                          precio: '',
                          categoriaId: null,
                          subcategoriaId: null,
                          etiquetaIds: [],
                        },
                      ])
                    }
                    style={styles.agregarItemButton}
                  >
                    <Text style={styles.agregarItemText}>＋ Agregar artículo</Text>
                  </TouchableOpacity>
                </>
              ) : null}

              {eSaving ? (
                <Text
                  style={styles.error}
                  lightColor="#b91c1c"
                  darkColor="#fca5a5"
                >
                  {eSaving}
                </Text>
              ) : null}

              <View
                style={styles.nameActions}
                lightColor="transparent"
                darkColor="transparent"
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => void guardarEdicion()}
                  disabled={eSaving !== ''}
                  style={styles.confirmButton}
                >
                  <Text style={styles.confirmText}>
                    {eSaving ? 'Guardando...' : 'Guardar'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => {
                    setEditOpen(false);
                    setESaving('');
                  }}
                  disabled={eSaving !== ''}
                  style={styles.cancelButton}
                >
                  <Text style={styles.cancelText}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </View>
            </ScrollView>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </ScrollView>
  );
}

function Detail({ label, value, fullWidth = false }: { label: string; value: string | null; fullWidth?: boolean }) {
  if (!value) return null;
  return (
    <View style={[styles.detail, fullWidth && { width: '100%', minWidth: '100%' }]} lightColor="transparent" darkColor="transparent">
      <Text style={styles.detailLabel} lightColor="#6b7280" darkColor="#9ca3af">
        {label}
      </Text>
      <Text style={styles.detailValue} lightColor="#111827" darkColor="#f9fafb">{value}</Text>
    </View>
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
    marginBottom: 24,
  },
  card: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  date: {
    fontSize: 13,
    marginBottom: 4,
  },
  merchant: {
    fontSize: 20,
    fontWeight: '600',
  },
  total: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'right',
  },
  separator: {
    height: 1,
    marginVertical: 16,
  },
  detailsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  detail: {
    minWidth: '42%',
    flexGrow: 1,
  },
  detailLabel: {
    fontSize: 12,
    marginBottom: 3,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 18,
    marginBottom: 8,
  },
  itemContainer: {
    paddingVertical: 6,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  itemName: {
    flex: 1,
    fontSize: 14,
  },
  itemMetadata: {
    fontSize: 12,
    marginTop: 4,
  },
  itemPrice: {
    fontSize: 14,
    fontWeight: '500',
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  tag: {
    overflow: 'hidden',
    borderRadius: 12,
    paddingVertical: 5,
    paddingHorizontal: 9,
    backgroundColor: '#e0e7ff',
    fontSize: 12,
    fontWeight: '600',
  },
  messageCard: {
    alignItems: 'center',
    borderRadius: 16,
    padding: 24,
    gap: 12,
  },
  message: {
    fontSize: 15,
    textAlign: 'center',
  },
  error: {
    fontSize: 15,
    textAlign: 'center',
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  retryButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  retryText: {
    color: '#4f46e5',
    fontWeight: '600',
  },
  editButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#e0e7ff',
  },
  itemEditCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  miniBotonEliminar: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginTop: 6,
  },
  miniBotonEliminarText: {
    fontWeight: '600',
    fontSize: 12,
  },
  agregarItemButton: {
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#e0e7ff',
    marginTop: 4,
  },
  agregarItemText: {
    color: '#4338ca',
    fontWeight: '600',
  },
  editButtonText: {
    color: '#4338ca',
    fontWeight: '600',
    fontSize: 12,
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
  toggleContainer: {
    flexDirection: 'row',
    marginBottom: 16,
    backgroundColor: '#374151',
    borderRadius: 8,
    padding: 4,
  },
  toggleButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  toggleButtonActive: {
    backgroundColor: '#4f46e5',
  },
  toggleText: {
    color: '#9ca3af',
  },
  toggleTextActive: {
    color: '#ffffff',
    fontWeight: '600',
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
});
