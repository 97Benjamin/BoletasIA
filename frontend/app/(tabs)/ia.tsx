import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import type { User } from '@supabase/supabase-js';
import { Redirect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { useThemeMode } from '@/components/ThemeMode';
import { supabase } from '@/src/services/supabase';

const apiBaseUrl = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');

type ChatMessage = {
  role: 'user' | 'ia';
  text: string;
};

type ChatResumen = {
  id: number;
  titulo: string;
  actualizado_en: string | null;
};

const SUGERENCIAS = [
  '¿Cuánto gasté este mes y en qué?',
  '¿Cuál es mi categoría con más gastos?',
  '¿Cuánto tengo disponible en mis cuentas?',
  '¿Dónde puedo recortar gastos?',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorDetail(value: unknown) {
  if (isRecord(value)) {
    const detail = value.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  }
  return '';
}

function formatoFechaCorta(value: string | null) {
  if (!value) return '';
  const fecha = new Date(value);
  if (Number.isNaN(fecha.getTime())) return '';
  let horas = fecha.getHours();
  const ampm = horas < 12 ? 'AM' : 'PM';
  horas = horas % 12 || 12;
  const minutos = String(fecha.getMinutes()).padStart(2, '0');
  return `${horas}:${minutos} ${ampm} ${fecha.getDate()}/${
    fecha.getMonth() + 1
  }/${fecha.getFullYear()}`;
}

export default function AsistenteScreen() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [chats, setChats] = useState<ChatResumen[]>([]);
  const [chatActivoId, setChatActivoId] = useState<number | null>(null);
  const [menuChats, setMenuChats] = useState(false);
  const { colorScheme } = useThemeMode();
  const scrollRef = useRef<ScrollView>(null);

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
      .then(({ data: { user: currentUser } }) => {
        if (!isMounted || authEventReceived) return;
        setUser(currentUser);
        setLoading(false);
      })
      .catch(() => {
        if (!isMounted || authEventReceived) return;
        setLoading(false);
      });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, asking]);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setProfileName(null);
      return;
    }
    let isMounted = true;
    async function loadProfile() {
      try {
        const { data } = await supabase
          .from('perfiles')
          .select('nombre')
          .eq('id', userId)
          .maybeSingle();
        if (isMounted) {
          setProfileName(
            typeof data?.nombre === 'string' && data.nombre.trim()
              ? data.nombre.trim()
              : null
          );
        }
      } catch {
        // silencioso: el saludo tendrá fallback al correo
      }
    }
    void loadProfile();
    return () => {
      isMounted = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user) {
      setChats([]);
      return;
    }
    (
      async () => {
        try {
          const { data } = await supabase
            .from('chats')
            .select('id,titulo,actualizado_en')
            .order('actualizado_en', { ascending: false })
            .limit(30);
          setChats((data ?? []) as ChatResumen[]);
        } catch {
          // silencioso: la lista simplemente queda vacía
        }
      }
    )();
  }, [user?.id]);

  function iniciarNuevoChat() {
    setMessages([]);
    setChatActivoId(null);
    setError('');
  }

  function refrescarListaChats() {
    (
      async () => {
        try {
          const { data } = await supabase
            .from('chats')
            .select('id,titulo,actualizado_en')
            .order('actualizado_en', { ascending: false })
            .limit(30);
          setChats((data ?? []) as ChatResumen[]);
        } catch {
          // silencioso
        }
      }
    )();
  }

  function abrirChat(chat: ChatResumen) {
    setMenuChats(false);
    (
      async () => {
        try {
          const { data, error: mensajeError } = await supabase
            .from('chat_mensajes')
            .select('rol,contenido')
            .eq('chat_id', chat.id)
            .order('id', { ascending: true });
          if (mensajeError) throw mensajeError;
          setChatActivoId(chat.id);
          setMessages(
            (data ?? []).map((row: { rol: string; contenido: string }) => ({
              role: row.rol === 'user' ? ('user' as const) : ('ia' as const),
              text: String(row.contenido ?? ''),
            }))
          );
          setError('');
        } catch {
          setError('No se pudo abrir el chat. Intenta de nuevo.');
        }
      }
    )();
  }

  function eliminarChat(id: number) {
    (
      async () => {
        try {
          await supabase.from('chats').delete().eq('id', id);
          setChats((previous) => previous.filter((chat) => chat.id !== id));
          if (chatActivoId === id) {
            setChatActivoId(null);
            setMessages([]);
          }
        } catch {
          setError('No se pudo eliminar el chat. Intenta de nuevo.');
        }
      }
    )();
  }

  async function preguntar(question: string) {
    const value = question.trim();
    if (!value || asking) return;
    setError('');
    setDraft('');
    setMessages((previous) => [...previous, { role: 'user', text: value }]);
    setAsking(true);

    try {
      if (!apiBaseUrl) {
        throw new Error(
          'Falta configurar EXPO_PUBLIC_API_URL con la dirección del backend FastAPI.'
        );
      }
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.refreshSession();
      if (sessionError || !session?.access_token) {
        throw new Error('No hay sesión activa. Inicia sesión nuevamente.');
      }

      const response = await fetch(`${apiBaseUrl}/ia/consultar`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pregunta: value, chat_id: chatActivoId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          errorDetail(payload) ||
            `El servidor respondió con el estado ${response.status}.`
        );
      }
      const respuesta = isRecord(payload) ? payload.respuesta : null;
      if (typeof respuesta !== 'string' || !respuesta.trim()) {
        throw new Error('El asistente no entregó una respuesta válida.');
      }
      setMessages((previous) => [
        ...previous,
        { role: 'ia', text: respuesta.trim() },
      ]);
      const respondedChatId =
        isRecord(payload) && typeof payload.chat_id === 'number'
          ? payload.chat_id
          : null;
      if (respondedChatId !== null && respondedChatId !== chatActivoId) {
        setChatActivoId(respondedChatId);
        refrescarListaChats();
      }
    } catch (askError: unknown) {
      setError(
        askError instanceof Error
          ? askError.message
          : 'No se pudo consultar al asistente.'
      );
    } finally {
      setAsking(false);
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

  const metadataNombre = [
    user.user_metadata?.nombre,
    user.user_metadata?.full_name,
    user.user_metadata?.name,
  ].find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0
  );
  const displayName =
    profileName ?? metadataNombre ?? user.email?.split('@')[0] ?? 'usuario';

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.container}
      >
        <Text style={styles.heading}>Asistente IA</Text>
        <Text style={styles.subtitle} lightColor="#6b7280" darkColor="#9ca3af">
          Pregúntame sobre tus finanzas. Conozco tus cuentas y transacciones.
        </Text>

        <View
          style={styles.accionesRow}
          lightColor="transparent"
          darkColor="transparent"
        >
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setMenuChats(true)}
            style={styles.accionBoton}
          >
            <Text style={styles.accionTexto}>☰ Historial</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={iniciarNuevoChat}
            style={[styles.accionBoton, styles.accionBotonNuevo]}
          >
            <Text style={styles.accionTexto}>＋ Nuevo chat</Text>
          </TouchableOpacity>
        </View>

        {messages.length === 0 && !asking ? (
          <View style={styles.welcomeCard} lightColor="#ffffff" darkColor="#1f2937">
            <Text style={styles.welcomeTitle}>👋 Hola {displayName}</Text>
            <Text style={styles.welcomeText} lightColor="#6b7280" darkColor="#9ca3af">
              Toca una sugerencia para empezar o escribe tu pregunta abajo.
            </Text>
          </View>
        ) : null}

        {messages.map((message, index) => (
          <View
            key={`mensaje-${index}`}
            style={
              message.role === 'user'
                ? styles.userRow
                : styles.iaRow
            }
            lightColor="transparent"
            darkColor="transparent"
          >
            <View
              style={
                message.role === 'user'
                  ? styles.userBubble
                  : styles.iaBubble
              }
              lightColor="#ffffff"
              darkColor="#1f2937"
            >
              <Text
                style={message.role === 'user' ? styles.userText : styles.iaText}
              >
                {message.text}
              </Text>
            </View>
          </View>
        ))}

        {asking ? (
          <View style={styles.iaRow} lightColor="transparent" darkColor="transparent">
            <View style={styles.iaBubble} lightColor="#ffffff" darkColor="#1f2937">
              <View
                style={styles.thinking}
                lightColor="transparent"
                darkColor="transparent"
              >
                <ActivityIndicator size="small" color="#4f46e5" />
                <Text
                  style={styles.thinkingText}
                  lightColor="#6b7280"
                  darkColor="#9ca3af"
                >
                  Analizando tus datos...
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {error ? (
          <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
            {error}
          </Text>
        ) : null}

        {messages.length === 0 && !asking ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
            style={styles.chipsScroll}
          >
            {SUGERENCIAS.map((sugerencia) => (
              <TouchableOpacity
                key={sugerencia}
                accessibilityRole="button"
                onPress={() => void preguntar(sugerencia)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      colorScheme === 'dark' ? '#312e81' : '#e0e7ff',
                  },
                ]}
              >
                <Text
                  style={styles.chipText}
                  lightColor="#4338ca"
                  darkColor="#c7d2fe"
                >
                  {sugerencia}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
      </ScrollView>

      <View
        style={styles.inputRow}
        lightColor={colorScheme === 'dark' ? '#111827' : '#ffffff'}
        darkColor="#111827"
      >
        <TextInput
          style={[
            styles.input,
            {
              borderColor: colorScheme === 'dark' ? '#4b5563' : '#d1d5db',
              backgroundColor:
                colorScheme === 'dark' ? '#1f2937' : '#ffffff',
              color: colorScheme === 'dark' ? '#f9fafb' : '#111827',
            },
          ]}
          value={draft}
          onChangeText={setDraft}
          placeholder="Escribe tu pregunta..."
          placeholderTextColor={colorScheme === 'dark' ? '#9ca3af' : '#6b7280'}
          maxLength={500}
          onSubmitEditing={() => void preguntar(draft)}
          returnKeyType="send"
        />
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void preguntar(draft)}
          disabled={asking || !draft.trim()}
          style={[styles.sendButton, (!draft.trim() || asking) && styles.sendDisabled]}
        >
          <Text style={styles.sendText}>➤</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={menuChats}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuChats(false)}
      >
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setMenuChats(false)}
        >
          <TouchableOpacity activeOpacity={1}>
            <View
              style={[
                styles.menuCard,
                {
                  backgroundColor:
                    colorScheme === 'dark' ? '#111827' : '#ffffff',
                },
              ]}
            >
              <Text
                style={[
                  styles.menuTitulo,
                  { color: colorScheme === 'dark' ? '#f9fafb' : '#111827' },
                ]}
              >
                Historial de chats
              </Text>
              <ScrollView style={styles.menuLista}>
                {chats.length === 0 ? (
                  <Text
                    style={[
                      styles.menuVacio,
                      {
                        color:
                          colorScheme === 'dark' ? '#9ca3af' : '#6b7280',
                      },
                    ]}
                  >
                    Aún no tienes chats guardados. Escribe tu primera
                    pregunta para empezar.
                  </Text>
                ) : (
                  chats.map((chat) => (
                    <View
                      key={chat.id}
                      style={[
                        styles.chatItemRow,
                        {
                          borderBottomColor:
                            colorScheme === 'dark'
                              ? 'rgba(148,163,184,0.25)'
                              : '#e5e7eb',
                        },
                      ]}
                    >
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={styles.chatItemPrincipal}
                        onPress={() => abrirChat(chat)}
                      >
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.chatTitulo,
                            {
                              color:
                                colorScheme === 'dark'
                                  ? '#f9fafb'
                                  : '#111827',
                            },
                          ]}
                        >
                          {chat.titulo || 'Nuevo chat'}
                        </Text>
                        <Text
                          style={[
                            styles.chatFecha,
                            {
                              color:
                                colorScheme === 'dark'
                                  ? '#9ca3af'
                                  : '#6b7280',
                            },
                          ]}
                        >
                          {formatoFechaCorta(chat.actualizado_en)}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() => eliminarChat(chat.id)}
                        style={styles.chatEliminar}
                      >
                        <Text style={styles.chatEliminarTexto}>🗑</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </ScrollView>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setMenuChats(false)}
                style={styles.menuCerrar}
              >
                <Text style={styles.menuCerrarTexto}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    flexGrow: 1,
    padding: 24,
    paddingBottom: 12,
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
  welcomeCard: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  welcomeTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  welcomeText: {
    fontSize: 15,
  },
  iaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: 12,
  },
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 12,
  },
  iaBubble: {
    maxWidth: '88%',
    borderRadius: 16,
    padding: 14,
    elevation: 2,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  userBubble: {
    maxWidth: '88%',
    borderRadius: 16,
    padding: 14,
    backgroundColor: '#4f46e5',
  },
  iaText: {
    fontSize: 15,
  },
  userText: {
    fontSize: 15,
    color: '#ffffff',
    fontWeight: '500',
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  thinkingText: {
    fontSize: 14,
  },
  error: {
    fontSize: 14,
    marginBottom: 10,
  },
  chipsScroll: {
    flexGrow: 0,
    marginTop: 4,
  },
  chips: {
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: '#e0e7ff',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: '#37415166',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 110,
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4f46e5',
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  accionesRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  accionBoton: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#94a3b8',
  },
  accionBotonNuevo: {
    backgroundColor: '#4f46e5',
    borderColor: '#4f46e5',
  },
  accionTexto: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  menuCard: {
    width: '100%',
    borderRadius: 16,
    padding: 20,
    maxHeight: '85%',
  },
  menuTitulo: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 12,
  },
  menuLista: {
    maxHeight: 380,
  },
  menuVacio: {
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 20,
    lineHeight: 20,
  },
  chatItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  chatItemPrincipal: {
    flex: 1,
  },
  chatTitulo: {
    fontSize: 15,
    fontWeight: '500',
  },
  chatFecha: {
    fontSize: 12,
    marginTop: 2,
  },
  chatEliminar: {
    padding: 8,
  },
  chatEliminarTexto: {
    fontSize: 16,
  },
  menuCerrar: {
    marginTop: 14,
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 24,
    borderRadius: 999,
    backgroundColor: '#4f46e5',
  },
  menuCerrarTexto: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
