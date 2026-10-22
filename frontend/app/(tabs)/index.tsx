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
import { formatChileanPesos } from '@/src/utils/currency';

type AccountRow = {
  id: string;
  nombre: string | null;
  tipo: string | null;
  banco: string | null;
  saldoActual: number | null;
};

// Debe coincidir con el CHECK cuentas_tipo_check de la base de datos
const TIPOS_CUENTA = ['efectivo', 'debito', 'credito'] as const;
type TipoCuenta = (typeof TIPOS_CUENTA)[number];

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
  const [accountSaving, setAccountSaving] = useState(false);
  const authEventReceived = useRef(false);
  const { colorScheme, toggleColorScheme, storageError } = useThemeMode();

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
          .select('id, nombre, tipo, banco, saldo_actual')
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
              return [
                {
                  id: String(id),
                  nombre:
                    typeof account.nombre === 'string' ? account.nombre : null,
                  tipo: typeof account.tipo === 'string' ? account.tipo : null,
                  banco:
                    typeof account.banco === 'string' ? account.banco : null,
                  saldoActual:
                    typeof account.saldo_actual === 'number'
                      ? account.saldo_actual
                      : typeof account.saldo_actual === 'string' &&
                          account.saldo_actual.trim() !== '' &&
                          Number.isFinite(Number(account.saldo_actual))
                        ? Number(account.saldo_actual)
                        : null,
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
  }, [user, accountsReload]);

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
    Alert.alert(
      'Eliminar cuenta',
      `¿Eliminar la cuenta "${
        account.nombre ?? 'sin nombre'
      }"? Esta acción no se puede deshacer.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => void handleRemoveAccount(account),
        },
      ]
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
      setAccountsReload((reload) => reload + 1);
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
    setAccountSaving(true);
    setAccountsError('');
    try {
      const { error } = await supabase.from('cuentas').insert({
        user_id: user.id,
        nombre,
        tipo: newTipo,
        banco: newBanco.trim() ? newBanco.trim() : null,
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
      setAddingAccount(false);
      setAccountsReload((reload) => reload + 1);
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

  // Estado de resultado: suma de los saldos de todas las cuentas.
  // Los saldos no disponibles se ignoran en el total.
  const totalCuentas = accounts.reduce((suma, cuenta) => {
    const saldo = cuenta.saldoActual;
    return typeof saldo === 'number' ? suma + saldo : suma;
  }, 0);
  const totalColor = (() => {
    const verde = colorScheme === 'dark' ? '#34d399' : '#15803d';
    const rojo = colorScheme === 'dark' ? '#f87171' : '#b91c1c';
    return totalCuentas >= 0 ? verde : rojo;
  })();

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
            const subtitle = [account.tipo, account.banco]
              .filter(Boolean)
              .join(' · ');
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
                  <Text style={styles.balanceValue}>
                    {account.saldoActual === null
                      ? 'Saldo no disponible'
                      : formatChileanPesos(account.saldoActual)}
                  </Text>
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
});
