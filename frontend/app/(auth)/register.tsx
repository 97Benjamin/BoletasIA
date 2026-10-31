import React, { useState } from 'react';
import {
  StyleSheet, Text, TextInput, TouchableOpacity, View,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
  useColorScheme
} from 'react-native';
import { supabase } from '../../src/services/supabase';
import { useRouter, Link } from 'expo-router';

export default function RegisterScreen() {
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const colorScheme = useColorScheme();
  const dark = colorScheme === 'dark';

  const colors = {
    bg: dark ? '#111827' : '#f3f4f6',
    card: dark ? '#1f2937' : '#ffffff',
    text: dark ? '#f9fafb' : '#1f2937',
    sub: dark ? '#9ca3af' : '#6b7280',
    inputBg: dark ? '#374151' : '#f9fafb',
    inputBorder: dark ? '#4b5563' : '#e5e7eb',
    inputText: dark ? '#ffffff' : '#1f2937',
    placeholder: '#9ca3af',
    primary: '#4f46e5',
  };

  async function handleRegister() {
    if (!nombre.trim() || !email.trim() || !password) {
      Alert.alert('Faltan datos', 'Completa tu nombre, correo y contraseña.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      Alert.alert('Correo inválido', 'Ingresa un correo como ejemplo@dominio.cl');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Contraseña corta', 'Usa al menos 6 caracteres.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('No coinciden', 'Las contraseñas no son iguales.');
      return;
    }
    setLoading(true);
    try {
      // 1) Signup con Supabase Auth (como tu receta: POST REST + confirm email)
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { nombre: nombre.trim() } },
      });
      if (error) { Alert.alert('Error al registrarte', error.message); setLoading(false); return; }
      const userId = data.user?.id;
      if (!userId) { Alert.alert('Sin usuario', 'No se creó la sesión. Intenta de nuevo.'); setLoading(false); return; }

      // 2) Confirmar email (como haces para pruebas: UPDATE auth.users + INSERT perfiles)
      // Nota: en este flujo por web el usuario recibirá el correo de confirmación.
      // Para el entorno de prueba local, confirmamos inmediatamente con REST.
      const anonKey = (supabase as any).supabaseKey || '';
      // No usamos REST directo aquí; confiamos en que el usuario confirma por correo.
      // Pero sí creamos el perfil inmediatamente (como tu receta manual) para que pueda
      // entrar directo tras confirmar.

      // 3) Insertar perfil (como tu receta con el usuario prueba)
      const { error: perfilErr } = await supabase.from('perfiles').insert({
        id: userId,
        email: email.trim(),
        nombre: nombre.trim(),
      });
      if (perfilErr && !perfilErr.message?.includes('duplicate')) {
        console.warn('[registro] perfil:', perfilErr.message);
      }

      // 4) Etiquetas de fábrica y cuenta básica (como haces tras un nuevo registro)
      const { error: tagErr } = await supabase.from('etiquetas').insert([
        { user_id: userId, nombre: 'Gasto hormiga', icono: '🐜' },
        { user_id: userId, nombre: 'Gastos básicos', icono: '🏠' },
      ]).select();
      if (tagErr && !tagErr.message?.includes('duplicate') && !tagErr.message?.includes('23505')) {
        console.warn('[registro] etiquetas:', tagErr.message);
      }

      Alert.alert(
        '¡Cuenta creada!',
        'Revisa tu correo para confirmar el registro. Después inicia sesión con el mismo correo y contraseña.'
      );
      router.replace('/(auth)/login');
    } catch (e: any) {
      Alert.alert('Error inesperado', e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.title, { color: colors.text }]}>Crear cuenta</Text>
        <Text style={[styles.subtitle, { color: colors.sub }]}>Regístrate para empezar a controlar tus boletas.</Text>

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.inputBorder, color: colors.inputText }]}
          placeholder="Nombre (ej: Benjamin)" placeholderTextColor={colors.placeholder}
          value={nombre} onChangeText={setNombre} autoCapitalize="words" />

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.inputBorder, color: colors.inputText }]}
          placeholder="Correo electrónico" placeholderTextColor={colors.placeholder}
          value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.inputBorder, color: colors.inputText }]}
          placeholder="Contraseña (mín. 6)" placeholderTextColor={colors.placeholder}
          value={password} onChangeText={setPassword} secureTextEntry={!showPass} />

        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.inputBorder, color: colors.inputText }]}
          placeholder="Confirmar contraseña" placeholderTextColor={colors.placeholder}
          value={confirm} onChangeText={setConfirm} secureTextEntry={!showPass} />

        <TouchableOpacity onPress={() => setShowPass((v) => !v)}>
          <Text style={{ color: colors.sub, fontSize: 12, alignSelf: 'flex-end', marginBottom: 6 }}>
            {showPass ? 'Ocultar contraseñas' : 'Mostrar contraseñas'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={handleRegister} disabled={loading}
          style={[styles.button, { backgroundColor: colors.primary, opacity: loading ? 0.7 : 1 }]}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Crear cuenta</Text>}
        </TouchableOpacity>

        <Link href="/(auth)/login" style={{ marginTop: 16, alignSelf: 'center' }}>
          <Text style={{ color: colors.sub, fontSize: 14 }}>¿Ya tienes cuenta? Inicia sesión</Text>
        </Link>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  card: { borderRadius: 16, padding: 24, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 4 },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 20 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, marginBottom: 10 },
  button: { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
