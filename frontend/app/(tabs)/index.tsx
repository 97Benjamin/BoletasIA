import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import type { User } from '@supabase/supabase-js';
import { Link, Redirect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { useThemeMode } from '@/components/ThemeMode';
import { supabase } from '@/src/services/supabase';
import { formatChileanPesos } from '@/src/utils/currency';

type AccountBalance = {
  nombre: string | null;
  saldoActual: number | null;
};

export default function AccountScreen() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');
  const [accountsReload, setAccountsReload] = useState(0);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [profileError, setProfileError] = useState('');
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
          .select('nombre, saldo_actual')
          .eq('user_id', userId);

        if (error) {
          throw error;
        }

        if (isMounted) {
          setAccounts(
            (data ?? []).map((account) => ({
              nombre:
                typeof account.nombre === 'string' ? account.nombre : null,
              saldoActual:
                typeof account.saldo_actual === 'number'
                  ? account.saldo_actual
                  : typeof account.saldo_actual === 'string' &&
                      account.saldo_actual.trim() !== '' &&
                      Number.isFinite(Number(account.saldo_actual))
                    ? Number(account.saldo_actual)
                    : null,
            }))
          );
        }
      } catch (error: unknown) {
        if (isMounted) {
          setAccountsError(
            `No se pudo cargar el saldo: ${
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

  const name =
    profileName ??
    user.user_metadata?.nombre ??
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email?.split('@')[0] ??
    'Usuario';
  const initials = String(name).trim().charAt(0).toUpperCase() || 'U';

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
        <View
          style={styles.avatar}
          lightColor="#e0e7ff"
          darkColor="#3730a3"
        >
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{name}</Text>

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
        <View
          style={styles.infoRow}
          lightColor="transparent"
          darkColor="transparent"
        >
          <Text style={styles.label} lightColor="#6b7280" darkColor="#9ca3af">
            ID de usuario
          </Text>
          <Text selectable style={styles.value}>
            {user.id}
          </Text>
        </View>
      </View>

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

      <Text style={styles.balanceHeading}>Saldo actual</Text>
      <View style={styles.balanceCard} lightColor="#ffffff" darkColor="#1f2937">
        {accountsLoading ? (
          <ActivityIndicator size="small" color="#4f46e5" />
        ) : accountsError ? (
          <>
            <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
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
            No tienes cuentas registradas.
          </Text>
        ) : (
          accounts.map((account, index) => (
            <View
              key={`${account.nombre ?? 'cuenta'}-${index}`}
              style={styles.balanceRow}
              lightColor="transparent"
              darkColor="transparent"
            >
              <Text
                style={styles.accountName}
                lightColor="#6b7280"
                darkColor="#9ca3af"
              >
                {account.nombre ?? 'Cuenta'}
              </Text>
              <Text style={styles.balanceValue}>
                {account.saldoActual === null
                  ? 'Saldo no disponible'
                  : formatChileanPesos(account.saldoActual)}
              </Text>
            </View>
          ))
        )}
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
  avatarText: {
    color: '#4f46e5',
    fontSize: 30,
    fontWeight: 'bold',
  },
  name: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
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
  balanceHeading: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 24,
    marginBottom: 12,
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
  balanceRow: {
    paddingVertical: 8,
  },
  accountName: {
    fontSize: 14,
    marginBottom: 4,
  },
  balanceValue: {
    fontSize: 24,
    fontWeight: 'bold',
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
