import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, useColorScheme as useNativeColorScheme } from 'react-native';
import type { ReactNode } from 'react';

type ColorScheme = 'light' | 'dark';

type ThemeModeContextValue = {
  colorScheme: ColorScheme;
  toggleColorScheme: () => Promise<void>;
  storageError: string;
};

const THEME_STORAGE_KEY = 'boletasia-color-scheme';
export const ThemeModeContext = createContext<ThemeModeContextValue | null>(
  null
);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const deviceScheme = useNativeColorScheme();
  const [savedScheme, setSavedScheme] = useState<ColorScheme | null>(null);
  const [storageError, setStorageError] = useState('');
  const userSelectedTheme = useRef(false);
  const colorScheme = savedScheme ?? (deviceScheme === 'dark' ? 'dark' : 'light');

  useEffect(() => {
    let isMounted = true;

    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((storedScheme) => {
        if (
          isMounted &&
          !userSelectedTheme.current &&
          (storedScheme === 'light' || storedScheme === 'dark')
        ) {
          setSavedScheme(storedScheme);
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setStorageError(
            `No se pudo cargar la preferencia de tema: ${
              error instanceof Error ? error.message : 'Error desconocido'
            }`
          );
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    document.documentElement.style.colorScheme = colorScheme;
    document.body.style.backgroundColor =
      colorScheme === 'dark' ? '#000000' : '#ffffff';
  }, [colorScheme]);

  const toggleColorScheme = useCallback(async () => {
    userSelectedTheme.current = true;
    const nextScheme = colorScheme === 'dark' ? 'light' : 'dark';
    setSavedScheme(nextScheme);

    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, nextScheme);
      setStorageError('');
    } catch (error: unknown) {
      setStorageError(
        `No se pudo guardar la preferencia de tema: ${
          error instanceof Error ? error.message : 'Error desconocido'
        }`
      );
    }
  }, [colorScheme]);

  const contextValue = useMemo(
    () => ({ colorScheme, toggleColorScheme, storageError }),
    [colorScheme, toggleColorScheme, storageError]
  );

  return (
    <ThemeModeContext.Provider value={contextValue}>
      {children}
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode() {
  const context = useContext(ThemeModeContext);
  if (!context) {
    throw new Error('useThemeMode debe usarse dentro de ThemeModeProvider.');
  }
  return context;
}
