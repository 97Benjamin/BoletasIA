import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';
import * as ImagePicker from 'expo-image-picker';
import { formatearMontoEnEntrada, limpiarMontoParaEstado } from '@/src/utils/moneda-formato';
import { File, UploadType } from 'expo-file-system';

import { Text, View } from '@/components/Themed';
import { useThemeMode } from '@/components/ThemeMode';
import SelectorFecha from '@/components/SelectorFecha';
import { supabase } from '@/src/services/supabase';
import { notificarCambio } from '@/src/utils/cambios';
import { formatChileanPesos } from '@/src/utils/currency';

type SelectOption = { id: number; name: string; icono?: string | null };
type SubcategoryOption = SelectOption & { categoryId: number };
type AccountOption = SelectOption & { type: string; bank: string | null };
type ExtractedItem = {
  producto: string;
  precio: number;
  categoria?: string;
};
type ReceiptPreview = {
  comercio: string;
  categoria_general: string;
  fecha: string;
  total: number;
  items: ExtractedItem[];
};
type ReviewItem = {
  product: string;
  price: string;
  categoryId: string;
  subcategoryId: string;
  tagIds: number[];
  newSubcategoryName: string;
  newTagName: string;
};
type ReceiptReview = {
  merchant: string;
  date: string;
  total: string;
  categoryId: string;
  subcategoryId: string;
  accountId: string;
  items: ReviewItem[];
};
type SavedReceipt = { transactionId: number | string; message: string };

const apiBaseUrl = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readOptions(
  value: unknown,
  nameField: string
): Array<
  SelectOption & { categoryId?: number; type?: string; bank?: string | null }
> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    const id = row?.id;
    const name = row?.[nameField];
    if (
      !row ||
      typeof id !== 'number' ||
      typeof name !== 'string' ||
      !name.trim()
    ) {
      return [];
    }
    return [
      {
        id,
        name: name.trim(),
        ...(typeof row.icono === 'string' && row.icono.trim()
          ? { icono: row.icono.trim() }
          : {}),
        ...(typeof row.categoria_id === 'number'
          ? { categoryId: row.categoria_id }
          : {}),
        ...(typeof row.tipo === 'string' ? { type: row.tipo } : {}),
        ...(typeof row.banco === 'string' || row.banco === null
          ? { bank: row.banco }
          : {}),
      },
    ];
  });
}

function readAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }
  return null;
}

function inputAmount(value: string) {
  const normalized = value.trim().replace(/\s/g, '');
  const decimalValue = normalized.includes(',')
    ? normalized.replace(/\./g, '').replace(',', '.')
    : normalized;
  const amount = Number(decimalValue);
  return Number.isFinite(amount) ? amount : null;
}

function isReceiptPreview(
  value: unknown
): value is { datos_extraidos: ReceiptPreview } {
  const record = asRecord(value);
  const receipt = asRecord(record?.datos_extraidos);
  return (
    receipt !== null &&
    typeof receipt.comercio === 'string' &&
    typeof receipt.categoria_general === 'string' &&
    typeof receipt.fecha === 'string' &&
    readAmount(receipt.total) !== null &&
    Array.isArray(receipt.items) &&
    receipt.items.every((item) => {
      const itemRecord = asRecord(item);
      return (
        itemRecord !== null &&
        typeof itemRecord.producto === 'string' &&
        readAmount(itemRecord.precio) !== null &&
        (itemRecord.categoria === undefined ||
          typeof itemRecord.categoria === 'string')
      );
    })
  );
}

function errorDetail(value: unknown) {
  const record = asRecord(value);
  if (record && 'detail' in record) {
    return typeof record.detail === 'string'
      ? record.detail
      : JSON.stringify(record.detail);
  }
  return 'El servidor respondió con un error.';
}

function textInputStyle(isDark: boolean) {
  return [
    styles.input,
    {
      color: isDark ? '#f9fafb' : '#111827',
      backgroundColor: isDark ? '#111827' : '#f9fafb',
      borderColor: isDark ? '#4b5563' : '#d1d5db',
    },
  ];
}

