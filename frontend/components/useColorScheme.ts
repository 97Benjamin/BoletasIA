import { useContext } from 'react';
import { useColorScheme as useColorSchemeCore } from 'react-native';

import { ThemeModeContext } from './ThemeMode';

export const useColorScheme = () => {
  const themeMode = useContext(ThemeModeContext);
  const coreScheme = useColorSchemeCore();
  return themeMode?.colorScheme ?? (coreScheme === 'dark' ? 'dark' : 'light');
};
