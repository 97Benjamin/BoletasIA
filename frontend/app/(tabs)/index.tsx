import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import type { TextStyle } from 'react-native';
import type { User } from '@supabase/supabase-js';
import type { ImagePickerAsset } from 'expo-image-picker';
import * as ImagePicker from 'expo-image-picker';
import { Link, Redirect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { useThemeMode } from '@/components/ThemeMode';
import { supabase } from '@/src/services/supabase';
import { notificarCambio, usePulsoDatos } from '@/src/utils/cambios';
import { confirmar } from '@/src/utils/confirmar';
import { formatChileanPesos } from '@/src/utils/currency';
import { formatearMontoEnEntrada, limpiarMontoParaEstado } from '@/src/utils/moneda-formato';
import { iconoNormalizado, textoEtiqueta } from '@/src/utils/etiqueta';

type AccountRow = {
  id: string;
  nombre: string | null;
  tipo: string | null;
  banco: string | null;
  saldoActual: number | null;
  // Solo tarjetas de crédito: cupo total y días del ciclo de facturación.
  // Para crédito, saldoActual = cupo disponible (deuda = cupo - saldoActual).
  cupo: number | null;
  diaCorte: number | null;
  diaPago: number | null;
};

// Debe coincidir con el CHECK cuentas_tipo_check de la base de datos
const TIPOS_CUENTA = ['efectivo', 'debito', 'credito'] as const;
type TipoCuenta = (typeof TIPOS_CUENTA)[number];

// ---- Presupuestos ----
type CatalogoItem = { id: number; nombre: string; icono?: string | null };
type SubcategoriaItem = CatalogoItem & { categoriaId: number };
type ReglaTipo = 'categoria' | 'subcategoria' | 'etiqueta';
type PresupuestoRegla = {
  id: number;
  presupuestoId: number;
  tipo: ReglaTipo;
  refId: number;
};
type TrxMes = {
  id: number;
  fecha: string; // YYYY-MM-DD
  total: number;
  categoriaId: number | null;
  subcategoriaId: number | null;
  etiquetaIds: number[];
  comercioNombre: string | null;
  cuentaId: number | null;
};
type PresupuestoDetalle = {
  id: number;
  nombre: string;
  montoMensual: number;
  reglas: PresupuestoRegla[];
  gastado: number;
  transacciones: TrxMes[];
};

// ---- Editor de catálogo (Mi cuenta) ----
// Categorías compartidas (user_id NULL) son de solo lectura por RLS.
type CategoriaEditorItem = { id: number; nombre: string; global: boolean };
type SubcategoriaEditorItem = {
  id: number;
  nombre: string;
  categoriaId: number;
  editable: boolean;
};
type EtiquetaEditorItem = { id: number; nombre: string; icono: string | null };
type CatalogoTab = 'etiquetas' | 'categorias' | 'subcategorias';

// Etiquetas que todo usuario nuevo debe tener (se crean al cargar el tab si
// faltan; nada se crea sin "Guardar" — no son presupuestos por sí mismas).
const ETIQUETAS_DEFAULT = [
  { nombre: 'Gasto hormiga', icono: '🐜' },
  { nombre: 'Gastos básicos', icono: '🏠' },
];

// Opciones fijas del selector de iconos del editor de etiquetas.
// La primera (cadena vacía) significa "sin icono" (se muestra con #).
const ICONOS_ETIQUETA = [
  '',
  '🐜',
  '🏠',
  '🚗',
  '🍽️',
  '💊',
  '🎮',
  '🛒',
  '✈️',
  '🐶',
  '☕',
  '📚',
  '💼',
  '🎓',
  '🩺',
  '🧾',
  '🎁',
  '⚽',
  '💻',
];

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

// Mes calendario corriente según el reloj del dispositivo (fechas ISO).
function rangoMesActual() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth();
  return {
    inicio: `${anio}-${pad2(mes + 1)}-01`,
    fin: `${anio}-${pad2(mes + 1)}-${pad2(
      new Date(anio, mes + 1, 0).getDate()
    )}`,
  };
}

// 2026-10-24 -> 24-10-2026 (mostrar; en la BD queda ISO)
function fechaChilena(iso: string) {
  const partes = iso.split('-');
  const [y, m, d] = partes;
  if (!y || !m || !d) return iso;
  return `${d}-${m}-${y}`;
}

// Igual que el parseador de ingresos-gastos.tsx: punto = miles, coma = decimales.
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

function trxCumpleReglas(trx: TrxMes, reglas: PresupuestoRegla[]) {
  return reglas.some((regla) => {
    if (regla.tipo === 'categoria') {
      return trx.categoriaId === regla.refId;
    }
    if (regla.tipo === 'subcategoria') {
      return trx.subcategoriaId === regla.refId;
    }
    return trx.etiquetaIds.includes(regla.refId);
  });
}

// En nativo se leen los bytes de la imagen con expo-file-system (lazy para
// que el módulo nativo no se cargue en web). En web se usa el Blob del picker.
function readImageBody(asset: ImagePickerAsset): Promise<Blob | ArrayBuffer> {
  if (Platform.OS === 'web') {
    if (!asset.file) {
      return Promise.reject(
        new Error('No se pudo leer la imagen seleccionada.')
      );
    }
    return Promise.resolve(asset.file);
  }
  const { File } = require('expo-file-system') as typeof import(
    'expo-file-system'
  );
  return new File(asset.uri).arrayBuffer();
}