export default function ScanReceiptScreen() {
  const { colorScheme } = useThemeMode();
  const isDark = colorScheme === 'dark';
  const [image, setImage] = useState<ImagePickerAsset | null>(null);
  const [review, setReview] = useState<ReceiptReview | null>(null);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [categories, setCategories] = useState<SelectOption[]>([]);
  const [subcategories, setSubcategories] = useState<SubcategoryOption[]>([]);
  const [tags, setTags] = useState<SelectOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [creatingOption, setCreatingOption] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<SavedReceipt | null>(null);

  async function chooseImage() {
    setError('');
    setSaved(null);
    setReview(null);

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setError('Debes permitir el acceso a tus fotos para seleccionar una boleta.');
        return;
      }

      const selection = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.85,
      });
      if (!selection.canceled) setImage(selection.assets[0] ?? null);
    } catch (pickerError: unknown) {
      setError(
        `No se pudo abrir la galería: ${
          pickerError instanceof Error
            ? pickerError.message
            : 'Error desconocido'
        }`
      );
    }
  }

  async function takePhoto() {
    setError('');
    setSaved(null);
    setReview(null);

    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError('Debes permitir el acceso a la cámara para fotografiar una boleta.');
        return;
      }

      const capture = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.85,
      });
      if (!capture.canceled) setImage(capture.assets[0] ?? null);
    } catch (cameraError: unknown) {
      setError(
        `No se pudo abrir la cámara: ${
          cameraError instanceof Error
            ? cameraError.message
            : 'Error desconocido'
        }`
      );
    }
  }

  async function requestApi(
    path: string,
    token: string,
    body: FormData | string,
    isJson: boolean
  ) {
    if (!apiBaseUrl) {
      throw new Error(
        'Falta configurar EXPO_PUBLIC_API_URL con la dirección del backend FastAPI.'
      );
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(apiBaseUrl);
    } catch {
      throw new Error('EXPO_PUBLIC_API_URL debe ser una dirección HTTP o HTTPS válida.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('EXPO_PUBLIC_API_URL debe usar HTTP o HTTPS.');
    }
    if (
      parsedUrl.hostname === 'supabase.co' ||
      parsedUrl.hostname.endsWith('.supabase.co')
    ) {
      throw new Error(
        'EXPO_PUBLIC_API_URL debe apuntar a FastAPI, no al proyecto Supabase.'
      );
    }

    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(isJson ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        asRecord(payload)
          ? errorDetail(payload)
          : `El servidor respondió con el estado ${response.status}.`
      );
    }
    return payload;
  }

  async function requestReceiptUpload(
    path: string,
    token: string,
    asset: ImagePickerAsset,
    mimeType: string,
    fileName: string
  ) {
    // En nativo, el fetch de Expo (SDK 57) no soporta partes de FormData por
    // uri ({ uri, name, type }), lanza "Unsupported FormDataPart
    // implementation". La subida se hace con la API de FileSystem
    // (multipart nativo), que bypassa ese conversor.
    if (!apiBaseUrl) {
      throw new Error(
        'Falta configurar EXPO_PUBLIC_API_URL con la dirección del backend FastAPI.'
      );
    }
    try {
      const parsedUrl = new URL(apiBaseUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('EXPO_PUBLIC_API_URL debe usar HTTP o HTTPS.');
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('EXPO_PUBLIC_API_URL')) {
        throw error;
      }
      throw new Error('EXPO_PUBLIC_API_URL debe ser una dirección HTTP o HTTPS válida.');
    }

    const receiptFile = new File(asset.uri);
    const upload = await receiptFile.upload(`${apiBaseUrl}${path}`, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType,
      headers: { Authorization: `Bearer ${token}` },
    });
    let payload: unknown = null;
    try {
      payload = JSON.parse(upload.body) as unknown;
    } catch {
      payload = null;
    }
    if (upload.status < 200 || upload.status >= 300) {
      throw new Error(
        asRecord(payload)
          ? errorDetail(payload)
          : `El servidor respondió con el estado ${upload.status}.`
      );
    }
    return payload;
  }

  async function loadCatalog(userId: string, preferredCategory: string) {
    const [accountResult, categoryResult, subcategoryResult, tagResult] =
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
        supabase.from('subcategorias').select('id, nombre, categoria_id').order('nombre'),
        supabase
          .from('etiquetas')
          .select('id, nombre, icono')
          .eq('user_id', userId)
          .order('nombre'),
      ]);

    const catalogError =
      accountResult.error ??
      categoryResult.error ??
      subcategoryResult.error ??
      tagResult.error;
    if (catalogError) {
      throw new Error(
        `No se pudieron cargar cuentas, categorías, subcategorías o etiquetas: ${catalogError.message}`
      );
    }

    const accountOptions = readOptions(accountResult.data, 'nombre').map(
      (account): AccountOption => ({
        id: account.id,
        name: account.name,
        type: account.type ?? '',
        bank: account.bank ?? null,
      })
    );
    const categoryOptions = readOptions(categoryResult.data, 'nombre');
    const subcategoryOptions = readOptions(
      subcategoryResult.data,
      'nombre'
    ).flatMap((subcategory) =>
      subcategory.categoryId === undefined
        ? []
        : [{ ...subcategory, categoryId: subcategory.categoryId }]
    );
    const tagOptions = readOptions(tagResult.data, 'nombre');

    setAccounts(accountOptions);
    setCategories(categoryOptions);
    setSubcategories(subcategoryOptions);
    setTags(tagOptions);

    const suggestedCategory = categoryOptions.find(
      (category) =>
        category.name.toLocaleLowerCase() ===
        preferredCategory.toLocaleLowerCase()
    );
    return { accountOptions, categoryOptions, suggestedCategory };
  }

  async function analyzeReceipt() {
    if (!image) {
      setError('Primero selecciona una foto de la boleta.');
      return;
    }
    setError('');
    setReview(null);
    setSaved(null);
    setBusy(true);

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.refreshSession();
      if (sessionError) {
        throw new Error(`No se pudo renovar la sesión: ${sessionError.message}`);
      }
      if (!session?.access_token) {
        throw new Error('Debes iniciar sesión antes de analizar una boleta.');
      }

      const mimeType = image.mimeType ?? image.file?.type ?? 'image/jpeg';
      const fileName =
        image.fileName?.trim() ||
        `boleta-${Date.now()}.${mimeType.split('/')[1] ?? 'jpg'}`;

      let payload: unknown;
      if (Platform.OS === 'web') {
        if (!image.file) throw new Error('No se pudo leer la imagen seleccionada.');
        const formData = new FormData();
        formData.append('file', image.file, fileName);
        payload = await requestApi(
          '/gastos/procesar-boleta',
          session.access_token,
          formData,
          false
        );
      } else {
        payload = await requestReceiptUpload(
          '/gastos/procesar-boleta',
          session.access_token,
          image,
          mimeType,
          fileName
        );
      }
      if (!isReceiptPreview(payload)) {
        throw new Error('El servidor devolvió datos incompletos para la boleta.');
      }

      const receipt = payload.datos_extraidos;
      const total = readAmount(receipt.total);
      if (total === null) throw new Error('El total extraído no es válido.');

      const { accountOptions, categoryOptions, suggestedCategory } =
        await loadCatalog(session.user.id, receipt.categoria_general);
      setReview({
        merchant: receipt.comercio,
        date: receipt.fecha,
        total: String(total),
        categoryId: suggestedCategory ? String(suggestedCategory.id) : '',
        subcategoryId: '',
        accountId: accountOptions.length === 1 ? String(accountOptions[0].id) : '',
        items: receipt.items.map((item) => {
          const itemPrice = readAmount(item.precio);
          if (typeof item.producto !== 'string' || itemPrice === null) {
            throw new Error('El análisis devolvió un artículo con datos inválidos.');
          }
          return {
            product: item.producto,
            price: String(itemPrice),
            categoryId:
              categoryOptions.find(
                (category) =>
                  category.name.toLocaleLowerCase() ===
                  item.categoria?.toLocaleLowerCase()
              )?.id.toString() ??
              (suggestedCategory ? String(suggestedCategory.id) : ''),
            subcategoryId: '',
            tagIds: [],
            newSubcategoryName: '',
            newTagName: '',
          };
        }),
      });
    } catch (analysisError: unknown) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : 'No se pudo analizar la boleta.'
      );
    } finally {
      setBusy(false);
    }
  }

  function patchReview(changes: Partial<ReceiptReview>) {
    setReview((current) => (current ? { ...current, ...changes } : current));
  }

  function patchItem(index: number, changes: Partial<ReviewItem>) {
    setReview((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item, itemIndex) =>
              itemIndex === index ? { ...item, ...changes } : item
            ),
          }
        : current
    );
  }

  async function createSubcategory(index: number) {
    if (!review) return;
    const item = review.items[index];
    const name = item?.newSubcategoryName.trim();
    if (!item?.categoryId) {
      setError('Selecciona una categoría para el artículo antes de crear su subcategoría.');
      return;
    }
    if (!name) {
      setError('Escribe el nombre de la subcategoría que quieres crear.');
      return;
    }

    const existing = availableSubcategories(item.categoryId).find(
      (subcategory) =>
        subcategory.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (existing) {
      patchItem(index, {
        subcategoryId: String(existing.id),
        newSubcategoryName: '',
      });
      setError('');
      return;
    }

    setError('');
    setCreatingOption(`subcategory-${index}`);
    try {
      const { data, error: authError } = await supabase.auth.getUser();
      if (authError) {
        throw new Error(`No se pudo validar la sesión: ${authError.message}`);
      }
      if (!data.user) {
        throw new Error('Debes iniciar sesión antes de crear una subcategoría.');
      }

      const { data: created, error: insertError } = await supabase
        .from('subcategorias')
        .insert({ nombre: name, categoria_id: Number(item.categoryId) })
        .select('id, nombre, categoria_id')
        .single();
      if (insertError) {
        throw new Error(`No se pudo crear la subcategoría: ${insertError.message}`);
      }

      const createdRecord = asRecord(created);
      if (
        typeof createdRecord?.id !== 'number' ||
        typeof createdRecord.nombre !== 'string' ||
        typeof createdRecord.categoria_id !== 'number'
      ) {
        throw new Error('La base de datos no confirmó la subcategoría creada.');
      }

      const createdSubcategory: SubcategoryOption = {
        id: createdRecord.id,
        name: createdRecord.nombre,
        categoryId: createdRecord.categoria_id,
      };
      setSubcategories((current) =>
        [...current, createdSubcategory].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      );
      patchItem(index, {
        subcategoryId: String(createdSubcategory.id),
        newSubcategoryName: '',
      });
      // Los demás tabs muestran subcategorías en sus chips y selects.
      notificarCambio();
    } catch (createError: unknown) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'No se pudo crear la subcategoría.'
      );
    } finally {
      setCreatingOption(null);
    }
  }

  async function createTag(index: number) {
    if (!review) return;
    const item = review.items[index];
    const name = item?.newTagName.trim();
    if (!name) {
      setError('Escribe el nombre de la etiqueta que quieres crear.');
      return;
    }

    const existing = tags.find(
      (tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (existing) {
      patchItem(index, {
        tagIds: item.tagIds.includes(existing.id)
          ? item.tagIds
          : [...item.tagIds, existing.id],
        newTagName: '',
      });
      setError('');
      return;
    }

    setError('');
    setCreatingOption(`tag-${index}`);
    try {
      const { data, error: authError } = await supabase.auth.getUser();
      if (authError) {
        throw new Error(`No se pudo validar la sesión: ${authError.message}`);
      }
      if (!data.user) {
        throw new Error('Debes iniciar sesión antes de crear una etiqueta.');
      }

      const { data: created, error: insertError } = await supabase
        .from('etiquetas')
        .insert({ nombre: name, user_id: data.user.id })
        .select('id, nombre')
        .single();
      if (insertError) {
        throw new Error(`No se pudo crear la etiqueta: ${insertError.message}`);
      }

      const createdRecord = asRecord(created);
      if (
        typeof createdRecord?.id !== 'number' ||
        typeof createdRecord.nombre !== 'string'
      ) {
        throw new Error('La base de datos no confirmó la etiqueta creada.');
      }

      const createdTag: SelectOption = {
        id: createdRecord.id,
        name: createdRecord.nombre,
      };
      setTags((current) =>
        [...current, createdTag].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      );
      patchItem(index, {
        tagIds: [...item.tagIds, createdTag.id],
        newTagName: '',
      });
      // Los demás tabs muestran etiquetas con icono en sus chips.
      notificarCambio();
    } catch (createError: unknown) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'No se pudo crear la etiqueta.'
      );
    } finally {
      setCreatingOption(null);
    }
  }

  async function confirmReceipt() {
    if (!review || creatingOption) return;
    const parsedTotal = inputAmount(limpiarMontoParaEstado(review.total));
    if (!review.merchant.trim()) {
      setError('Ingresa el nombre del comercio.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(review.date)) {
      setError('Ingresa una fecha válida con formato AAAA-MM-DD.');
      return;
    }
    if (parsedTotal === null || parsedTotal <= 0) {
      setError('El total debe ser mayor que cero.');
      return;
    }
    if (!review.accountId) {
      setError('Selecciona la cuenta donde se registrará el gasto.');
      return;
    }
    const items = review.items.map((item) => ({
      producto: item.product.trim(),
      precio: inputAmount(limpiarMontoParaEstado(item.price)),
      categoria_id: item.categoryId ? Number(item.categoryId) : null,
      subcategoria_id: item.subcategoryId ? Number(item.subcategoryId) : null,
      etiqueta_ids: item.tagIds,
    }));
    if (
      items.some(
        (item) =>
          !item.producto ||
          item.precio === null ||
          item.precio < 0 ||
          (item.subcategoria_id !== null && item.categoria_id === null)
      )
    ) {
      setError('Revisa los nombres, precios y categorías de los artículos.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.refreshSession();
      if (sessionError) {
        throw new Error(`No se pudo renovar la sesión: ${sessionError.message}`);
      }
      if (!session?.access_token) {
        throw new Error('Debes iniciar sesión antes de guardar la boleta.');
      }

      const payload = await requestApi(
        '/gastos/confirmar-boleta',
        session.access_token,
        JSON.stringify({
          cuenta_id: Number(review.accountId),
          comercio: review.merchant.trim(),
          fecha: review.date,
          total: parsedTotal,
          categoria_id: review.categoryId ? Number(review.categoryId) : null,
          subcategoria_id: review.subcategoryId
            ? Number(review.subcategoryId)
            : null,
          items,
        }),
        true
      );
      const savedPayload = asRecord(payload);
      if (
        !savedPayload ||
        (typeof savedPayload.transaccion_id !== 'number' &&
          typeof savedPayload.transaccion_id !== 'string')
      ) {
        throw new Error('El servidor no confirmó el guardado de la transacción.');
      }
      setSaved({
        transactionId: savedPayload.transaccion_id,
        message:
          typeof savedPayload.mensaje === 'string'
            ? savedPayload.mensaje
            : 'Boleta confirmada y guardada.',
      });
      setReview(null);
      setImage(null);
      // Gasto guardado: Movimientos, Rápidos y Presupuestos deben recalcular
      // sin recargar la página.
      notificarCambio();
    } catch (saveError: unknown) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'No se pudo guardar la boleta confirmada.'
      );
    } finally {
      setBusy(false);
    }
  }

  const availableSubcategories = (categoryId: string) =>
    subcategories.filter(
      (subcategory) => String(subcategory.categoryId) === categoryId
    );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Escanear boleta</Text>
      <Text style={styles.subtitle} lightColor="#6b7280" darkColor="#9ca3af">
        Analiza la foto y revisa cada dato. La boleta solo se guarda cuando la confirmes.
      </Text>

      {saved ? (
        <View style={styles.successCard} lightColor="#f0fdf4" darkColor="#052e16">
          <Text style={styles.successText} lightColor="#166534" darkColor="#86efac">
            {saved.message}
          </Text>
          <Text style={styles.successText} lightColor="#166534" darkColor="#86efac">
            Transacción #{saved.transactionId}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setSaved(null)}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Escanear otra boleta</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!review && !saved ? (
        <View style={styles.card} lightColor="#ffffff" darkColor="#1f2937">
          {image ? (
            <Image
              source={{ uri: image.uri }}
              resizeMode="contain"
              style={styles.preview}
              accessibilityLabel="Vista previa de la boleta seleccionada"
            />
          ) : (
            <View
              style={[
                styles.placeholder,
                { backgroundColor: isDark ? '#111827' : '#f3f4f6' },
              ]}
              lightColor="transparent"
              darkColor="transparent"
            >
              <Text style={styles.placeholderIcon}>🧾</Text>
              <Text style={styles.helperText} lightColor="#6b7280" darkColor="#9ca3af">
                Selecciona una foto de tu boleta
              </Text>
            </View>
          )}

          <View style={styles.imageActions} lightColor="transparent" darkColor="transparent">
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => void chooseImage()}
              disabled={busy}
              style={[
                styles.secondaryButton,
                styles.imageActionButton,
                { borderColor: isDark ? '#818cf8' : '#4f46e5' },
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.secondaryButtonText} lightColor="#4338ca" darkColor="#c7d2fe">
                {image ? 'Elegir otra imagen' : 'Elegir de galería'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => void takePhoto()}
              disabled={busy}
              style={[
                styles.secondaryButton,
                styles.imageActionButton,
                { borderColor: isDark ? '#818cf8' : '#4f46e5' },
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.secondaryButtonText} lightColor="#4338ca" darkColor="#c7d2fe">
                Tomar foto
              </Text>
            </TouchableOpacity>
          </View>
          {image ? (
            <Text style={styles.helperText} lightColor="#6b7280" darkColor="#9ca3af">
              {image.fileName ?? 'Imagen seleccionada'}
            </Text>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void analyzeReceipt()}
            disabled={!image || busy}
            style={[styles.primaryButton, (!image || busy) && styles.disabled]}
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryButtonText}>Analizar boleta</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : null}

      {review ? (
        <View style={styles.card} lightColor="#ffffff" darkColor="#1f2937">
          <Text style={styles.sectionHeading}>Revisa la información</Text>
          <Text style={styles.helperText} lightColor="#6b7280" darkColor="#9ca3af">
            Corrige lo necesario antes de guardar. El análisis aún no creó registros.
          </Text>

          <FieldLabel>Comercio</FieldLabel>
          <TextInput
            accessibilityLabel="Comercio"
            value={review.merchant}
            onChangeText={(merchant) => patchReview({ merchant })}
            style={textInputStyle(isDark)}
          />
          <FieldLabel>Fecha (AAAA-MM-DD)</FieldLabel>
          <SelectorFecha
            valor={review.date}
            alCambiar={(v: string) => patchReview({ date: v })}
            contenedorEstilo={textInputStyle(isDark)}
            textoEstilo={{ color: isDark ? '#f9fafb' : '#111827', fontSize: 16 }}
            accesibilidadLabel="Fecha de la boleta"
            bloquearFuturo
          />
          <FieldLabel>Total de la boleta</FieldLabel>
          <TextInput
            accessibilityLabel="Total de la boleta"
            value={review.total}
            onChangeText={(total) => patchReview({ total: formatearMontoEnEntrada(total) })}
            keyboardType="decimal-pad"
            style={textInputStyle(isDark)}
          />
          <FieldLabel>Cuenta para registrar el gasto</FieldLabel>
          {accounts.length ? (
            <ChoiceList
              options={accounts.map((account) => ({
                id: account.id,
                name: `${account.name} · ${account.type}${account.bank ? ` · ${account.bank}` : ''}`,
              }))}
              selectedId={review.accountId}
              onSelect={(id) => patchReview({ accountId: id })}
              isDark={isDark}
            />
          ) : (
            <Text style={styles.helperText} lightColor="#b91c1c" darkColor="#fca5a5">
              No tienes cuentas disponibles. Crea una cuenta antes de guardar.
            </Text>
          )}

          <FieldLabel>Categoría de la transacción</FieldLabel>
          <ChoiceList
            options={categories}
            selectedId={review.categoryId}
            onSelect={(categoryId) =>
              patchReview({ categoryId, subcategoryId: '' })
            }
            isDark={isDark}
            allowNone
          />
          {availableSubcategories(review.categoryId).length ? (
            <>
              <FieldLabel>Subcategoría de la transacción (opcional)</FieldLabel>
              <ChoiceList
                options={availableSubcategories(review.categoryId)}
                selectedId={review.subcategoryId}
                onSelect={(subcategoryId) =>
                  patchReview({ subcategoryId })
                }
                isDark={isDark}
                allowNone
              />
            </>
          ) : null}

          <Text style={styles.sectionHeading}>Artículos</Text>
          {review.items.map((item, index) => {
            const itemSubcategories = availableSubcategories(item.categoryId);
            return (
              <View
                key={`review-item-${index}`}
                style={styles.itemCard}
                lightColor="#f9fafb"
                darkColor="#111827"
              >
                <View style={styles.itemHeader} lightColor="transparent" darkColor="transparent">
                  <Text style={styles.itemHeading}>Artículo {index + 1}</Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={busy || creatingOption !== null}
                    onPress={() =>
                      patchReview({
                        items: review.items.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  >
                    <Text style={styles.removeText}>Quitar</Text>
                  </TouchableOpacity>
                </View>
                <FieldLabel>Nombre del artículo</FieldLabel>
                <TextInput
                  accessibilityLabel={`Nombre del artículo ${index + 1}`}
                  value={item.product}
                  onChangeText={(product) => patchItem(index, { product })}
                  style={textInputStyle(isDark)}
                />
                <FieldLabel>Precio</FieldLabel>
                <TextInput
                  accessibilityLabel={`Precio del artículo ${index + 1}`}
                  value={item.price}
                  onChangeText={(price) => patchItem(index, { price: formatearMontoEnEntrada(price) })}
                  keyboardType="decimal-pad"
                  style={textInputStyle(isDark)}
                />
                <FieldLabel>Categoría del artículo</FieldLabel>
                <ChoiceList
                  options={categories}
                  selectedId={item.categoryId}
                  onSelect={(categoryId) =>
                    patchItem(index, {
                      categoryId,
                      subcategoryId: '',
                    })
                  }
                  isDark={isDark}
                  allowNone
                  disabled={busy || creatingOption !== null}
                />
                <FieldLabel>Subcategoría (opcional)</FieldLabel>
                {itemSubcategories.length ? (
                  <ChoiceList
                    options={itemSubcategories}
                    selectedId={item.subcategoryId}
                    onSelect={(subcategoryId) =>
                      patchItem(index, { subcategoryId })
                    }
                    isDark={isDark}
                    allowNone
                    disabled={busy || creatingOption !== null}
                  />
                ) : (
                  <Text style={styles.helperText} lightColor="#6b7280" darkColor="#9ca3af">
                    No hay subcategorías para esta categoría. Puedes crear una aquí.
                  </Text>
                )}
                {!item.categoryId ? (
                  <Text style={styles.helperText} lightColor="#6b7280" darkColor="#9ca3af">
                    Selecciona una categoría para crear una subcategoría.
                  </Text>
                ) : null}
                <TextInput
                  accessibilityLabel={`Nueva subcategoría del artículo ${index + 1}`}
                  value={item.newSubcategoryName}
                  onChangeText={(newSubcategoryName) =>
                    patchItem(index, { newSubcategoryName })
                  }
                  editable={!busy && creatingOption === null}
                  placeholder="Nombre de la subcategoría"
                  placeholderTextColor={isDark ? '#9ca3af' : '#6b7280'}
                  style={textInputStyle(isDark)}
                />
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => void createSubcategory(index)}
                  disabled={
                    busy ||
                    creatingOption !== null ||
                    !item.categoryId ||
                    !item.newSubcategoryName.trim()
                  }
                  style={[
                    styles.secondaryButton,
                    (busy ||
                      creatingOption !== null ||
                      !item.categoryId ||
                      !item.newSubcategoryName.trim()) &&
                      styles.disabled,
                  ]}
                >
                  {creatingOption === `subcategory-${index}` ? (
                    <ActivityIndicator color={isDark ? '#c7d2fe' : '#4338ca'} />
                  ) : (
                    <Text style={styles.secondaryButtonText} lightColor="#4338ca" darkColor="#c7d2fe">
                      Crear y asignar subcategoría
                    </Text>
                  )}
                </TouchableOpacity>
                <FieldLabel>Etiquetas</FieldLabel>
                {tags.length ? (
                  <ChoiceList
                    options={tags}
                    selectedIds={item.tagIds.map(String)}
                    onToggle={(tagId) => {
                      const numericId = Number(tagId);
                      patchItem(index, {
                        tagIds: item.tagIds.includes(numericId)
                          ? item.tagIds.filter((id) => id !== numericId)
                          : [...item.tagIds, numericId],
                      });
                    }}
                    isDark={isDark}
                    multiple
                    disabled={busy || creatingOption !== null}
                  />
                ) : (
                  <Text style={styles.helperText} lightColor="#6b7280" darkColor="#9ca3af">
                    Aún no tienes etiquetas. Puedes crear una aquí.
                  </Text>
                )}
                <TextInput
                  accessibilityLabel={`Nueva etiqueta del artículo ${index + 1}`}
                  value={item.newTagName}
                  onChangeText={(newTagName) => patchItem(index, { newTagName })}
                  editable={!busy && creatingOption === null}
                  placeholder="Nombre de la etiqueta"
                  placeholderTextColor={isDark ? '#9ca3af' : '#6b7280'}
                  style={textInputStyle(isDark)}
                />
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => void createTag(index)}
                  disabled={
                    busy ||
                    creatingOption !== null ||
                    !item.newTagName.trim()
                  }
                  style={[
                    styles.secondaryButton,
                    (busy ||
                      creatingOption !== null ||
                      !item.newTagName.trim()) &&
                      styles.disabled,
                  ]}
                >
                  {creatingOption === `tag-${index}` ? (
                    <ActivityIndicator color={isDark ? '#c7d2fe' : '#4338ca'} />
                  ) : (
                    <Text style={styles.secondaryButtonText} lightColor="#4338ca" darkColor="#c7d2fe">
                      Crear y asignar etiqueta
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}

          <TouchableOpacity
            accessibilityRole="button"
            onPress={() =>
              patchReview({
                items: [
                  ...review.items,
                  {
                    product: '',
                    price: '',
                    categoryId: '',
                    subcategoryId: '',
                    tagIds: [],
                    newSubcategoryName: '',
                    newTagName: '',
                  },
                ],
              })
            }
            disabled={busy || creatingOption !== null}
            style={[
              styles.secondaryButton,
              (busy || creatingOption !== null) && styles.disabled,
            ]}
          >
            <Text style={styles.secondaryButtonText} lightColor="#4338ca" darkColor="#c7d2fe">
              Agregar artículo
            </Text>
          </TouchableOpacity>

          <Text style={styles.confirmTotal}>
            Total a guardar: {formatChileanPesos(inputAmount(review.total) ?? 0)}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void confirmReceipt()}
            disabled={busy || accounts.length === 0}
            style={[
              styles.primaryButton,
              (busy || accounts.length === 0) && styles.disabled,
            ]}
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryButtonText}>Confirmar y guardar</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              setReview(null);
              setImage(null);
              setError('');
            }}
            disabled={busy}
            style={styles.cancelButton}
          >
            <Text style={styles.cancelText}>Cancelar revisión</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorCard} lightColor="#fef2f2" darkColor="#450a0a">
          <Text style={styles.errorText} lightColor="#b91c1c" darkColor="#fca5a5">
            {error}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Text style={styles.fieldLabel} lightColor="#4b5563" darkColor="#d1d5db">
      {children}
    </Text>
  );
}

function ChoiceList({
  options,
  selectedId,
  selectedIds = [],
  onSelect,
  onToggle,
  isDark,
  allowNone = false,
  multiple = false,
  disabled = false,
}: {
  options: SelectOption[];
  selectedId?: string;
  selectedIds?: string[];
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  isDark: boolean;
  allowNone?: boolean;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const choices = allowNone
    ? [{ id: -1, name: 'Sin asignar' }, ...options]
    : options;

  return (
    <View style={styles.choices} lightColor="transparent" darkColor="transparent">
      {choices.map((option) => {
        const id = option.id === -1 ? '' : String(option.id);
        const selected = multiple
          ? selectedIds.includes(id)
          : selectedId === id && (Boolean(selectedId) || option.id === -1);
        return (
          <TouchableOpacity
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            disabled={disabled}
            onPress={() => (multiple ? onToggle?.(id) : onSelect?.(id))}
            style={[
              styles.choice,
              {
                backgroundColor: selected
                  ? isDark
                    ? '#3730a3'
                    : '#e0e7ff'
                  : isDark
                    ? '#111827'
                    : '#f3f4f6',
                borderColor: selected
                  ? isDark
                    ? '#818cf8'
                    : '#6366f1'
                  : isDark
                    ? '#374151'
                    : '#e5e7eb',
              },
            ]}
          >
            <Text
              style={styles.choiceText}
              lightColor={selected ? '#4338ca' : '#374151'}
              darkColor={selected ? '#c7d2fe' : '#e5e7eb'}
            >
              {multiple && selected ? '✓ ' : ''}
              {option.icono ? `${option.icono} ${option.name}` : option.name}
            </Text>
          </TouchableOpacity>
        );
      })}
      {!options.length ? (
        <Text style={styles.helperText} lightColor="#6b7280" darkColor="#9ca3af">
          No hay opciones disponibles.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
    lineHeight: 23,
    marginTop: 6,
    marginBottom: 24,
  },
  card: {
    borderRadius: 16,
    padding: 20,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  placeholder: {
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    padding: 20,
  },
  placeholderIcon: {
    fontSize: 44,
    marginBottom: 12,
  },
  preview: {
    width: '100%',
    height: 320,
    borderRadius: 12,
    marginBottom: 16,
  },
  helperText: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  secondaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#4f46e5',
    borderRadius: 10,
    paddingHorizontal: 12,
    marginTop: 12,
  },
  imageActions: {
    flexDirection: 'row',
    gap: 10,
  },
  imageActionButton: {
    flex: 1,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  primaryButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#4f46e5',
    paddingHorizontal: 14,
    marginTop: 14,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
  sectionHeading: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 4,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 16,
  },
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  choice: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  choiceText: {
    fontSize: 13,
    fontWeight: '500',
  },
  itemCard: {
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemHeading: {
    fontSize: 16,
    fontWeight: '600',
  },
  removeText: {
    color: '#dc2626',
    fontSize: 14,
    fontWeight: '600',
  },
  confirmTotal: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'right',
    marginTop: 22,
  },
  cancelButton: {
    alignItems: 'center',
    padding: 12,
    marginTop: 4,
  },
  cancelText: {
    color: '#6b7280',
    fontWeight: '600',
  },
  errorCard: {
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
  },
  errorText: {
    fontSize: 14,
  },
  successCard: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 18,
  },
  successText: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 5,
  },
});
