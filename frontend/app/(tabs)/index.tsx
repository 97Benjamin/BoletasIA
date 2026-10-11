import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import type { User } from '@supabase/supabase-js';
import { Link, Redirect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { supabase } from '@/src/services/supabase';

export default function AccountScreen() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const authEventReceived = useRef(false);

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
    user.user_metadata?.nombre ??
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email?.split('@')[0] ??
    'Usuario';
  const initials = String(name).trim().charAt(0).toUpperCase() || 'U';

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Mi cuenta</Text>
      <Text style={styles.subtitle}>Información de tu sesión</Text>

      <View style={styles.card} lightColor="#ffffff" darkColor="#1f2937">
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{name}</Text>

        <View
          style={styles.separator}
          lightColor="#e5e7eb"
          darkColor="#374151"
        />

        <View style={styles.infoRow}>
          <Text style={styles.label}>Correo electrónico</Text>
          <Text style={styles.value}>{user.email ?? 'No disponible'}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.label}>ID de usuario</Text>
          <Text selectable style={styles.value}>
            {user.id}
          </Text>
        </View>
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
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  heading: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  subtitle: {
    color: '#6b7280',
    fontSize: 16,
    marginTop: 6,
    marginBottom: 24,
  },
  card: {
    borderRadius: 16,
    padding: 24,
    backgroundColor: '#ffffff',
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
    backgroundColor: '#e0e7ff',
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
    color: '#6b7280',
    fontSize: 13,
    marginBottom: 4,
  },
  value: {
    fontSize: 16,
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