export default function AccountScreen() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');
  const [accountsReload, setAccountsReload] = useState(0);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [profileError, setProfileError] = useState('');
  const [editingProfile, setEditingProfile] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [avatarUriOverride, setAvatarUriOverride] = useState<string | null>(
    null
  );
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBanco, setNewBanco] = useState('');
  const [newTipo, setNewTipo] = useState<TipoCuenta>('debito');
  // Solo para tipo='credito': cupo total y ciclo de facturación.
  const [newCupo, setNewCupo] = useState('');
  const [newDiaCorte, setNewDiaCorte] = useState('');
  const [newDiaPago, setNewDiaPago] = useState('');
  const [accountSaving, setAccountSaving] = useState(false);
  const authEventReceived = useRef(false);
  const { colorScheme, toggleColorScheme, storageError } = useThemeMode();
  // Pulso global: sube cuando otra pantalla guarda un gasto/cambia el catálogo
  // y cuando este tab recupera el foco; re-carga cuentas y presupuestos.
  const pulsoDatos = usePulsoDatos();

  // ---- Presupuestos ----
  const [presupuestos, setPresupuestos] = useState<PresupuestoDetalle[]>([]);
  const [presupuestosLoading, setPresupuestosLoading] = useState(false);
  const [presupuestosError, setPresupuestosError] = useState('');
  const [presupuestosReload, setPresupuestosReload] = useState(0);
  const [catOptions, setCatOptions] = useState<CatalogoItem[]>([]);
  const [subOptions, setSubOptions] = useState<SubcategoriaItem[]>([]);
  const [etiquetaOptions, setEtiquetaOptions] = useState<CatalogoItem[]>([]);
  const [comerciosNombres, setComerciosNombres] = useState<
    Record<number, string>
  >({});
  const [presModalAbierto, setPresModalAbierto] = useState(false);
  const [presEditandoId, setPresEditandoId] = useState<number | null>(null);
  const [presNombre, setPresNombre] = useState('');
  const [presMonto, setPresMonto] = useState('');
  const [presCats, setPresCats] = useState<number[]>([]);
  const [presSubs, setPresSubs] = useState<number[]>([]);
  const [presTags, setPresTags] = useState<number[]>([]);
  const [presSaving, setPresSaving] = useState(false);
  const [presFormError, setPresFormError] = useState('');
  const [presDetalleId, setPresDetalleId] = useState<number | null>(null);

  // ---- Catálogo: editor (Mi cuenta) ----
  const [catEditorAbierto, setCatEditorAbierto] = useState(false);
  const [catEditorTab, setCatEditorTab] = useState<CatalogoTab>('etiquetas');
  const [catEditorLoading, setCatEditorLoading] = useState(false);
  const [catEditorError, setCatEditorError] = useState('');
  const [editorEtiquetas, setEditorEtiquetas] = useState<EtiquetaEditorItem[]>(
    []
  );
  const [editorCategorias, setEditorCategorias] = useState<
    CategoriaEditorItem[]
  >([]);
  const [editorSubcats, setEditorSubcats] = useState<SubcategoriaEditorItem[]>(
    []
  );
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorEditKey, setEditorEditKey] = useState<string | null>(null);
  const [editorNombreDraft, setEditorNombreDraft] = useState('');
  const [editorIconoDraft, setEditorIconoDraft] = useState('');
  const [editorNuevoNombre, setEditorNuevoNombre] = useState('');
  const [editorNuevoIcono, setEditorNuevoIcono] = useState('');
  const [editorSubPadre, setEditorSubPadre] = useState<number | null>(null);

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
      .then(({ data: { user: currentUser }, error }) => {
        if (!isMounted || authEventReceived.current) return;
        if (error) {
          setAuthError(`No se pudo cargar la sesión: ${error.message}`);
        } else {
          setUser(currentUser);
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!isMounted || authEventReceived.current) return;
        setAuthError(
          `No se pudo cargar la sesión: ${
            error instanceof Error ? error.message : 'Error desconocido'
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
      setProfileName(null);
      setProfileError('');
      return;
    }

    let isMounted = true;
    setProfileName(null);
    setProfileError('');

    async function loadProfile() {
      const { data, error } = await supabase
        .from('perfiles')
        .select('nombre')
        .eq('id', userId)
        .maybeSingle();

      if (!isMounted) return;
      if (error) {
        setProfileError(
          `No se pudo cargar el nombre del perfil: ${error.message}`
        );
        return;
      }

      setProfileName(
        typeof data?.nombre === 'string' && data.nombre.trim()
          ? data.nombre.trim()
          : null
      );
    }

    void loadProfile().catch((error: unknown) => {
      if (isMounted) {
        setProfileError(
          `No se pudo cargar el nombre del perfil: ${
            error instanceof Error ? error.message : 'Error desconocido'
          }`
        );
      }
    });

    return () => {
      isMounted = false;
    };
  }, [user?.id]);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setAccounts([]);
      setAccountsLoading(false);
      return;
    }

    let isMounted = true;
    setAccounts([]);
    setAccountsError('');
    setAccountsLoading(true);

    async function loadAccounts() {
      try {
        const { data, error } = await supabase
          .from('cuentas')
          .select('id, nombre, tipo, banco, saldo_actual, cupo, dia_corte, dia_pago')
          .eq('user_id', userId);

        if (error) {
          throw error;
        }

        if (isMounted) {
          setAccounts(
            (data ?? []).flatMap((account): AccountRow[] => {
              const id = account.id;
              if (typeof id !== 'string' && typeof id !== 'number') {
                return [];
              }
              const leerNumero = (valor: unknown): number | null =>
                typeof valor === 'number'
                  ? valor
                  : typeof valor === 'string' &&
                      valor.trim() !== '' &&
                      Number.isFinite(Number(valor))
                    ? Number(valor)
                    : null;
              return [
                {
                  id: String(id),
                  nombre:
                    typeof account.nombre === 'string' ? account.nombre : null,
                  tipo: typeof account.tipo === 'string' ? account.tipo : null,
                  banco:
                    typeof account.banco === 'string' ? account.banco : null,
                  saldoActual: leerNumero(account.saldo_actual),
                  cupo: leerNumero(account.cupo),
                  diaCorte: leerNumero(account.dia_corte),
                  diaPago: leerNumero(account.dia_pago),
                },
              ];
            })
          );
        }
      } catch (error: unknown) {
        if (isMounted) {
          setAccountsError(
            `No se pudo cargar las cuentas: ${
              error instanceof Error ? error.message : 'Error desconocido'
            }`
          );
        }
      } finally {
        if (isMounted) {
          setAccountsLoading(false);
        }
      }
    }

    void loadAccounts();
    return () => {
      isMounted = false;
    };
  }, [user, accountsReload, pulsoDatos]);

  // ---- Presupuestos: ensure de etiquetas + carga + cálculo del mes ----
  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setPresupuestos([]);
      setPresupuestosLoading(false);
      return;
    }

    let isMounted = true;
    setPresupuestos([]);
    setPresupuestosError('');
    setPresupuestosLoading(true);

    // Ningún usuario trae presupuestos de fábrica; solo se garantizan sus
    // etiquetas "Gasto hormiga" y "Gastos básicos" (idempotente).
    async function asegurarEtiquetasDefault() {
      const { data, error } = await supabase
        .from('etiquetas')
        .select('nombre')
        .or(`user_id.is.null,user_id.eq.${userId}`);
      if (error) throw error;
      const nombres = (data ?? [])
        .map((row) =>
          typeof row?.nombre === 'string'
            ? row.nombre.trim().toLowerCase()
            : ''
        )
        .filter(Boolean);
      const faltantes = ETIQUETAS_DEFAULT.filter(
        (etiqueta) => !nombres.includes(etiqueta.nombre.toLowerCase())
      );
      if (faltantes.length === 0) return;
      const { error: insertError } = await supabase
        .from('etiquetas')
        .insert(
          faltantes.map((etiqueta) => ({
            user_id: userId,
            nombre: etiqueta.nombre,
            icono: etiqueta.icono,
          }))
        );
      // UNIQUE (user_id, nombre): si otra carga concurrente ya las creó,
      // el 23505 "duplicate key" se considera éxito idempotente.
      if (insertError && insertError.code !== '23505') {
        throw insertError;
      }
    }

    async function cargarPresupuestos() {
      await asegurarEtiquetasDefault();

      const rango = rangoMesActual();
      const [presResult, catResult, subResult, tagResult, trxResult] =
        await Promise.all([
          supabase
            .from('presupuestos')
            .select('id, nombre, monto_mensual')
            .order('creado_en'),
          supabase
            .from('categorias')
            .select('id, nombre')
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order('nombre'),
          supabase
            .from('subcategorias')
            // subcategorias no tiene user_id: pertenece a su categoría
            .select('id, nombre, categoria_id')
            .order('nombre'),
          supabase
            .from('etiquetas')
            .select('id, nombre, icono')
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order('nombre'),
          supabase
            .from('transacciones')
            .select(
              'id, fecha, total, categoria_id, subcategoria_id, cuenta_id, comercio_id'
            )
            .eq('user_id', userId)
            .eq('tipo', 'gasto')
            .gte('fecha', rango.inicio)
            .lte('fecha', rango.fin)
            .order('fecha', { ascending: false })
            .order('creado_en', { ascending: false }),
        ]);
      if (!isMounted) return;
      for (const result of [
        presResult,
        catResult,
        subResult,
        tagResult,
        trxResult,
      ]) {
        if (result.error) throw new Error(result.error.message);
      }

      const catOptionsCargadas = (catResult.data ?? []).flatMap(
        (row): CatalogoItem[] =>
          typeof row?.id === 'number' && typeof row?.nombre === 'string'
            ? [{ id: row.id, nombre: row.nombre }]
            : []
      );
      const subOptionsCargadas = (subResult.data ?? []).flatMap(
        (row): SubcategoriaItem[] =>
          typeof row?.id === 'number' &&
          typeof row?.nombre === 'string' &&
          typeof row?.categoria_id === 'number'
            ? [
                {
                  id: row.id,
                  nombre: row.nombre,
                  categoriaId: row.categoria_id,
                },
              ]
            : []
      );
      const etiquetasCargadas = (tagResult.data ?? []).flatMap(
        (row): CatalogoItem[] =>
          typeof row?.id === 'number' && typeof row?.nombre === 'string'
            ? [
                {
                  id: row.id,
                  nombre: row.nombre,
                  ...(iconoNormalizado(row?.icono) !== null
                    ? { icono: iconoNormalizado(row?.icono) as string }
                    : {}),
                },
              ]
            : []
      );

      // Gastos del mes (total llega como string desde PostgREST si es numeric)
      const transTemp = (trxResult.data ?? []).flatMap((row) => {
        const id = typeof row?.id === 'number' ? row.id : null;
        const fecha = typeof row?.fecha === 'string' ? row.fecha : null;
        const total =
          typeof row?.total === 'number'
            ? row.total
            : typeof row?.total === 'string' &&
                Number.isFinite(Number(row.total))
              ? Number(row.total)
              : null;
        if (id === null || !fecha || total === null) return [];
        return [
          {
            id,
            fecha,
            total,
            categoriaId:
              typeof row.categoria_id === 'number' ? row.categoria_id : null,
            subcategoriaId:
              typeof row.subcategoria_id === 'number'
                ? row.subcategoria_id
                : null,
            cuentaId: typeof row.cuenta_id === 'number' ? row.cuenta_id : null,
            comercioId:
              typeof row.comercio_id === 'number' ? row.comercio_id : null,
          },
        ];
      });

      const presupuestoRows = (presResult.data ?? []).flatMap((row) => {
        const id = typeof row?.id === 'number' ? row.id : null;
        const nombre = typeof row?.nombre === 'string' ? row.nombre : null;
        const monto =
          typeof row?.monto_mensual === 'number'
            ? row.monto_mensual
            : typeof row?.monto_mensual === 'string' &&
                Number.isFinite(Number(row.monto_mensual))
              ? Number(row.monto_mensual)
              : null;
        if (id === null || !nombre || monto === null) return [];
        return [{ id, nombre, monto }];
      });

      const presupuestoIds = presupuestoRows.map((p) => p.id);
      const reglasResult = presupuestoIds.length
        ? await supabase
            .from('presupuesto_reglas')
            .select('id, presupuesto_id, tipo, ref_id')
            .in('presupuesto_id', presupuestoIds)
        : { data: [], error: null };
      const trxIds = transTemp.map((trx) => trx.id);
      const trxTagResult = trxIds.length
        ? await supabase
            .from('transaccion_etiquetas')
            .select('transaccion_id, etiqueta_id')
            .in('transaccion_id', trxIds)
        : { data: [], error: null };
      const comercioIds = [
        ...new Set(
          transTemp
            .map((trx) => trx.comercioId)
            .filter((id): id is number => id !== null)
        ),
      ];
      const comerciosResult = comercioIds.length
        ? await supabase
            .from('comercios')
            .select('id, nombre')
            .in('id', comercioIds)
        : { data: [], error: null };
      if (!isMounted) return;
      for (const result of [reglasResult, trxTagResult, comerciosResult]) {
        if (result.error) throw new Error(result.error.message);
      }

      const etiquetasPorTrx = new Map<number, number[]>();
      for (const row of trxTagResult.data ?? []) {
        if (
          typeof row?.transaccion_id === 'number' &&
          typeof row?.etiqueta_id === 'number'
        ) {
          const lista = etiquetasPorTrx.get(row.transaccion_id) ?? [];
          lista.push(row.etiqueta_id);
          etiquetasPorTrx.set(row.transaccion_id, lista);
        }
      }
      const comerciosMap: Record<number, string> = {};
      for (const row of comerciosResult.data ?? []) {
        if (typeof row?.id === 'number' && typeof row?.nombre === 'string') {
          comerciosMap[row.id] = row.nombre;
        }
      }
      const transacciones: TrxMes[] = transTemp.map((trx) => ({
        id: trx.id,
        fecha: trx.fecha,
        total: trx.total,
        categoriaId: trx.categoriaId,
        subcategoriaId: trx.subcategoriaId,
        etiquetaIds: etiquetasPorTrx.get(trx.id) ?? [],
        comercioNombre:
          trx.comercioId !== null ? comerciosMap[trx.comercioId] ?? null : null,
        cuentaId: trx.cuentaId,
      }));

      const reglasPorPresupuesto = new Map<number, PresupuestoRegla[]>();
      for (const row of reglasResult.data ?? []) {
        if (
          typeof row?.id === 'number' &&
          typeof row?.presupuesto_id === 'number' &&
          (row?.tipo === 'categoria' ||
            row?.tipo === 'subcategoria' ||
            row?.tipo === 'etiqueta') &&
          typeof row?.ref_id === 'number'
        ) {
          const lista = reglasPorPresupuesto.get(row.presupuesto_id) ?? [];
          lista.push({
            id: row.id,
            presupuestoId: row.presupuesto_id,
            tipo: row.tipo,
            refId: row.ref_id,
          });
          reglasPorPresupuesto.set(row.presupuesto_id, lista);
        }
      }

      const detalle: PresupuestoDetalle[] = presupuestoRows.map((pres) => {
        const reglas = reglasPorPresupuesto.get(pres.id) ?? [];
        const propias = transacciones.filter((trx) =>
          trxCumpleReglas(trx, reglas)
        );
        return {
          id: pres.id,
          nombre: pres.nombre,
          montoMensual: pres.monto,
          reglas,
          gastado: propias.reduce((suma, trx) => suma + trx.total, 0),
          transacciones: propias,
        };
      });

      if (isMounted) {
        setPresupuestos(detalle);
        setCatOptions(catOptionsCargadas);
        setSubOptions(subOptionsCargadas);
        setEtiquetaOptions(etiquetasCargadas);
        setComerciosNombres(comerciosMap);
        setPresupuestosLoading(false);
      }
    }

    void cargarPresupuestos().catch((error: unknown) => {
      console.warn('[presupuestos] error de carga:', error);
      if (isMounted) {
        setPresupuestosLoading(false);
        setPresupuestosError(
          `No se pudo cargar los presupuestos: ${
            error instanceof Error ? error.message : 'Error desconocido'
          }`
        );
      }
    });

    return () => {
      isMounted = false;
    };
  }, [user, presupuestosReload, pulsoDatos]);

  // ---- Presupuestos: handlers del formulario y detalle ----
  function abrirPresupuestoNuevo() {
    setPresFormError('');
    setPresEditandoId(null);
    setPresNombre('');
    setPresMonto('');
    setPresCats([]);
    setPresSubs([]);
    setPresTags([]);
    setPresModalAbierto(true);
  }

  function abrirPresupuestoEdicion(pres: PresupuestoDetalle) {
    setPresFormError('');
    setPresEditandoId(pres.id);
    setPresNombre(pres.nombre);
    setPresMonto(String(pres.montoMensual));
    setPresCats(
      pres.reglas
        .filter((regla) => regla.tipo === 'categoria')
        .map((regla) => regla.refId)
    );
    setPresSubs(
      pres.reglas
        .filter((regla) => regla.tipo === 'subcategoria')
        .map((regla) => regla.refId)
    );
    setPresTags(
      pres.reglas
        .filter((regla) => regla.tipo === 'etiqueta')
        .map((regla) => regla.refId)
    );
    setPresDetalleId(null);
    setPresModalAbierto(true);
  }

  // Presets: SOLO prellenan el formulario. Nada se crea sin "Guardar".
  function aplicarPresetGastosBasicos() {
    setPresNombre('Gastos básicos');
    const nombres = ['Alimentos', 'Transporte', 'Servicios y Hogar'];
    setPresCats(
      catOptions
        .filter((cat) => nombres.includes(cat.nombre))
        .map((cat) => cat.id)
    );
    setPresSubs([]);
    setPresTags([]);
    setPresMonto(''); // sin montos inventados: los escribe el usuario
  }

  function aplicarPresetGastoHormiga() {
    setPresNombre('Gasto hormiga');
    setPresTags(
      etiquetaOptions
        .filter(
          (etiqueta) =>
            etiqueta.nombre.trim().toLowerCase() === 'gasto hormiga'
        )
        .map((etiqueta) => etiqueta.id)
    );
    setPresCats([]);
    setPresSubs([]);
    setPresMonto('');
  }

  function toggleEn(lista: number[], id: number) {
    return lista.includes(id)
      ? lista.filter((item) => item !== id)
      : [...lista, id];
  }

  async function guardarPresupuesto() {
    if (!user || presSaving) return;
    const nombre = titleCase(presNombre);
    const monto = inputAmount(limpiarMontoParaEstado(presMonto));
    if (!nombre) {
      setPresFormError('Escribe un nombre para el presupuesto.');
      return;
    }
    if (monto === null) {
      setPresFormError('Escribe un monto mensual válido (ej: 45.000).');
      return;
    }
    const reglas: { tipo: ReglaTipo; ref_id: number }[] = [
      ...presCats.map((ref_id) => ({ tipo: 'categoria' as const, ref_id })),
      ...presSubs.map((ref_id) => ({ tipo: 'subcategoria' as const, ref_id })),
      ...presTags.map((ref_id) => ({ tipo: 'etiqueta' as const, ref_id })),
    ];
    if (reglas.length === 0) {
      setPresFormError(
        'Elige al menos una categoría, subcategoría o etiqueta.'
      );
      return;
    }

    setPresSaving(true);
    setPresFormError('');
    try {
      if (presEditandoId !== null) {
        const { error: updateError } = await supabase
          .from('presupuestos')
          .update({ nombre, monto_mensual: monto })
          .eq('id', presEditandoId)
          .eq('user_id', user.id);
        if (updateError) throw updateError;
        const { error: deleteReglasError } = await supabase
          .from('presupuesto_reglas')
          .delete()
          .eq('presupuesto_id', presEditandoId);
        if (deleteReglasError) throw deleteReglasError;
        const { error: insertReglasError } = await supabase
          .from('presupuesto_reglas')
          .insert(
            reglas.map((regla) => ({
              presupuesto_id: presEditandoId,
              tipo: regla.tipo,
              ref_id: regla.ref_id,
            }))
          );
        if (insertReglasError) throw insertReglasError;
      } else {
        const { data: creados, error: insertError } = await supabase
          .from('presupuestos')
          .insert({ user_id: user.id, nombre, monto_mensual: monto })
          .select('id');
        if (insertError) throw insertError;
        const nuevoId = (creados ?? [])[0]?.id;
        if (typeof nuevoId !== 'number') {
          throw new Error(
            'No se pudo obtener el presupuesto recién creado.'
          );
        }
        const { error: insertReglasError } = await supabase
          .from('presupuesto_reglas')
          .insert(
            reglas.map((regla) => ({
              presupuesto_id: nuevoId,
              tipo: regla.tipo,
              ref_id: regla.ref_id,
            }))
          );
        if (insertReglasError) throw insertReglasError;
      }
      setPresModalAbierto(false);
      // Las tarjetas cargan de nuevo con el pulso; two/ingresos no muestran
      // presupuestos, pero la señal mantiene todo sincronizado.
      notificarCambio();
    } catch (saveError: unknown) {
      setPresFormError(
        `No se pudo guardar el presupuesto: ${
          saveError instanceof Error ? saveError.message : 'Error desconocido'
        }`
      );
    } finally {
      setPresSaving(false);
    }
  }

  function confirmarEliminarPresupuesto(pres: PresupuestoDetalle) {
    confirmar(
      'Eliminar presupuesto',
      `¿Eliminar el presupuesto "${pres.nombre}"? Tus transacciones no se tocan: solo deja de seguirse.`,
      () => {
        void (async () => {
          if (!user) return;
          const { error } = await supabase
            .from('presupuestos')
            .delete()
            .eq('id', pres.id)
            .eq('user_id', user.id);
          if (error) {
            setPresupuestosError(
              `No se pudo eliminar el presupuesto: ${error.message}`
            );
            return;
          }
          setPresDetalleId(null);
          notificarCambio();
        })();
      }
    );
  }

  async function handleSignOut() {
    setAuthError('');
    setSigningOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        setAuthError(`No se pudo cerrar sesión: ${error.message}`);
      }
    } catch (error: unknown) {
      setAuthError(
        `No se pudo cerrar sesión: ${
          error instanceof Error ? error.message : 'Error desconocido'
        }`
      );
    } finally {
      setSigningOut(false);
    }
  }

  function openEditProfile() {
    setNameDraft(name);
    setProfileError('');
    setEditingProfile(true);
  }

  async function handleSaveName() {
    if (!user) return;
    const value = nameDraft.trim();
    if (!value) {
      setProfileError('El nombre no puede quedar vacío.');
      return;
    }
    setNameSaving(true);
    setProfileError('');
    try {
      const { error: perfilesError } = await supabase
        .from('perfiles')
        .update({ nombre: value })
        .eq('id', user.id);
      const { data, error: authError } = await supabase.auth.updateUser({
        data: { nombre: value, full_name: value },
      });
      if (authError) {
        setProfileError(`No se pudo guardar el nombre: ${authError.message}`);
        return;
      }
      if (data?.user) {
        setUser(data.user);
      }
      if (perfilesError) {
        setProfileError(
          `El nombre quedó guardado en tu sesión, pero no se pudo actualizar la tabla perfiles: ${perfilesError.message} Ejecuta el SQL de supabase/migrations/20261020000000_perfil_cuentas_avatares.sql en el editor SQL de Supabase.`
        );
        return;
      }
      setProfileName(value);
      setEditingProfile(false);
    } catch (saveError: unknown) {
      setProfileError(
        `No se pudo guardar el nombre: ${
          saveError instanceof Error ? saveError.message : 'Error desconocido'
        }`
      );
    } finally {
      setNameSaving(false);
    }
  }

  async function changeAvatar(mode: 'gallery' | 'camera') {
    if (!user || avatarUploading) return;
    setProfileError('');
    try {
      const permission =
        mode === 'gallery'
          ? await ImagePicker.requestMediaLibraryPermissionsAsync()
          : await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setProfileError(
          'Debes permitir el acceso a tus fotos o cámara para cambiar la foto de perfil.'
        );
        return;
      }
      const pickerResult =
        mode === 'gallery'
          ? await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              allowsEditing: true,
              quality: 0.7,
            })
          : await ImagePicker.launchCameraAsync({
              mediaTypes: ['images'],
              allowsEditing: true,
              quality: 0.7,
            });
      if (pickerResult.canceled) return;
      const asset = pickerResult.assets[0];
      if (!asset) return;

      setAvatarUploading(true);
      const mimeType = asset.mimeType ?? 'image/jpeg';
      const extension =
        mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
      const path = `${user.id}/avatar.${extension}`;
      const body = await readImageBody(asset);
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, body, { upsert: true, contentType: mimeType });
      if (uploadError) {
        if (uploadError.message.includes('Bucket not found')) {
          throw new Error(
            'El bucket "avatars" no existe todavía: ejecuta el SQL de supabase/migrations/20261020000000_perfil_cuentas_avatares.sql en el editor SQL de Supabase e inténtalo de nuevo.'
          );
        }
        throw new Error(uploadError.message);
      }
      const { data: publicData } = supabase.storage
        .from('avatars')
        .getPublicUrl(path);
      const publicUrl = publicData?.publicUrl;
      if (!publicUrl) {
        throw new Error('No se pudo obtener la URL de la foto de perfil.');
      }
      const { data, error: authError } = await supabase.auth.updateUser({
        data: { avatar_url: publicUrl },
      });
      if (authError) {
        throw new Error(
          `No se pudo actualizar el perfil con la nueva foto: ${authError.message}`
        );
      }
      if (data?.user) {
        setUser(data.user);
      }
      setAvatarUriOverride(`${publicUrl}?v=${Date.now()}`);
    } catch (avatarError: unknown) {
      setProfileError(
        `No se pudo subir la foto de perfil: ${
          avatarError instanceof Error ? avatarError.message : 'Error desconocido'
        }`
      );
    } finally {
      setAvatarUploading(false);
    }
  }

  function confirmRemoveAccount(account: AccountRow) {
    const esCredito = account.tipo === 'credito';
    const deuda =
      esCredito &&
      account.cupo !== null &&
      account.saldoActual !== null
        ? Math.max(account.cupo - account.saldoActual, 0)
        : null;
    const detalleDeuda =
      deuda !== null && deuda > 0
        ? ` La tarjeta tiene una deuda registrada de ${formatChileanPesos(
            deuda
          )}; si la eliminas, esa deuda dejará de verse en la app.`
        : '';
    confirmar(
      esCredito ? 'Eliminar tarjeta de crédito' : 'Eliminar cuenta',
      `¿Eliminar la ${
        esCredito ? 'tarjeta' : 'cuenta'
      } "${account.nombre ?? 'sin nombre'}"?${detalleDeuda} Esta acción no se puede deshacer.`,
      () => void handleRemoveAccount(account)
    );
  }

  async function handleRemoveAccount(account: AccountRow) {
    if (!user) return;
    setAccountsError('');
    try {
      const { error } = await supabase
        .from('cuentas')
        .delete()
        .eq('id', account.id)
        .eq('user_id', user.id);
      if (error) {
        setAccountsError(
          error.message.includes('foreign key')
            ? 'No se puede eliminar una cuenta con transacciones registradas.'
            : `No se pudo eliminar la cuenta: ${error.message}`
        );
        return;
      }
      // Cuentas cambian los selects de scan e ingresos-rápidos: avisar a todos.
      notificarCambio();
    } catch (removeError: unknown) {
      setAccountsError(
        `No se pudo eliminar la cuenta: ${
          removeError instanceof Error ? removeError.message : 'Error desconocido'
        }`
      );
    }
  }

  async function handleAddAccount() {
    if (!user) return;
    const nombre = newName.trim();
    if (!nombre) {
      setAccountsError('Escribe un nombre para la cuenta.');
      return;
    }
    if (!TIPOS_CUENTA.includes(newTipo)) {
      setAccountsError('Elige un tipo de cuenta válido.');
      return;
    }

    // Tarjeta de crédito: el cupo es obligatorio y saldo_actual guarda el
    // cupo disponible (deuda = cupo - saldo_actual).
    let cupo: number | null = null;
    let diaCorte: number | null = null;
    let diaPago: number | null = null;
    if (newTipo === 'credito') {
      cupo = inputAmount(limpiarMontoParaEstado(newCupo));
      if (cupo === null) {
        setAccountsError('Escribe el cupo de la tarjeta (mayor que cero).');
        return;
      }
      const leerDia = (valor: string, etiqueta: string): number | null | 'error' => {
        const limpio = valor.trim();
        if (!limpio) return null;
        const dia = Number(limpio);
        if (!Number.isInteger(dia) || dia < 1 || dia > 28) {
          setAccountsError(`${etiqueta} debe ser un día entre 1 y 28.`);
          return 'error';
        }
        return dia;
      };
      const corte = leerDia(newDiaCorte, 'El día de corte');
      if (corte === 'error') return;
      const pago = leerDia(newDiaPago, 'El día de pago');
      if (pago === 'error') return;
      diaCorte = corte;
      diaPago = pago;
    }

    setAccountSaving(true);
    setAccountsError('');
    try {
      const { error } = await supabase.from('cuentas').insert({
        user_id: user.id,
        nombre,
        tipo: newTipo,
        banco: newBanco.trim() ? newBanco.trim() : null,
        ...(newTipo === 'credito'
          ? { saldo_actual: cupo, cupo, dia_corte: diaCorte, dia_pago: diaPago }
          : {}),
      });
      if (error) {
        setAccountsError(
          error.message.includes('row-level security')
            ? `No se pudo crear la cuenta (permisos): ${error.message} Ejecuta el SQL de supabase/migrations/20261020000000_perfil_cuentas_avatares.sql en el editor SQL de Supabase.`
            : error.message.includes('foreign key')
              ? `Datos de la cuenta inválidos: ${error.message}`
              : `No se pudo crear la cuenta: ${error.message}`
        );
        return;
      }
      setNewName('');
      setNewBanco('');
      setNewTipo('debito');
      setNewCupo('');
      setNewDiaCorte('');
      setNewDiaPago('');
      setAddingAccount(false);
      notificarCambio();
    } catch (addError: unknown) {
      setAccountsError(
        `No se pudo crear la cuenta: ${
          addError instanceof Error ? addError.message : 'Error desconocido'
        }`
      );
    } finally {
      setAccountSaving(false);
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
    if (authError) {
      return (
        <View style={styles.centered}>
          <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
            {authError}
          </Text>
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity style={styles.signOutButton}>
              <Text style={styles.signOutText}>Ir al inicio de sesión</Text>
            </TouchableOpacity>
          </Link>
        </View>
      );
    }
    return <Redirect href="/(auth)/login" />;
  }

  const metadataNombre = [
    user.user_metadata?.nombre,
    user.user_metadata?.full_name,
    user.user_metadata?.name,
  ].find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0
  );
  const name =
    profileName ??
    metadataNombre ??
    user.email?.split('@')[0] ??
    'Usuario';
  const initials = String(name).trim().charAt(0).toUpperCase() || 'U';
  const metadataAvatarUrl =
    typeof user.user_metadata?.avatar_url === 'string' &&
    user.user_metadata.avatar_url.trim()
      ? user.user_metadata.avatar_url.trim()
      : null;
  const avatarSource = avatarUriOverride ?? metadataAvatarUrl;
  const inputStyle: TextStyle[] = [
    styles.input,
    {
      borderColor: colorScheme === 'dark' ? '#4b5563' : '#d1d5db',
      backgroundColor: colorScheme === 'dark' ? '#111827' : '#ffffff',
      color: colorScheme === 'dark' ? '#f9fafb' : '#111827',
    },
  ];

  // Estado de resultado: suma solo de efectivo y débito.
  // Las tarjetas de crédito quedan fuera: ni el cupo suma ni la deuda resta.
  // El pago de la tarjeta (transferencia débito → crédito) sí baja el total,
  // porque descuenta el saldo de la cuenta de origen.
  const totalCuentas = accounts.reduce((suma, cuenta) => {
    if (cuenta.tipo === 'credito') return suma;
    const saldo = cuenta.saldoActual;
    return typeof saldo === 'number' ? suma + saldo : suma;
  }, 0);
  const totalColor = (() => {
    const verde = colorScheme === 'dark' ? '#34d399' : '#15803d';
    const rojo = colorScheme === 'dark' ? '#f87171' : '#b91c1c';
    return totalCuentas >= 0 ? verde : rojo;
  })();

  // ---- Catálogo: editor de etiquetas, categorías y subcategorías ----
  function abrirCatalogoEditor() {
    setCatEditorError('');
    setCatEditorTab('etiquetas');
    setEditorEditKey(null);
    setEditorNuevoNombre('');
    setEditorNuevoIcono('');
    setEditorNombreDraft('');
    setEditorIconoDraft('');
    setCatEditorAbierto(true);
    void recargarCatalogoEditor();
  }

  async function recargarCatalogoEditor() {
    const userId = user?.id;
    if (!userId) return;
    setCatEditorLoading(true);
    setCatEditorError('');
    try {
      const [catRes, subRes, tagRes] = await Promise.all([
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
          .select('id, nombre, icono')
          .eq('user_id', userId)
          .order('nombre'),
      ]);
      const primerError = catRes.error ?? subRes.error ?? tagRes.error;
      if (primerError) throw new Error(primerError.message);

      const idPropias = new Set<number>();
      const catsCargadas: CategoriaEditorItem[] = (catRes.data ?? []).flatMap(
        (row) => {
          const record = row as {
            id?: unknown;
            nombre?: unknown;
            user_id?: unknown;
          };
          if (
            typeof record?.id !== 'number' ||
            typeof record?.nombre !== 'string' ||
            !record.nombre.trim()
          ) {
            return [];
          }
          if (record.user_id === userId) idPropias.add(record.id);
          return [
            {
              id: record.id,
              nombre: record.nombre.trim(),
              global: record.user_id !== userId,
            },
          ];
        }
      );
      const subsCargadas: SubcategoriaEditorItem[] = (subRes.data ?? []).flatMap(
        (row) => {
          const record = row as {
            id?: unknown;
            nombre?: unknown;
            categoria_id?: unknown;
          };
          if (
            typeof record?.id !== 'number' ||
            typeof record?.nombre !== 'string' ||
            !record.nombre.trim() ||
            typeof record?.categoria_id !== 'number'
          ) {
            return [];
          }
          return [
            {
              id: record.id,
              nombre: record.nombre.trim(),
              categoriaId: record.categoria_id,
              editable: idPropias.has(record.categoria_id),
            },
          ];
        }
      );
      const tagsCargadas: EtiquetaEditorItem[] = (tagRes.data ?? []).flatMap(
        (row) => {
          const record = row as {
            id?: unknown;
            nombre?: unknown;
            icono?: unknown;
          };
          if (
            typeof record?.id !== 'number' ||
            typeof record?.nombre !== 'string' ||
            !record.nombre.trim()
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
      setEditorCategorias(catsCargadas);
      setEditorSubcats(subsCargadas);
      setEditorEtiquetas(tagsCargadas);
      // La categoría padre elegida debe seguir existiendo y ser propia.
      const propiasIds = new Set(
        catsCargadas.filter((cat) => !cat.global).map((cat) => cat.id)
      );
      setEditorSubPadre(
        (prev) =>
          prev !== null && propiasIds.has(prev)
            ? prev
            : propiasIds.values().next().value ?? null
      );
    } catch (e) {
      setCatEditorError(
        e instanceof Error ? e.message : 'No se pudo cargar el catálogo.'
      );
    } finally {
      setCatEditorLoading(false);
    }
  }

  function cambiarTabCatalogo(tab: CatalogoTab) {
    setCatEditorTab(tab);
    setEditorEditKey(null);
    setEditorNuevoNombre('');
    setEditorNuevoIcono('');
    setCatEditorError('');
    if (tab === 'subcategorias') {
      const propias = editorCategorias.filter((cat) => !cat.global);
      setEditorSubPadre(
        (prev) =>
          prev !== null && propias.some((cat) => cat.id === prev)
            ? prev
            : propias[0]?.id ?? null
      );
    }
  }

  function iniciarEdicionCatalogo(key: string, nombre: string, icono = '') {
    setEditorEditKey(key);
    setEditorNombreDraft(nombre);
    setEditorIconoDraft(icono);
    setCatEditorError('');
  }

  function cancelarEdicionCatalogo() {
    setEditorEditKey(null);
    setCatEditorError('');
  }

  // Tras cada mutación: refrescar la lista del editor y los catálogos de
  // todas las pantallas vivas (chips de Movimientos, Rápidos y Escanear).
  async function trasMutacionCatalogo() {
    await recargarCatalogoEditor();
    // El pulso también re-carga presupuestos en este tab (reglas y chips).
    notificarCambio();
  }

  // Conteo de filas que referencian un catálogo (RLS limita a lo propio).
  async function contarUso(tabla: string, columna: string, id: number) {
    const { count, error } = await supabase
      .from(tabla)
      .select('*', { count: 'exact', head: true })
      .eq(columna, id);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  // Reglas de presupuestos propias por tipo y ref_id(s).
  async function contarReglas(tipo: string, refIds: number[]) {
    if (refIds.length === 0) return 0;
    const { count, error } = await supabase
      .from('presupuesto_reglas')
      .select('*', { count: 'exact', head: true })
      .eq('tipo', tipo)
      .in('ref_id', refIds);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async function crearEtiquetaEditor() {
    const userId = user?.id;
    if (!userId) return;
    const nombre = editorNuevoNombre.trim();
    if (!nombre) {
      setCatEditorError('Escribe el nombre de la etiqueta.');
      return;
    }
    const dup = editorEtiquetas.find(
      (item) => item.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (dup) {
      setCatEditorError(`Ya tienes la etiqueta "${dup.nombre}".`);
      return;
    }
    setEditorSaving(true);
    setCatEditorError('');
    try {
      const icono = editorNuevoIcono.trim();
      const { error } = await supabase
        .from('etiquetas')
        .insert(icono ? { user_id: userId, nombre, icono } : { user_id: userId, nombre });
      if (error) throw error;
      setEditorNuevoNombre('');
      setEditorNuevoIcono('');
      await trasMutacionCatalogo();
    } catch (e) {
      setCatEditorError(
        e instanceof Error ? e.message : 'No se pudo crear la etiqueta.'
      );
    } finally {
      setEditorSaving(false);
    }
  }

  async function guardarEtiquetaEditor(id: number) {
    const etiqueta = editorEtiquetas.find((item) => item.id === id);
    if (!etiqueta) return;
    const nombre = editorNombreDraft.trim();
    if (!nombre) {
      setCatEditorError('Escribe el nombre de la etiqueta.');
      return;
    }
    const dup = editorEtiquetas.find(
      (item) =>
        item.id !== id && item.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (dup) {
      setCatEditorError(`Ya tienes la etiqueta "${dup.nombre}".`);
      return;
    }
    const icono = editorIconoDraft.trim();
    const eraDefault = ETIQUETAS_DEFAULT.some(
      (def) => def.nombre.toLowerCase() === etiqueta.nombre.toLowerCase()
    );
    setEditorSaving(true);
    setCatEditorError('');
    try {
      const { error } = await supabase
        .from('etiquetas')
        .update(icono ? { nombre, icono } : { nombre, icono: null })
        .eq('id', id);
      if (error) throw error;
      setEditorEditKey(null);
      await trasMutacionCatalogo();
      if (eraDefault) {
        // El ensure de la vista recreará la etiqueta de fábrica: resincronizar.
        setTimeout(() => void recargarCatalogoEditor(), 1500);
      }
    } catch (e) {
      setCatEditorError(
        e instanceof Error ? e.message : 'No se pudo guardar la etiqueta.'
      );
    } finally {
      setEditorSaving(false);
    }
  }

  function eliminarEtiquetaEditor(etiqueta: EtiquetaEditorItem) {
    setCatEditorError('');
    void (async () => {
      try {
        const [nTrx, nItemsTrx, nReglas] = await Promise.all([
          contarUso('transaccion_etiquetas', 'etiqueta_id', etiqueta.id),
          contarUso('transaccion_item_etiquetas', 'etiqueta_id', etiqueta.id),
          contarReglas('etiqueta', [etiqueta.id]),
        ]);
        if (nReglas > 0) {
          setCatEditorError(
            `"${textoEtiqueta(etiqueta)}" está en presupuestos: quítala de ahí primero.`
          );
          return;
        }
        const movimientos = nTrx + nItemsTrx;
        const esDefault = ETIQUETAS_DEFAULT.some(
          (def) => def.nombre.toLowerCase() === etiqueta.nombre.toLowerCase()
        );
        const avisoFabrica = esDefault
          ? '\nEs de fábrica: volverá a aparecer al recargar la vista.'
          : '';
        confirmar(
          'Eliminar etiqueta',
          movimientos > 0
            ? `"${textoEtiqueta(etiqueta)}" se quitará de ${
                movimientos === 1 ? '1 movimiento' : `${movimientos} movimientos`
              }.${avisoFabrica}`
            : `¿Eliminar "${textoEtiqueta(etiqueta)}"?${avisoFabrica}`,
          async () => {
            setEditorSaving(true);
            try {
              const { error } = await supabase
                .from('etiquetas')
                .delete()
                .eq('id', etiqueta.id);
              if (error) throw error;
              setEditorEditKey(null);
              await trasMutacionCatalogo();
              if (esDefault) {
                setTimeout(() => void recargarCatalogoEditor(), 1500);
              }
            } catch (e) {
              setCatEditorError(
                e instanceof Error
                  ? e.message
                  : 'No se pudo eliminar la etiqueta.'
              );
            } finally {
              setEditorSaving(false);
            }
          }
        );
      } catch (e) {
        setCatEditorError(
          e instanceof Error
            ? e.message
            : 'No se pudo revisar el uso de la etiqueta.'
        );
      }
    })();
  }

  async function crearCategoriaEditor() {
    const userId = user?.id;
    if (!userId) return;
    const nombre = editorNuevoNombre.trim();
    if (!nombre) {
      setCatEditorError('Escribe el nombre de la categoría.');
      return;
    }
    const dup = editorCategorias.find(
      (cat) => cat.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (dup) {
      setCatEditorError(`Ya existe una categoría "${dup.nombre}".`);
      return;
    }
    setEditorSaving(true);
    setCatEditorError('');
    try {
      const { error } = await supabase
        .from('categorias')
        .insert({ user_id: userId, nombre });
      if (error) throw error;
      setEditorNuevoNombre('');
      await trasMutacionCatalogo();
    } catch (e) {
      setCatEditorError(
        e instanceof Error ? e.message : 'No se pudo crear la categoría.'
      );
    } finally {
      setEditorSaving(false);
    }
  }

  async function guardarCategoriaEditor(id: number) {
    const categoria = editorCategorias.find((cat) => cat.id === id);
    if (!categoria) return;
    if (categoria.global) {
      setCatEditorError('Las categorías compartidas no se pueden modificar.');
      return;
    }
    const nombre = editorNombreDraft.trim();
    if (!nombre) {
      setCatEditorError('Escribe el nombre de la categoría.');
      return;
    }
    const dup = editorCategorias.find(
      (cat) =>
        cat.id !== id && cat.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (dup) {
      setCatEditorError(`Ya existe una categoría "${dup.nombre}".`);
      return;
    }
    setEditorSaving(true);
    setCatEditorError('');
    try {
      const { error } = await supabase
        .from('categorias')
        .update({ nombre })
        .eq('id', id);
      if (error) throw error;
      setEditorEditKey(null);
      await trasMutacionCatalogo();
    } catch (e) {
      setCatEditorError(
        e instanceof Error ? e.message : 'No se pudo guardar la categoría.'
      );
    } finally {
      setEditorSaving(false);
    }
  }

  function eliminarCategoriaEditor(cat: CategoriaEditorItem) {
    if (cat.global) {
      setCatEditorError('Las categorías compartidas no se pueden eliminar.');
      return;
    }
    setCatEditorError('');
    void (async () => {
      try {
        const nItems = await contarUso('transaccion_items', 'categoria_id', cat.id);
        if (nItems > 0) {
          setCatEditorError(
            `No se puede eliminar "${cat.nombre}": la usan ${
              nItems === 1 ? '1 artículo de boleta' : `${nItems} artículos de boletas`
            }.`
          );
          return;
        }
        const subsDeCat = editorSubcats.filter(
          (sub) => sub.categoriaId === cat.id
        );
        const [nReglaCat, nReglaSub] = await Promise.all([
          contarReglas('categoria', [cat.id]),
          contarReglas(
            'subcategoria',
            subsDeCat.map((sub) => sub.id)
          ),
        ]);
        if (nReglaCat + nReglaSub > 0) {
          setCatEditorError(
            `No se puede eliminar "${cat.nombre}": está en presupuestos. Quítala de ahí primero.`
          );
          return;
        }
        const nombres = subsDeCat
          .map((sub) => sub.nombre)
          .join(', ');
        const detalleSubs =
          subsDeCat.length > 0
            ? `\nTambién se eliminarán ${
                subsDeCat.length === 1
                  ? 'la subcategoría'
                  : `${subsDeCat.length} subcategorías`
              }${nombres ? ` (${nombres})` : ''}.`
            : '';
        confirmar(
          'Eliminar categoría',
          `Las transacciones con "${cat.nombre}" quedarán sin categoría.${detalleSubs}`,
          async () => {
            setEditorSaving(true);
            try {
              const { error } = await supabase
                .from('categorias')
                .delete()
                .eq('id', cat.id);
              if (error) {
                const codigo = (error as { code?: string }).code;
                if (codigo === '23503') {
                  setCatEditorError(
                    `No se pudo eliminar "${cat.nombre}": hay boletas con artículos en esta categoría.`
                  );
                  return;
                }
                throw error;
              }
              setEditorEditKey(null);
              setEditorSubPadre((prev) => (prev === cat.id ? null : prev));
              await trasMutacionCatalogo();
            } catch (e) {
              setCatEditorError(
                e instanceof Error
                  ? e.message
                  : 'No se pudo eliminar la categoría.'
              );
            } finally {
              setEditorSaving(false);
            }
          }
        );
      } catch (e) {
        setCatEditorError(
          e instanceof Error
            ? e.message
            : 'No se pudo revisar el uso de la categoría.'
        );
      }
    })();
  }

  async function crearSubcategoriaEditor() {
    const nombre = editorNuevoNombre.trim();
    if (editorSubPadre === null) {
      setCatEditorError('Elige primero una categoría propia como "Padre".');
      return;
    }
    if (!nombre) {
      setCatEditorError('Escribe el nombre de la subcategoría.');
      return;
    }
    const dup = editorSubcats.find(
      (sub) =>
        sub.categoriaId === editorSubPadre &&
        sub.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (dup) {
      setCatEditorError(`Ya existe "${dup.nombre}" en esa categoría.`);
      return;
    }
    setEditorSaving(true);
    setCatEditorError('');
    try {
      const { error } = await supabase
        .from('subcategorias')
        .insert({ categoria_id: editorSubPadre, nombre });
      if (error) throw error;
      setEditorNuevoNombre('');
      await trasMutacionCatalogo();
    } catch (e) {
      setCatEditorError(
        e instanceof Error ? e.message : 'No se pudo crear la subcategoría.'
      );
    } finally {
      setEditorSaving(false);
    }
  }

  async function guardarSubcategoriaEditor(id: number) {
    const sub = editorSubcats.find((item) => item.id === id);
    if (!sub) return;
    if (!sub.editable) {
      setCatEditorError(
        'Las subcategorías de categorías compartidas no se pueden modificar.'
      );
      return;
    }
    const nombre = editorNombreDraft.trim();
    if (!nombre) {
      setCatEditorError('Escribe el nombre de la subcategoría.');
      return;
    }
    const dup = editorSubcats.find(
      (item) =>
        item.id !== id &&
        item.categoriaId === sub.categoriaId &&
        item.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (dup) {
      setCatEditorError(`Ya existe "${dup.nombre}" en esa categoría.`);
      return;
    }
    setEditorSaving(true);
    setCatEditorError('');
    try {
      const { error } = await supabase
        .from('subcategorias')
        .update({ nombre })
        .eq('id', id);
      if (error) throw error;
      setEditorEditKey(null);
      await trasMutacionCatalogo();
    } catch (e) {
      setCatEditorError(
        e instanceof Error ? e.message : 'No se pudo guardar la subcategoría.'
      );
    } finally {
      setEditorSaving(false);
    }
  }

  function eliminarSubcategoriaEditor(sub: SubcategoriaEditorItem) {
    if (!sub.editable) {
      setCatEditorError(
        'Las subcategorías de categorías compartidas no se pueden modificar.'
      );
      return;
    }
    setCatEditorError('');
    void (async () => {
      try {
        const nItems = await contarUso(
          'transaccion_items',
          'subcategoria_id',
          sub.id
        );
        if (nItems > 0) {
          setCatEditorError(
            `No se puede eliminar "${sub.nombre}": la usan ${
              nItems === 1 ? '1 artículo de boleta' : `${nItems} artículos de boletas`
            }.`
          );
          return;
        }
        const nReglas = await contarReglas('subcategoria', [sub.id]);
        if (nReglas > 0) {
          setCatEditorError(
            `"${sub.nombre}" está en presupuestos: quítala de ahí primero.`
          );
          return;
        }
        confirmar(
          'Eliminar subcategoría',
          `Las transacciones con "${sub.nombre}" quedarán sin subcategoría.`,
          async () => {
            setEditorSaving(true);
            try {
              const { error } = await supabase
                .from('subcategorias')
                .delete()
                .eq('id', sub.id);
              if (error) {
                const codigo = (error as { code?: string }).code;
                if (codigo === '23503') {
                  setCatEditorError(
                    `No se pudo eliminar "${sub.nombre}": hay boletas con artículos en esta subcategoría.`
                  );
                  return;
                }
                throw error;
              }
              setEditorEditKey(null);
              await trasMutacionCatalogo();
            } catch (e) {
              setCatEditorError(
                e instanceof Error
                  ? e.message
                  : 'No se pudo eliminar la subcategoría.'
              );
            } finally {
              setEditorSaving(false);
            }
          }
        );
      } catch (e) {
        setCatEditorError(
          e instanceof Error
            ? e.message
            : 'No se pudo revisar el uso de la subcategoría.'
        );
      }
    })();
  }

  // ---- Presupuestos: derivados de la vista ----
  const presBanner = (() => {
    let peor: PresupuestoDetalle | null = null;
    let peorPct = -1;
    for (const pres of presupuestos) {
      if (pres.montoMensual <= 0) continue;
      const pct = Math.round((pres.gastado / pres.montoMensual) * 100);
      if (pct >= 75 && pct > peorPct) {
        peorPct = pct;
        peor = pres;
      }
    }
    if (!peor) return null;
    return {
      texto:
        peorPct >= 100
          ? `⚠️ ${peor.nombre} superó su presupuesto (${peorPct}%) por ${formatChileanPesos(
              peor.gastado - peor.montoMensual
            )}`
          : `⚠️ ${peor.nombre} al ${peorPct}% — quedan ${formatChileanPesos(
              peor.montoMensual - peor.gastado
            )}`,
    };
  })();

  const presSubFiltradas =
    presCats.length > 0
      ? subOptions.filter((sub) => presCats.includes(sub.categoriaId))
      : subOptions;

  const presDetalle =
    presDetalleId !== null
      ? presupuestos.find((pres) => pres.id === presDetalleId) ?? null
      : null;

  function colorProgreso(gastado: number, meta: number) {
    const pct = meta > 0 ? gastado / meta : 0;
    // verde <50% · ámbar 50–74% · naranja 75–99% · rojo ≥100%
    if (pct >= 1) return '#ef4444';
    if (pct >= 0.75) return '#f97316';
    if (pct >= 0.5) return '#f59e0b';
    return '#22c55e';
  }

  function porcentajePresupuesto(pres: PresupuestoDetalle) {
    if (pres.montoMensual <= 0) return 0;
    return Math.round((pres.gastado / pres.montoMensual) * 100);
  }

  function describirReglas(pres: PresupuestoDetalle) {
    if (pres.reglas.length === 0) return 'Sin reglas';
    const catReglas = pres.reglas.filter(
      (regla) => regla.tipo === 'categoria'
    );
    const subReglas = pres.reglas.filter(
      (regla) => regla.tipo === 'subcategoria'
    );
    const tagReglas = pres.reglas.filter(
      (regla) => regla.tipo === 'etiqueta'
    );
    const nombreCat = (id: number) =>
      catOptions.find((cat) => cat.id === id)?.nombre ?? 'Categoría';
    const nombreSub = (id: number) => {
      const sub = subOptions.find((item) => item.id === id);
      if (!sub) return 'Subcategoría';
      // Regla de subcategoría sola: muestra la ruta "Alimentos › Supermercado"
      if (subReglas.length === 1 && catReglas.length === 0) {
        return `${nombreCat(sub.categoriaId)} › ${sub.nombre}`;
      }
      return sub.nombre;
    };
    const nombreTag = (id: number) => {
      const etiqueta = etiquetaOptions.find((item) => item.id === id);
      return etiqueta ? textoEtiqueta(etiqueta) : '#etiqueta';
    };
    const items = [
      ...catReglas.map((regla) => nombreCat(regla.refId)),
      ...subReglas.map((regla) => nombreSub(regla.refId)),
      ...tagReglas.map((regla) => nombreTag(regla.refId)),
    ];
    if (items.length <= 2) return items.join(' · ');
    return [
      catReglas.length ? `${catReglas.length} categorías` : null,
      subReglas.length ? `${subReglas.length} subcategorías` : null,
      tagReglas.length ? `${tagReglas.length} etiquetas` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function chipPresupuesto(
    chipKey: string,
    label: string,
    activo: boolean,
    onPress: () => void
  ) {
    return (
      <TouchableOpacity
        key={chipKey}
        accessibilityRole="button"
        accessibilityState={{ selected: activo }}
        onPress={onPress}
        disabled={presSaving}
        style={
          activo
            ? styles.tipoChipActivo
            : [
                styles.tipoChip,
                {
                  backgroundColor:
                    colorScheme === 'dark' ? '#1e293b' : '#e2e8f0',
                },
              ]
        }
      >
        <Text
          style={[
            styles.tipoChipTexto,
            activo
              ? styles.tipoChipTextoActivo
              : {
                  color: colorScheme === 'dark' ? '#e2e8f0' : '#111827',
                },
          ]}
        >
          {label}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Mi cuenta</Text>
      <Text style={styles.subtitle} lightColor="#6b7280" darkColor="#9ca3af">
        Información de tu sesión
      </Text>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Cambiar a modo ${colorScheme === 'dark' ? 'claro' : 'oscuro'}`}
        onPress={() => void toggleColorScheme()}
        style={[
          styles.themeButton,
          {
            backgroundColor: colorScheme === 'dark' ? '#312e81' : '#e0e7ff',
          },
        ]}
      >
        <Text
          style={styles.themeButtonText}
          lightColor="#4338ca"
          darkColor="#c7d2fe"
        >
          {colorScheme === 'dark' ? '☀️  Modo claro' : '🌙  Modo oscuro'}
        </Text>
      </TouchableOpacity>

      <View style={styles.card} lightColor="#ffffff" darkColor="#1f2937">
        {avatarSource ? (
          <Image source={{ uri: avatarSource }} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatar} lightColor="#e0e7ff" darkColor="#3730a3">
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        )}

        <Text style={styles.name}>{name}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={openEditProfile}
          style={styles.editNameButton}
        >
          <Text style={styles.editNameText}>✏️ Editar perfil</Text>
        </TouchableOpacity>

        <View
          style={styles.separator}
          lightColor="#e5e7eb"
          darkColor="#374151"
        />

        <View
          style={styles.infoRow}
          lightColor="transparent"
          darkColor="transparent"
        >
          <Text style={styles.label} lightColor="#6b7280" darkColor="#9ca3af">
            Correo electrónico
          </Text>
          <Text style={styles.value}>{user.email ?? 'No disponible'}</Text>
        </View>
      </View>

      <Modal
        visible={editingProfile}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!avatarUploading && !nameSaving) {
            setEditingProfile(false);
          }
        }}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => {
            if (!avatarUploading && !nameSaving) {
              setEditingProfile(false);
            }
          }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View
              style={styles.modalCard}
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              <Text style={styles.modalTitle}>Editar perfil</Text>

              {avatarSource ? (
                <Image
                  source={{ uri: avatarSource }}
                  style={styles.avatarModal}
                />
              ) : (
                <View
                  style={styles.avatarModalFallback}
                  lightColor="#e0e7ff"
                  darkColor="#3730a3"
                >
                  <Text style={styles.avatarText}>{initials}</Text>
                </View>
              )}

              {avatarUploading ? (
                <ActivityIndicator style={styles.avatarBusy} color="#4f46e5" />
              ) : (
                <View
                  style={styles.avatarActions}
                  lightColor="transparent"
                  darkColor="transparent"
                >
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => void changeAvatar('gallery')}
                    style={styles.avatarButton}
                  >
                    <Text
                      style={styles.avatarActionText}
                      lightColor="#4338ca"
                      darkColor="#c7d2fe"
                    >
                      📷 Galería
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => void changeAvatar('camera')}
                    style={styles.avatarButton}
                  >
                    <Text
                      style={styles.avatarActionText}
                      lightColor="#4338ca"
                      darkColor="#c7d2fe"
                    >
                      📸 Cámara
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              <TextInput
                style={inputStyle}
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder="Tu nombre"
                placeholderTextColor={
                  colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                }
                autoCapitalize="words"
              />

              {profileError ? (
                <Text
                  style={styles.modalError}
                  lightColor="#b91c1c"
                  darkColor="#fca5a5"
                >
                  {profileError}
                </Text>
              ) : null}

              <View
                style={styles.nameActions}
                lightColor="transparent"
                darkColor="transparent"
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => void handleSaveName()}
                  disabled={nameSaving}
                  style={styles.confirmButton}
                >
                  <Text style={styles.confirmText}>
                    {nameSaving ? 'Guardando...' : 'Guardar'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => {
                    setEditingProfile(false);
                    setProfileError('');
                  }}
                  disabled={nameSaving}
                  style={styles.cancelButton}
                >
                  <Text style={styles.cancelText}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {profileError ? (
        <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
          {profileError}
        </Text>
      ) : null}

      {storageError ? (
        <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
          {storageError}
        </Text>
      ) : null}

      <View
        style={styles.cuentasHeader}
        lightColor="transparent"
        darkColor="transparent"
      >
        <Text style={styles.balanceHeading}>Cuentas</Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            setAccountsError('');
            setAddingAccount((value) => !value);
          }}
          style={styles.addToggle}
        >
          <Text style={styles.addToggleText}>
            {addingAccount ? '✕ Cerrar' : '＋ Agregar'}
          </Text>
        </TouchableOpacity>
      </View>

      {addingAccount ? (
        <View style={styles.addCard} lightColor="#ffffff" darkColor="#1f2937">
          <TextInput
            style={inputStyle}
            value={newName}
            onChangeText={setNewName}
            placeholder="Nombre de la cuenta (ej: Cuenta Vista)"
            placeholderTextColor={
              colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
            }
            autoCapitalize="sentences"
            onSubmitEditing={() => void handleAddAccount()}
          />
          <TextInput
            style={[inputStyle, styles.campoSecundario]}
            value={newBanco}
            onChangeText={setNewBanco}
            placeholder="Banco (ej: Banco de Chile) — opcional"
            placeholderTextColor={
              colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
            }
            autoCapitalize="sentences"
            onSubmitEditing={() => void handleAddAccount()}
          />
          <Text style={styles.tipoEtiqueta}>Tipo de cuenta</Text>
          <View style={styles.tipoFila}>
            {TIPOS_CUENTA.map((tipo) => {
              const activo = newTipo === tipo;
              return (
                <TouchableOpacity
                  key={tipo}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activo }}
                  onPress={() => setNewTipo(tipo)}
                  disabled={accountSaving}
                  style={
                    activo
                      ? styles.tipoChipActivo
                      : [
                          styles.tipoChip,
                          {
                            backgroundColor:
                              colorScheme === 'dark' ? '#1e293b' : '#e2e8f0',
                          },
                        ]
                  }
                >
                  <Text
                    style={[
                      styles.tipoChipTexto,
                      activo
                        ? styles.tipoChipTextoActivo
                        : {
                            color:
                              colorScheme === 'dark'
                                ? '#e2e8f0'
                                : '#111827',
                          },
                    ]}
                  >
                    {tipo}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {newTipo === 'credito' ? (
            <View style={styles.creditoCampos}>
              <TextInput
                style={inputStyle}
                value={newCupo}
                onChangeText={(texto) => setNewCupo(formatearMontoEnEntrada(texto))}
                placeholder="Cupo de la tarjeta (ej: 1.000.000)"
                placeholderTextColor={
                  colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                }
                keyboardType="numeric"
              />
              <View style={styles.creditoDiasFila}>
                <TextInput
                  style={[inputStyle, styles.creditoDiaInput]}
                  value={newDiaCorte}
                  onChangeText={setNewDiaCorte}
                  placeholder="Día de corte (1-28)"
                  placeholderTextColor={
                    colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                  }
                  keyboardType="number-pad"
                  maxLength={2}
                />
                <TextInput
                  style={[inputStyle, styles.creditoDiaInput]}
                  value={newDiaPago}
                  onChangeText={setNewDiaPago}
                  placeholder="Día de pago (1-28)"
                  placeholderTextColor={
                    colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                  }
                  keyboardType="number-pad"
                  maxLength={2}
                />
              </View>
              <Text
                style={styles.creditoAyuda}
                lightColor="#6b7280"
                darkColor="#9ca3af"
              >
                El cupo no suma al total y la deuda no lo resta. Al pagar la
                tarjeta con una transferencia, el pago sí aparece en tu estado
                de resultado.
              </Text>
            </View>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void handleAddAccount()}
            disabled={accountSaving}
            style={styles.saveAccountButton}
          >
            <Text style={styles.saveAccountText}>
              {accountSaving ? 'Agregando...' : 'Agregar cuenta'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.balanceCard} lightColor="#ffffff" darkColor="#1f2937">
        {accountsLoading ? (
          <ActivityIndicator size="small" color="#4f46e5" />
        ) : accountsError ? (
          <>
            <Text style={styles.errorInline} lightColor="#b91c1c" darkColor="#fca5a5">
              {accountsError}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setAccountsReload((reload) => reload + 1)}
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Reintentar</Text>
            </TouchableOpacity>
          </>
        ) : accounts.length === 0 ? (
          <Text
            style={styles.emptyBalance}
            lightColor="#6b7280"
            darkColor="#9ca3af"
          >
            No tienes cuentas registradas. Toca “＋ Agregar” para crear una
            (banco o efectivo).
          </Text>
        ) : (
          accounts.map((account) => {
            const esCredito = account.tipo === 'credito';
            const ciclo = [
              account.diaCorte ? `Corte día ${account.diaCorte}` : null,
              account.diaPago ? `Pago día ${account.diaPago}` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            const subtitle = [account.tipo, account.banco, ciclo || null]
              .filter(Boolean)
              .join(' · ');
            const cupo = account.cupo;
            const disponible = account.saldoActual;
            const deuda =
              esCredito && cupo !== null && disponible !== null
                ? Math.max(cupo - disponible, 0)
                : null;
            const deudaColor =
              deuda !== null && deuda > 0
                ? colorScheme === 'dark'
                  ? '#f87171'
                  : '#b91c1c'
                : colorScheme === 'dark'
                  ? '#34d399'
                  : '#15803d';
            return (
              <View
                key={account.id}
                style={styles.accountRow}
                lightColor="transparent"
                darkColor="transparent"
              >
                <View
                  style={styles.accountInfo}
                  lightColor="transparent"
                  darkColor="transparent"
                >
                  <Text style={styles.accountName}>
                    {account.nombre ?? 'Cuenta'}
                  </Text>
                  {subtitle ? (
                    <Text
                      style={styles.accountSubtitle}
                      lightColor="#6b7280"
                      darkColor="#9ca3af"
                    >
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                <View
                  style={styles.accountRight}
                  lightColor="transparent"
                  darkColor="transparent"
                >
                  {esCredito ? (
                    cupo === null || disponible === null ? (
                      <Text
                        style={styles.creditoLinea}
                        lightColor="#6b7280"
                        darkColor="#9ca3af"
                      >
                        Cupo no definido
                      </Text>
                    ) : (
                      <>
                        <Text
                          style={styles.creditoLinea}
                          lightColor="#6b7280"
                          darkColor="#9ca3af"
                        >
                          Cupo {formatChileanPesos(cupo)}
                        </Text>
                        <Text
                          style={[styles.creditoLinea, { color: deudaColor }]}
                        >
                          Deuda {formatChileanPesos(deuda ?? 0)}
                        </Text>
                        <Text style={styles.balanceValue}>
                          Disponible {formatChileanPesos(disponible)}
                        </Text>
                      </>
                    )
                  ) : (
                    <Text style={styles.balanceValue}>
                      {account.saldoActual === null
                        ? 'Saldo no disponible'
                        : formatChileanPesos(account.saldoActual)}
                    </Text>
                  )}
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => confirmRemoveAccount(account)}
                  >
                    <Text
                      style={styles.removeText}
                      lightColor="#b91c1c"
                      darkColor="#fca5a5"
                    >
                      Eliminar
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}

        {accounts.length > 0 ? (
          <View
            style={styles.totalCuentasRow}
            lightColor="transparent"
            darkColor="transparent"
          >
            <Text
              style={styles.totalCuentasEtiqueta}
              lightColor="#6b7280"
              darkColor="#9ca3af"
            >
              Total de mis cuentas (estado de resultado)
            </Text>
            <Text style={[styles.totalCuentasValor, { color: totalColor }]}>
              {formatChileanPesos(totalCuentas)}
            </Text>
          </View>
        ) : null}
      </View>

      {/* ---- Sección Presupuestos ---- */}
      <View
        style={styles.cuentasHeader}
        lightColor="transparent"
        darkColor="transparent"
      >
        <Text style={styles.balanceHeading}>Presupuestos</Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            setPresupuestosError('');
            abrirPresupuestoNuevo();
          }}
          style={styles.addToggle}
        >
          <Text style={styles.addToggleText}>＋ Nuevo</Text>
        </TouchableOpacity>
      </View>
      <Text
        style={styles.presSeccionIntro}
        lightColor="#6b7280"
        darkColor="#9ca3af"
      >
        Cuánto llevas gastado este mes en cada presupuesto.
      </Text>

      {presupuestosLoading ? (
        <ActivityIndicator
          size="small"
          color="#4f46e5"
          style={styles.presLoader}
        />
      ) : presupuestosError ? (
        <View style={styles.balanceCard} lightColor="#ffffff" darkColor="#1f2937">
          <Text
            style={styles.errorInline}
            lightColor="#b91c1c"
            darkColor="#fca5a5"
          >
            {presupuestosError}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setPresupuestosReload((value) => value + 1)}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : presupuestos.length === 0 ? (
        <View style={styles.balanceCard} lightColor="#ffffff" darkColor="#1f2937">
          <Text
            style={styles.emptyBalance}
            lightColor="#6b7280"
            darkColor="#9ca3af"
          >
            Aún no tienes presupuestos. Toca “＋ Nuevo” para definir, por
            ejemplo, cuánto quieres gastar en Alimentos este mes.
          </Text>
        </View>
      ) : (
        <View>
          {presBanner ? (
            <View
              style={styles.presBanner}
              lightColor="#fff7ed"
              darkColor="#422006"
            >
              <Text
                style={styles.presBannerText}
                lightColor="#9a3412"
                darkColor="#fcd34d"
              >
                {presBanner.texto}
              </Text>
            </View>
          ) : null}
          {presupuestos.map((pres) => {
            const pct = porcentajePresupuesto(pres);
            const pctBarra = Math.min(pct, 100);
            const color = colorProgreso(pres.gastado, pres.montoMensual);
            const sobre = pres.gastado - pres.montoMensual;
            return (
              <View
                key={pres.id}
                style={styles.presCard}
                lightColor="#ffffff"
                darkColor="#1f2937"
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => setPresDetalleId(pres.id)}
                  style={styles.presCardTop}
                >
                  <View
                    style={styles.presCardInfo}
                    lightColor="transparent"
                    darkColor="transparent"
                  >
                    <Text style={styles.presNombre}>{pres.nombre}</Text>
                    <Text
                      style={styles.presAlcance}
                      lightColor="#6b7280"
                      darkColor="#9ca3af"
                    >
                      {describirReglas(pres)}
                    </Text>
                  </View>
                  <Text style={styles.presMontos}>
                    {formatChileanPesos(pres.gastado)} /{' '}
                    {formatChileanPesos(pres.montoMensual)}
                  </Text>
                </TouchableOpacity>
                <View style={styles.presBarraTrack}>
                  <View
                    style={[
                      styles.presBarraFill,
                      { width: `${pctBarra}%`, backgroundColor: color },
                    ]}
                  />
                </View>
                <View style={styles.presCardPie}>
                  <Text style={[styles.presPct, { color }]}>
                    {pct >= 100
                      ? `Te pasaste por ${formatChileanPesos(sobre)}`
                      : `${pct}% usado`}
                  </Text>
                  <View style={styles.presAcciones}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => abrirPresupuestoEdicion(pres)}
                    >
                      <Text style={styles.presAccion}>Editar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => confirmarEliminarPresupuesto(pres)}
                    >
                      <Text style={styles.presAccionEliminar}>Eliminar</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* ---- Sección Catálogo (editor de clasificaciones) ---- */}
      <View
        style={styles.cuentasHeader}
        lightColor="transparent"
        darkColor="transparent"
      >
        <Text style={styles.balanceHeading}>Catálogo</Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => abrirCatalogoEditor()}
          style={styles.addToggle}
        >
          <Text style={styles.addToggleText}>⚙️ Editar</Text>
        </TouchableOpacity>
      </View>
      <Text
        style={styles.presSeccionIntro}
        lightColor="#6b7280"
        darkColor="#9ca3af"
      >
        Categorías, subcategorías y etiquetas que usas al clasificar tus gastos.
      </Text>

      {/* ---- Modal detalle de presupuesto ---- */}
      <Modal
        visible={presDetalleId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPresDetalleId(null)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setPresDetalleId(null)}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View
              style={styles.modalCard}
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              {presDetalle ? (
                <>
                  <Text style={styles.modalTitle}>{presDetalle.nombre}</Text>
                  <Text
                    style={styles.presDetalleSub}
                    lightColor="#6b7280"
                    darkColor="#9ca3af"
                  >
                    {describirReglas(presDetalle)}
                  </Text>
                  <Text style={styles.presDetalleTotales}>
                    {formatChileanPesos(presDetalle.gastado)} de{' '}
                    {formatChileanPesos(presDetalle.montoMensual)} (
                    {porcentajePresupuesto(presDetalle)}%)
                  </Text>
                  <View
                    style={styles.presDetalleSeparator}
                    lightColor="#e5e7eb"
                    darkColor="#374151"
                  />
                  <ScrollView style={styles.presDetalleLista} nestedScrollEnabled>
                    {presDetalle.transacciones.length === 0 ? (
                      <Text
                        style={styles.presDetalleVacio}
                        lightColor="#6b7280"
                        darkColor="#9ca3af"
                      >
                        Sin gastos que coincidan con este presupuesto este mes.
                      </Text>
                    ) : (
                      presDetalle.transacciones.map((trx) => {
                        const cuentaNombre =
                          trx.cuentaId !== null
                            ? accounts.find((cuenta) => cuenta.id === String(trx.cuentaId))
                                ?.nombre ?? null
                            : null;
                        return (
                          <View
                            key={trx.id}
                            style={styles.presTrxRow}
                            lightColor="transparent"
                            darkColor="transparent"
                          >
                            <View
                              style={styles.presCardInfo}
                              lightColor="transparent"
                              darkColor="transparent"
                            >
                              <Text style={styles.presTrxComercio}>
                                {trx.comercioNombre ?? 'Sin comercio'}
                              </Text>
                              <Text
                                style={styles.presTrxSub}
                                lightColor="#6b7280"
                                darkColor="#9ca3af"
                              >
                                {fechaChilena(trx.fecha)}
                                {cuentaNombre ? ` · ${cuentaNombre}` : ''}
                              </Text>
                            </View>
                            <Text
                              style={styles.presTrxMonto}
                              lightColor="#b91c1c"
                              darkColor="#f87171"
                            >
                              −{formatChileanPesos(trx.total)}
                            </Text>
                          </View>
                        );
                      })
                    )}
                  </ScrollView>
                  <View style={styles.presDetalleAcciones}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => abrirPresupuestoEdicion(presDetalle)}
                      style={styles.presDetalleBoton}
                    >
                      <Text style={styles.presAccion}>✏️ Editar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => confirmarEliminarPresupuesto(presDetalle)}
                      style={styles.presDetalleBoton}
                    >
                      <Text style={styles.presAccionEliminar}>🗑 Eliminar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => setPresDetalleId(null)}
                      style={styles.presDetalleBoton}
                    >
                      <Text style={styles.cancelText}>Cerrar</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ---- Modal crear/editar presupuesto ---- */}
      <Modal
        visible={presModalAbierto}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!presSaving) {
            setPresModalAbierto(false);
          }
        }}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => {
            if (!presSaving) {
              setPresModalAbierto(false);
            }
          }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View
              style={styles.modalCard}
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              <ScrollView
                style={styles.presFormScroll}
                nestedScrollEnabled
                contentContainerStyle={styles.presFormScrollContent}
              >
                <Text style={styles.modalTitle}>
                  {presEditandoId === null
                    ? 'Nuevo presupuesto'
                    : 'Editar presupuesto'}
                </Text>

                {presEditandoId === null ? (
                  <View style={styles.presPresets}>
                    <Text style={styles.presSeccion}>
                      Presets (solo prellenan el formulario)
                    </Text>
                    <View style={styles.chipFila}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() => aplicarPresetGastosBasicos()}
                        disabled={presSaving}
                        style={[
                          styles.tipoChip,
                          {
                            backgroundColor:
                              colorScheme === 'dark' ? '#312e81' : '#e0e7ff',
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.tipoChipTexto,
                            {
                              color:
                                colorScheme === 'dark' ? '#c7d2fe' : '#4338ca',
                            },
                          ]}
                        >
                          🏠 Gastos básicos
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() => aplicarPresetGastoHormiga()}
                        disabled={presSaving}
                        style={[
                          styles.tipoChip,
                          {
                            backgroundColor:
                              colorScheme === 'dark' ? '#312e81' : '#e0e7ff',
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.tipoChipTexto,
                            {
                              color:
                                colorScheme === 'dark' ? '#c7d2fe' : '#4338ca',
                            },
                          ]}
                        >
                          🐜 Gasto hormiga
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : null}

                <TextInput
                  style={inputStyle}
                  value={presNombre}
                  onChangeText={setPresNombre}
                  placeholder="Nombre (ej: Supermercado)"
                  placeholderTextColor={
                    colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                  }
                  autoCapitalize="sentences"
                />
                <TextInput
                  style={[inputStyle, styles.campoSecundario]}
                  value={presMonto}
                  onChangeText={(texto) => setPresMonto(formatearMontoEnEntrada(texto))}
                  placeholder="Monto mensual (ej: 45.000)"
                  placeholderTextColor={
                    colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                  }
                  keyboardType="numeric"
                />

                <Text style={styles.presSeccion}>Categorías</Text>
                <View style={styles.chipFila}>
                  {catOptions.map((cat) =>
                    chipPresupuesto(
                      `cat-${cat.id}`,
                      cat.nombre,
                      presCats.includes(cat.id),
                      () => setPresCats((lista) => toggleEn(lista, cat.id))
                    )
                  )}
                </View>

                {presSubFiltradas.length > 0 ? (
                  <>
                    <Text style={styles.presSeccion}>Subcategorías</Text>
                    <View style={styles.chipFila}>
                      {presSubFiltradas.map((sub) =>
                        chipPresupuesto(
                          `sub-${sub.id}`,
                          sub.nombre,
                          presSubs.includes(sub.id),
                          () => setPresSubs((lista) => toggleEn(lista, sub.id))
                        )
                      )}
                    </View>
                  </>
                ) : null}

                {etiquetaOptions.length > 0 ? (
                  <>
                    <Text style={styles.presSeccion}>Etiquetas</Text>
                    <View style={styles.chipFila}>
                      {etiquetaOptions.map((etiqueta) =>
                        chipPresupuesto(
                          `tag-${etiqueta.id}`,
                          textoEtiqueta(etiqueta),
                          presTags.includes(etiqueta.id),
                          () =>
                            setPresTags((lista) =>
                              toggleEn(lista, etiqueta.id)
                            )
                        )
                      )}
                    </View>
                  </>
                ) : null}

                {presFormError ? (
                  <Text
                    style={styles.modalError}
                    lightColor="#b91c1c"
                    darkColor="#fca5a5"
                  >
                    {presFormError}
                  </Text>
                ) : null}

                <View
                  style={styles.nameActions}
                  lightColor="transparent"
                  darkColor="transparent"
                >
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => void guardarPresupuesto()}
                    disabled={presSaving}
                    style={styles.confirmButton}
                  >
                    <Text style={styles.confirmText}>
                      {presSaving ? 'Guardando...' : 'Guardar'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => {
                      setPresModalAbierto(false);
                      setPresFormError('');
                    }}
                    disabled={presSaving}
                    style={styles.cancelButton}
                  >
                    <Text style={styles.cancelText}>Cancelar</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ---- Modal editor de catálogo ---- */}
      <Modal
        visible={catEditorAbierto}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!editorSaving) {
            setCatEditorAbierto(false);
          }
        }}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => {
            if (!editorSaving) {
              setCatEditorAbierto(false);
            }
          }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View
              style={styles.modalCard}
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              <Text style={styles.modalTitle}>Editar catálogo</Text>

              <View style={styles.chipFila}>
                {chipPresupuesto(
                  'tab-etiquetas',
                  'Etiquetas',
                  catEditorTab === 'etiquetas',
                  () => cambiarTabCatalogo('etiquetas')
                )}
                {chipPresupuesto(
                  'tab-categorias',
                  'Categorías',
                  catEditorTab === 'categorias',
                  () => cambiarTabCatalogo('categorias')
                )}
                {chipPresupuesto(
                  'tab-subcategorias',
                  'Subcategorías',
                  catEditorTab === 'subcategorias',
                  () => cambiarTabCatalogo('subcategorias')
                )}
              </View>

              {catEditorLoading ? (
                <ActivityIndicator
                  size="small"
                  color="#4f46e5"
                  style={styles.presLoader}
                />
              ) : (
                <ScrollView
                  style={styles.presFormScroll}
                  contentContainerStyle={styles.presFormScrollContent}
                  nestedScrollEnabled
                >
                  {catEditorError ? (
                    <Text
                      style={styles.modalError}
                      lightColor="#b91c1c"
                      darkColor="#fca5a5"
                    >
                      {catEditorError}
                    </Text>
                  ) : null}

                  {catEditorTab === 'etiquetas' ? (
                    <>
                      <View style={styles.catEditorCrear}>
                        <TextInput
                          style={[inputStyle, styles.catEditorInput]}
                          value={editorNuevoNombre}
                          onChangeText={setEditorNuevoNombre}
                          placeholder="Nueva etiqueta (ej: Restaurantes)"
                          placeholderTextColor={
                            colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                          }
                          autoCapitalize="sentences"
                        />
                        <TouchableOpacity
                          accessibilityRole="button"
                          onPress={() => void crearEtiquetaEditor()}
                          disabled={editorSaving}
                          style={styles.catEditorAgregar}
                        >
                          <Text style={styles.catEditorAgregarTexto}>
                            ＋ Agregar
                          </Text>
                        </TouchableOpacity>
                      </View>
                      <View style={styles.catEditorIconos}>
                        {ICONOS_ETIQUETA.map((icono) =>
                          chipPresupuesto(
                            `icono-nuevo-${icono || 'ninguno'}`,
                            icono || '—',
                            editorNuevoIcono === icono,
                            () => setEditorNuevoIcono(icono)
                          )
                        )}
                      </View>

                      {editorEtiquetas.length === 0 ? (
                        <Text
                          style={styles.presDetalleVacio}
                          lightColor="#6b7280"
                          darkColor="#9ca3af"
                        >
                          Aún no tienes etiquetas.
                        </Text>
                      ) : (
                        editorEtiquetas.map((etiqueta) => {
                          const filaKey = `etiqueta-${etiqueta.id}`;
                          return editorEditKey === filaKey ? (
                            <View
                              key={filaKey}
                              style={styles.catEditorEdicion}
                              lightColor="transparent"
                              darkColor="transparent"
                            >
                              <TextInput
                                style={[inputStyle, styles.campoSecundario]}
                                value={editorNombreDraft}
                                onChangeText={setEditorNombreDraft}
                                placeholder="Nombre de la etiqueta"
                                placeholderTextColor={
                                  colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                                }
                                autoCapitalize="sentences"
                              />
                              <View style={styles.catEditorIconos}>
                                {ICONOS_ETIQUETA.map((icono) =>
                                  chipPresupuesto(
                                    `icono-${filaKey}-${icono || 'ninguno'}`,
                                    icono || '—',
                                    editorIconoDraft === icono,
                                    () => setEditorIconoDraft(icono)
                                  )
                                )}
                              </View>
                              <View
                                style={styles.catEditorAcciones}
                                lightColor="transparent"
                                darkColor="transparent"
                              >
                                <TouchableOpacity
                                  accessibilityRole="button"
                                  onPress={() =>
                                    void guardarEtiquetaEditor(etiqueta.id)
                                  }
                                  disabled={editorSaving}
                                >
                                  <Text
                                    style={styles.catEditorGuardar}
                                    lightColor="#4338ca"
                                    darkColor="#a5b4fc"
                                  >
                                    Guardar
                                  </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  accessibilityRole="button"
                                  onPress={cancelarEdicionCatalogo}
                                  disabled={editorSaving}
                                >
                                  <Text
                                    style={styles.catEditorCancelar}
                                    lightColor="#6b7280"
                                    darkColor="#9ca3af"
                                  >
                                    Cancelar
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            </View>
                          ) : (
                            <View
                              key={filaKey}
                              style={styles.catEditorFila}
                              lightColor="transparent"
                              darkColor="transparent"
                            >
                              <Text
                                style={styles.catEditorNombre}
                                lightColor="#111827"
                                darkColor="#f9fafb"
                              >
                                {textoEtiqueta(etiqueta)}
                              </Text>
                              <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() =>
                                  iniciarEdicionCatalogo(
                                    filaKey,
                                    etiqueta.nombre,
                                    etiqueta.icono ?? ''
                                  )
                                }
                                disabled={editorSaving}
                                style={styles.catEditorAccionMini}
                              >
                                <Text style={styles.catEditorAccionEmoji}>
                                  ✏️
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() => eliminarEtiquetaEditor(etiqueta)}
                                disabled={editorSaving}
                                style={styles.catEditorAccionMini}
                              >
                                <Text
                                  style={styles.catEditorAccionEmojiEliminar}
                                >
                                  🗑️
                                </Text>
                              </TouchableOpacity>
                            </View>
                          );
                        })
                      )}

                      <Text
                        style={styles.catEditorHint}
                        lightColor="#9ca3af"
                        darkColor="#6b7280"
                      >
                        Sin icono se muestra con el # clásico. Las etiquetas de
                        fábrica (🐜 🏠) se vuelven a crear si faltan.
                      </Text>
                    </>
                  ) : null}

                  {catEditorTab === 'categorias' ? (
                    <>
                      <View style={styles.catEditorCrear}>
                        <TextInput
                          style={[inputStyle, styles.catEditorInput]}
                          value={editorNuevoNombre}
                          onChangeText={setEditorNuevoNombre}
                          placeholder="Nueva categoría (ej: Alimentos)"
                          placeholderTextColor={
                            colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                          }
                          autoCapitalize="sentences"
                        />
                        <TouchableOpacity
                          accessibilityRole="button"
                          onPress={() => void crearCategoriaEditor()}
                          disabled={editorSaving}
                          style={styles.catEditorAgregar}
                        >
                          <Text style={styles.catEditorAgregarTexto}>
                            ＋ Agregar
                          </Text>
                        </TouchableOpacity>
                      </View>

                      {editorCategorias.length === 0 ? (
                        <Text
                          style={styles.presDetalleVacio}
                          lightColor="#6b7280"
                          darkColor="#9ca3af"
                        >
                          Aún no hay categorías.
                        </Text>
                      ) : (
                        editorCategorias.map((cat) => {
                          const filaKey = `categoria-${cat.id}`;
                          if (cat.global) {
                            return (
                              <View
                                key={filaKey}
                                style={styles.catEditorFila}
                                lightColor="transparent"
                                darkColor="transparent"
                              >
                                <Text
                                  style={styles.catEditorNombre}
                                  lightColor="#94a3b8"
                                  darkColor="#94a3b8"
                                >
                                  🔒 {cat.nombre}
                                </Text>
                              </View>
                            );
                          }
                          return editorEditKey === filaKey ? (
                            <View
                              key={filaKey}
                              style={styles.catEditorEdicion}
                              lightColor="transparent"
                              darkColor="transparent"
                            >
                              <TextInput
                                style={[inputStyle, styles.campoSecundario]}
                                value={editorNombreDraft}
                                onChangeText={setEditorNombreDraft}
                                placeholder="Nombre de la categoría"
                                placeholderTextColor={
                                  colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                                }
                                autoCapitalize="sentences"
                              />
                              <View
                                style={styles.catEditorAcciones}
                                lightColor="transparent"
                                darkColor="transparent"
                              >
                                <TouchableOpacity
                                  accessibilityRole="button"
                                  onPress={() =>
                                    void guardarCategoriaEditor(cat.id)
                                  }
                                  disabled={editorSaving}
                                >
                                  <Text
                                    style={styles.catEditorGuardar}
                                    lightColor="#4338ca"
                                    darkColor="#a5b4fc"
                                  >
                                    Guardar
                                  </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  accessibilityRole="button"
                                  onPress={cancelarEdicionCatalogo}
                                  disabled={editorSaving}
                                >
                                  <Text
                                    style={styles.catEditorCancelar}
                                    lightColor="#6b7280"
                                    darkColor="#9ca3af"
                                  >
                                    Cancelar
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            </View>
                          ) : (
                            <View
                              key={filaKey}
                              style={styles.catEditorFila}
                              lightColor="transparent"
                              darkColor="transparent"
                            >
                              <Text
                                style={styles.catEditorNombre}
                                lightColor="#111827"
                                darkColor="#f9fafb"
                              >
                                {cat.nombre}
                              </Text>
                              <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() =>
                                  iniciarEdicionCatalogo(filaKey, cat.nombre)
                                }
                                disabled={editorSaving}
                                style={styles.catEditorAccionMini}
                              >
                                <Text style={styles.catEditorAccionEmoji}>
                                  ✏️
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                accessibilityRole="button"
                                onPress={() => eliminarCategoriaEditor(cat)}
                                disabled={editorSaving}
                                style={styles.catEditorAccionMini}
                              >
                                <Text
                                  style={styles.catEditorAccionEmojiEliminar}
                                >
                                  🗑️
                                </Text>
                              </TouchableOpacity>
                            </View>
                          );
                        })
                      )}

                      <Text
                        style={styles.catEditorHint}
                        lightColor="#9ca3af"
                        darkColor="#6b7280"
                      >
                        🔒 = compartida para todos los usuarios (solo lectura).
                        Puedes crear y editar las tuyas.
                      </Text>
                    </>
                  ) : null}

                  {catEditorTab === 'subcategorias' ? (
                    <>
                      <Text style={styles.presSeccion}>
                        Categoría padre (tuya)
                      </Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.chipFila}
                      >
                        {editorCategorias
                          .filter((cat) => !cat.global)
                          .map((cat) =>
                            chipPresupuesto(
                              `padre-${cat.id}`,
                              cat.nombre,
                              editorSubPadre === cat.id,
                              () => setEditorSubPadre(cat.id)
                            )
                          )}
                      </ScrollView>
                      {editorCategorias.filter((cat) => !cat.global).length ===
                      0 ? (
                        <Text
                          style={styles.catEditorHint}
                          lightColor="#9ca3af"
                          darkColor="#6b7280"
                        >
                          Primero crea una categoría propia en la pestaña
                          "Categorías".
                        </Text>
                      ) : null}

                      <View style={styles.catEditorCrear}>
                        <TextInput
                          style={[inputStyle, styles.catEditorInput]}
                          value={editorNuevoNombre}
                          onChangeText={setEditorNuevoNombre}
                          placeholder="Nueva subcategoría (ej: Supermercado)"
                          placeholderTextColor={
                            colorScheme === 'dark' ? '#9ca3af' : '#6b7280'
                          }
                          autoCapitalize="sentences"
                        />
                        <TouchableOpacity
                          accessibilityRole="button"
                          onPress={() => void crearSubcategoriaEditor()}
                          disabled={editorSaving}
                          style={styles.catEditorAgregar}
                        >
                          <Text style={styles.catEditorAgregarTexto}>
                            ＋ Agregar
                          </Text>
                        </TouchableOpacity>
                      </View>

                      <Text style={styles.presSeccion}>Subcategorías</Text>
                      {editorSubcats.length === 0 ? (
                        <Text
                          style={styles.presDetalleVacio}
                          lightColor="#6b7280"
                          darkColor="#9ca3af"
                        >
                          Aún no hay subcategorías.
                        </Text>
                      ) : (
                        editorCategorias.map((cat) => {
                          const subsDeCat = editorSubcats.filter(
                            (sub) => sub.categoriaId === cat.id
                          );
                          if (subsDeCat.length === 0) return null;
                          return (
                            <View
                              key={`grupo-${cat.id}`}
                              lightColor="transparent"
                              darkColor="transparent"
                            >
                              <Text style={styles.presSeccion}>
                                {cat.global ? '🔒 ' : ''}
                                {cat.nombre}
                              </Text>
                              {subsDeCat.map((sub) => {
                                const filaKey = `sub-${sub.id}`;
                                return editorEditKey === filaKey ? (
                                  <View
                                    key={filaKey}
                                    style={styles.catEditorEdicion}
                                    lightColor="transparent"
                                    darkColor="transparent"
                                  >
                                    <TextInput
                                      style={[
                                        inputStyle,
                                        styles.campoSecundario,
                                      ]}
                                      value={editorNombreDraft}
                                      onChangeText={setEditorNombreDraft}
                                      placeholder="Nombre de la subcategoría"
                                      placeholderTextColor={
                                        colorScheme === 'dark'
                                          ? '#9ca3af'
                                          : '#6b7280'
                                      }
                                      autoCapitalize="sentences"
                                    />
                                    <View
                                      style={styles.catEditorAcciones}
                                      lightColor="transparent"
                                      darkColor="transparent"
                                    >
                                      <TouchableOpacity
                                        accessibilityRole="button"
                                        onPress={() =>
                                          void guardarSubcategoriaEditor(sub.id)
                                        }
                                        disabled={editorSaving}
                                      >
                                        <Text
                                          style={styles.catEditorGuardar}
                                          lightColor="#4338ca"
                                          darkColor="#a5b4fc"
                                        >
                                          Guardar
                                        </Text>
                                      </TouchableOpacity>
                                      <TouchableOpacity
                                        accessibilityRole="button"
                                        onPress={cancelarEdicionCatalogo}
                                        disabled={editorSaving}
                                      >
                                        <Text
                                          style={styles.catEditorCancelar}
                                          lightColor="#6b7280"
                                          darkColor="#9ca3af"
                                        >
                                          Cancelar
                                        </Text>
                                      </TouchableOpacity>
                                    </View>
                                  </View>
                                ) : (
                                  <View
                                    key={filaKey}
                                    style={styles.catEditorFila}
                                    lightColor="transparent"
                                    darkColor="transparent"
                                  >
                                    <Text
                                      style={
                                        sub.editable
                                          ? styles.catEditorNombre
                                          : styles.catEditorNombreGlobal
                                      }
                                      lightColor={
                                        sub.editable ? '#111827' : '#94a3b8'
                                      }
                                      darkColor={
                                        sub.editable ? '#f9fafb' : '#94a3b8'
                                      }
                                    >
                                      {sub.nombre}
                                    </Text>
                                    {sub.editable ? (
                                      <>
                                        <TouchableOpacity
                                          accessibilityRole="button"
                                          onPress={() =>
                                            iniciarEdicionCatalogo(
                                              filaKey,
                                              sub.nombre
                                            )
                                          }
                                          disabled={editorSaving}
                                          style={styles.catEditorAccionMini}
                                        >
                                          <Text
                                            style={styles.catEditorAccionEmoji}
                                          >
                                            ✏️
                                          </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                          accessibilityRole="button"
                                          onPress={() =>
                                            eliminarSubcategoriaEditor(sub)
                                          }
                                          disabled={editorSaving}
                                          style={styles.catEditorAccionMini}
                                        >
                                          <Text
                                            style={
                                              styles.catEditorAccionEmojiEliminar
                                            }
                                          >
                                            🗑️
                                          </Text>
                                        </TouchableOpacity>
                                      </>
                                    ) : null}
                                  </View>
                                );
                              })}
                            </View>
                          );
                        })
                      )}

                      <Text
                        style={styles.catEditorHint}
                        lightColor="#9ca3af"
                        darkColor="#6b7280"
                      >
                        Las subcategorías viven bajo categorías propias, así que
                        solo se crean y editan ahí.
                      </Text>
                    </>
                  ) : null}

                  <View
                    style={styles.nameActions}
                    lightColor="transparent"
                    darkColor="transparent"
                  >
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => setCatEditorAbierto(false)}
                      disabled={editorSaving}
                      style={styles.confirmButton}
                    >
                      <Text style={styles.confirmText}>Listo</Text>
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              )}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {authError ? (
        <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
          {authError}
        </Text>
      ) : null}

      <TouchableOpacity
        accessibilityRole="button"
        onPress={handleSignOut}
        disabled={signingOut}
        style={styles.signOutButton}
      >
        <Text style={styles.signOutText}>
          {signingOut ? 'Cerrando sesión...' : 'Cerrar sesión'}
        </Text>
      </TouchableOpacity>
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
    justifyContent: 'center',
  },
  heading: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 16,
    marginTop: 6,
    marginBottom: 12,
  },
  themeButton: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginBottom: 16,
    backgroundColor: '#e0e7ff',
  },
  themeButtonText: {
    color: '#4338ca',
    fontWeight: '600',
  },
  card: {
    borderRadius: 16,
    padding: 24,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 12,
  },
  avatarImage: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignSelf: 'center',
    marginBottom: 12,
  },
  avatarText: {
    color: '#4f46e5',
    fontSize: 30,
    fontWeight: 'bold',
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
    marginBottom: 16,
  },
  avatarModal: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignSelf: 'center',
    marginBottom: 10,
  },
  avatarModalFallback: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 10,
  },
  modalError: {
    fontSize: 13,
    marginBottom: 10,
    textAlign: 'center',
  },
  avatarBusy: {
    marginTop: 4,
    marginBottom: 12,
  },
  avatarActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 12,
  },
  avatarButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  avatarActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  name: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  editNameButton: {
    alignSelf: 'center',
    paddingVertical: 6,
  },
  editNameText: {
    fontSize: 14,
    fontWeight: '600',
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
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 10,
  },
  separator: {
    height: 1,
    marginVertical: 20,
  },
  infoRow: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    marginBottom: 4,
  },
  value: {
    fontSize: 16,
  },
  cuentasHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 24,
    marginBottom: 12,
  },
  balanceHeading: {
    fontSize: 20,
    fontWeight: '600',
  },
  addToggle: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  addToggleText: {
    color: '#4f46e5',
    fontWeight: '600',
    fontSize: 15,
  },
  addCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  campoSecundario: {
    marginTop: 10,
  },
  creditoCampos: {
    marginTop: 10,
  },
  creditoDiasFila: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  creditoDiaInput: {
    flex: 1,
  },
  creditoAyuda: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  tipoEtiqueta: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
    color: '#9ca3af',
  },
  tipoFila: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  tipoChip: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  tipoChipActivo: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: '#4f46e5',
  },
  tipoChipTexto: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  tipoChipTextoActivo: {
    color: '#ffffff',
  },
  saveAccountButton: {
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#4f46e5',
  },
  saveAccountText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  totalCuentasRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(148, 163, 184, 0.4)',
  },
  totalCuentasEtiqueta: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  totalCuentasValor: {
    fontSize: 18,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  balanceCard: {
    borderRadius: 16,
    padding: 20,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    gap: 12,
  },
  accountInfo: {
    flex: 1,
  },
  accountName: {
    fontSize: 15,
    fontWeight: '600',
  },
  accountSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  accountRight: {
    alignItems: 'flex-end',
  },
  balanceValue: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  creditoLinea: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 1,
  },
  removeText: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  emptyBalance: {
    fontSize: 15,
  },
  retryButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
  },
  retryText: {
    color: '#4f46e5',
    fontWeight: '600',
  },
  error: {
    color: '#b91c1c',
    marginTop: 16,
  },
  errorInline: {
    fontSize: 15,
    textAlign: 'left',
    marginBottom: 8,
  },
  signOutButton: {
    alignItems: 'center',
    padding: 14,
    marginTop: 16,
    borderRadius: 10,
    backgroundColor: '#4f46e5',
  },
  signOutText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  // ---- Presupuestos ----
  presSeccionIntro: {
    marginTop: -6,
    marginBottom: 12,
    fontSize: 13,
  },
  presLoader: {
    marginBottom: 12,
  },
  presBanner: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  presBannerText: {
    fontSize: 14,
    fontWeight: '600',
  },
  presCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  presCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  presCardInfo: {
    flex: 1,
  },
  presNombre: {
    fontSize: 16,
    fontWeight: '600',
  },
  presAlcance: {
    fontSize: 12,
    marginTop: 2,
  },
  presMontos: {
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  presBarraTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(148, 163, 184, 0.35)',
    marginTop: 12,
    overflow: 'hidden',
  },
  presBarraFill: {
    height: 6,
    borderRadius: 999,
  },
  presCardPie: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  presPct: {
    fontSize: 13,
    fontWeight: '700',
  },
  presAcciones: {
    flexDirection: 'row',
    gap: 16,
  },
  presAccion: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4f46e5',
  },
  presAccionEliminar: {
    fontSize: 13,
    fontWeight: '600',
    color: '#b91c1c',
  },
  presDetalleSub: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: -8,
  },
  presDetalleTotales: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 6,
  },
  presDetalleSeparator: {
    height: 1,
    marginVertical: 10,
  },
  presDetalleLista: {
    maxHeight: 320,
  },
  presDetalleVacio: {
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 16,
  },
  presTrxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    gap: 12,
  },
  presTrxComercio: {
    fontSize: 14,
    fontWeight: '600',
  },
  presTrxSub: {
    fontSize: 12,
    marginTop: 2,
  },
  presTrxMonto: {
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  presDetalleAcciones: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 18,
    marginTop: 8,
  },
  presDetalleBoton: {
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  presFormScroll: {
    maxHeight: 520,
  },
  presFormScrollContent: {},
  presPresets: {
    marginBottom: 4,
  },
  presSeccion: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 10,
    marginBottom: 6,
    color: '#9ca3af',
  },
  chipFila: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  // ---- Editor de catálogo ----
  catEditorCrear: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  catEditorInput: {
    flex: 1,
  },
  catEditorAgregar: {
    backgroundColor: '#e0e7ff',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  catEditorAgregarTexto: {
    color: '#4338ca',
    fontWeight: '600',
  },
  catEditorIconos: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  catEditorFila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  catEditorNombre: {
    flex: 1,
    fontSize: 14,
  },
  catEditorNombreGlobal: {
    flex: 1,
    fontSize: 14,
  },
  catEditorAccionMini: {
    paddingHorizontal: 2,
  },
  catEditorAccionEmoji: {
    fontSize: 14,
  },
  catEditorAccionEmojiEliminar: {
    fontSize: 14,
  },
  catEditorEdicion: {
    paddingVertical: 6,
    gap: 6,
  },
  catEditorAcciones: {
    flexDirection: 'row',
    gap: 14,
  },
  catEditorGuardar: {
    fontSize: 13,
    fontWeight: '600',
  },
  catEditorCancelar: {
    fontSize: 13,
  },
  catEditorHint: {
    fontSize: 12,
    marginTop: 2,
  },
});
