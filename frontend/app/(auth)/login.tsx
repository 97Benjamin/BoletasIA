import React, { useState } from 'react';
import { 
  StyleSheet, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  View, 
  Alert, 
  ActivityIndicator, 
  KeyboardAvoidingView, 
  Platform,
  useColorScheme // 1. Hook para detectar el tema del dispositivo
} from 'react-native';
import { supabase } from '../../src/services/supabase';
import { useRouter } from 'expo-router';

export default function AuthScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // 2. Detectamos si el sistema está en modo oscuro ('dark' o 'light')
  const colorScheme = useColorScheme();
  const isDarkMode = colorScheme === 'dark';

  // 3. Definimos los colores dinámicos basados en el tema
  const colors = {
    background: isDarkMode ? '#111827' : '#f3f4f6',       // Fondo general
    cardBackground: isDarkMode ? '#1f2937' : '#ffffff', // Fondo de la tarjeta
    textMain: isDarkMode ? '#f9fafb' : '#1f2937',       // Texto principal
    textSecondary: isDarkMode ? '#9ca3af' : '#6b7280',  // Subtítulos
    inputBackground: isDarkMode ? '#374151' : '#f9fafb', // Fondo de inputs
    inputBorder: isDarkMode ? '#4b5563' : '#e5e7eb',    // Bordes de inputs
    inputText: isDarkMode ? '#ffffff' : '#1f2937',      // Texto dentro de inputs
    placeholder: isDarkMode ? '#9ca3af' : '#9ca3af',    // Texto placeholder
  };

  async function handleSignIn() {
    if (!email || !password) {
      Alert.alert('Campos vacíos', 'Por favor ingresa tu correo y contraseña.');
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) {
      Alert.alert('Error al iniciar sesión', error.message);
    } else {
      router.replace('/(tabs)');
    }
    setLoading(false);
  }

  async function handleSignUp() {
    if (!email || !password) {
      Alert.alert('Campos vacíos', 'Por favor ingresa tu correo y contraseña para registrarte.');
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signUp({ 
      email, 
      password,
      options: {
        data: { nombre: email.split('@')[0] }
      }
    });

    if (error) {
      Alert.alert('Error en el registro', error.message);
    } else {
      Alert.alert(
        '¡Registro exitoso!', 
        'Tu cuenta y perfil han sido creados correctamente. Ya puedes iniciar sesión.'
      );
    }
    setLoading(false);
  }

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
      // 4. Aplicamos el color de fondo dinámico
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      {/* 5. Aplicamos colores dinámicos a la tarjeta y textos */}
      <View style={[styles.card, { backgroundColor: colors.cardBackground }]}>
        <Text style={[styles.title, { color: colors.textMain }]}>Control de Gastos</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Gestiona tus boletas e inteligencia financiera
        </Text>
        
        <View style={styles.inputContainer}>
          <TextInput
            style={[
              styles.input, 
              { 
                backgroundColor: colors.inputBackground, 
                borderColor: colors.inputBorder,
                color: colors.inputText 
              }
            ]}
            placeholder="Correo electrónico"
            placeholderTextColor={colors.placeholder}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          
          <View style={[
            styles.passwordContainer, 
            { 
              backgroundColor: colors.inputBackground, 
              borderColor: colors.inputBorder 
            }
          ]}>
            <TextInput
              style={[styles.passwordInput, { color: colors.inputText }]}
              placeholder="Contraseña"
              placeholderTextColor={colors.placeholder}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
            />
            <TouchableOpacity 
              style={styles.eyeButton} 
              onPress={() => setShowPassword(!showPassword)}
            >
              <Text style={styles.eyeButtonText}>
                {showPassword ? 'Ocultar' : 'Ver'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {loading ? (
          <ActivityIndicator size="large" color="#4f46e5" style={{ marginVertical: 20 }} />
        ) : (
          <View style={styles.buttonContainer}>
            <TouchableOpacity style={styles.primaryButton} onPress={handleSignIn}>
              <Text style={styles.primaryButtonText}>Iniciar Sesión</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={handleSignUp}>
              <Text style={styles.secondaryButtonText}>Registrarse</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  inputContainer: {
    marginBottom: 20,
  },
  input: {
    height: 50,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 14,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    height: 50,
    marginBottom: 14,
    paddingRight: 8,
  },
  passwordInput: {
    flex: 1,
    height: '100%',
    paddingHorizontal: 16,
    fontSize: 16,
  },
  eyeButton: {
    paddingHorizontal: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  eyeButtonText: {
    color: '#818cf8', // Un tono de índigo ligeramente más claro para que resalte bien en modo oscuro
    fontWeight: '600',
    fontSize: 14,
  },
  buttonContainer: {
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#4f46e5',
    height: 50,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#4f46e5',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderColor: '#4f46e5',
    borderWidth: 1.5,
    height: 50,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#818cf8', // Coherente con el botón "Ver/Ocultar"
    fontSize: 16,
    fontWeight: '600',
  },
});