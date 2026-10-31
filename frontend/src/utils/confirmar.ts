import { Alert, Platform } from 'react-native';

// react-native-web redefine Alert.alert como stub vacío: en la web la
// confirmación no aparecería nunca. En nativo se usa el diálogo del sistema;
// en web se sale del paso con window.confirm (sincrónico, sin async).
export function confirmar(
  titulo: string,
  mensaje: string,
  onConfirm: () => void,
  textoConfirmar = 'Eliminar'
) {
  if (Platform.OS !== 'web') {
    Alert.alert(titulo, mensaje, [
      { text: 'Cancelar', style: 'cancel' },
      { text: textoConfirmar, style: 'destructive', onPress: onConfirm },
    ]);
    return;
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.confirm === 'function' &&
    window.confirm(mensaje ? `${titulo}\n\n${mensaje}` : titulo)
  ) {
    onConfirm();
  }
}
