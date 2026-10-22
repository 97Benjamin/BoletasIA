import { useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useThemeMode } from '@/components/ThemeMode';

// Selector de fecha con calendario propio (grilla mensual) para iOS, Android
// y web con el mismo aspecto. Reemplaza escribir la fecha como texto.
// REGLA del portal: los colores del Modal van SIEMPRE por style, nunca por
// props lightColor/darkColor.

const NOMBRES_MES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const DIAS_SEMANA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const _PATRON_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

type SelectorFechaProps = {
  /** Valor actual en ISO AAAA-MM-DD ('' = sin elegir). */
  valor: string;
  alCambiar: (valorIso: string) => void;
  /** Si true, deshabilita fechas futuras. */
  bloquearFuturo?: boolean;
  /** Estilo del campo-clickeable (bordes/fondo del formulario). */
  contenedorEstilo?: StyleProp<ViewStyle>;
  /** Color/fsión del texto del campo. */
  textoEstilo?: StyleProp<TextStyle>;
  accesibilidadLabel?: string;
};

function esIsoValido(valor: string): boolean {
  const match = _PATRON_ISO.exec(valor);
  if (!match) {
    return false;
  }
  const año = Number(match[1]);
  const mes = Number(match[2]);
  const dia = Number(match[3]);
  if (mes < 1 || mes > 12 || dia < 1) {
    return false;
  }
  const diasMes = new Date(año, mes, 0).getDate();
  return dia <= diasMes;
}

function fechaDeHoy(): Date {
  const ahora = new Date();
  return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
}

function fechaDesdeIso(valor: string): Date {
  const match = _PATRON_ISO.exec(valor);
  if (!match) {
    return fechaDeHoy();
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function isoDesdeFecha(fecha: Date): string {
  const año = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${año}-${mes}-${dia}`;
}

/** dd-mm-aaaa (formato chileno) a partir de ISO; '' si no es válido. */
function fechaBonita(valor: string): string {
  if (!esIsoValido(valor)) {
    return '';
  }
  const match = _PATRON_ISO.exec(valor) as RegExpExecArray;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export default function SelectorFecha(props: SelectorFechaProps) {
  const { colorScheme } = useThemeMode();
  const oscuro = colorScheme === 'dark';
  const [abierto, setAbierto] = useState(false);
  const [cursor, setCursor] = useState<number[]>([0, 0, 0]); // [año, mes0, día]

  const colores = {
    fondoModal: oscuro ? '#111827' : '#ffffff',
    titulo: oscuro ? '#f9fafb' : '#111827',
    sub: oscuro ? '#9ca3af' : '#6b7280',
    borde: oscuro ? '#334155' : '#e2e8f0',
    diaTexto: oscuro ? '#e2e8f0' : '#111827',
    diaFuera: oscuro ? '#475569' : '#9ca3af',
    hoyBorde: '#4f46e5',
    acento: '#4f46e5',
    acentoTexto: '#ffffff',
  };

  const abrir = () => {
    const base = esIsoValido(props.valor)
      ? fechaDesdeIso(props.valor)
      : fechaDeHoy();
    setCursor([base.getFullYear(), base.getMonth(), base.getDate()]);
    setAbierto(true);
  };

  const elegir = (fecha: Date) => {
    props.alCambiar(isoDesdeFecha(fecha));
    setAbierto(false);
  };

  const moverMes = (salto: number) => {
    setCursor(([a, m]) => {
      const nuevoMes = m + salto;
      return [
        a + Math.floor(nuevoMes / 12),
        ((nuevoMes % 12) + 12) % 12,
        1,
      ];
    });
  };

  // Rejilla del mes apuntado (la semana parte en lunes)
  const [cursorAño, cursorMes0] = [cursor[0], cursor[1]];
  const primerDia = new Date(cursorAño, cursorMes0, 1);
  const diasMes = new Date(cursorAño, cursorMes0 + 1, 0).getDate();
  const offsetInicio = (primerDia.getDay() + 6) % 7;
  const hoy = fechaDeHoy();
  const seleccionadaISO = esIsoValido(props.valor) ? props.valor : '';
  const esFechaBloqueada = (fecha: Date): boolean => {
    if (!props.bloquearFuturo) return false;
    const hoyMidnight = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    return fecha > hoyMidnight;
  };

  // Celdas: primer offset vacío + días reales
  const celdas: (Date | null)[] = [];
  for (let i = 0; i < offsetInicio; i += 1) {
    celdas.push(null);
  }
  for (let dia = 1; dia <= diasMes; dia += 1) {
    celdas.push(new Date(cursorAño, cursorMes0, dia));
  }
  while (celdas.length % 7 !== 0) {
    celdas.push(null);
  }

  const filas: (Date | null)[][] = [];
  let filaActual: (Date | null)[] = [];
  celdas.forEach((fecha, i) => {
    filaActual.push(fecha);
    if ((i + 1) % 7 === 0) { filas.push([...filaActual]); filaActual = []; }
  });
  if (filaActual.length > 0) { while (filaActual.length < 7) filaActual.push(null); filas.push([...filaActual]); }

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={props.accesibilidadLabel ?? 'Abrir calendario'}
        onPress={abrir}
        style={[props.contenedorEstilo, !abierto ? { opacity: 1 } : null]}
      >
        <Text style={props.textoEstilo}>
          📅 {fechaBonita(props.valor) || 'Elegir fecha'}
        </Text>
      </TouchableOpacity>

      <Modal
        visible={abierto}
        transparent
        animationType="fade"
        onRequestClose={() => setAbierto(false)}
      >
        <View style={styles.velo}>
          <TouchableOpacity
            accessibilityLabel="Cerrar calendario"
            activeOpacity={1}
            style={styles.zonaAbierta}
            onPress={() => setAbierto(false)}
          >
            <View
              style={[
                styles.panel,
                { backgroundColor: colores.fondoModal, borderColor: colores.borde },
              ]}
            >
              {/* Encabezado: mes y año */}
              <View style={styles.filaHeader}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Mes anterior"
                  onPress={() => moverMes(-1)}
                  style={styles.flechaBtn}
                >
                  <Text style={[styles.flecha, { color: colores.acento }]}>‹</Text>
                </TouchableOpacity>
                <Text
                  style={[styles.tituloMes, { color: colores.titulo }]}
                  numberOfLines={1}
                >
                  {NOMBRES_MES[cursorMes0]} {cursorAño}
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Mes siguiente"
                  onPress={() => moverMes(1)}
                  style={styles.flechaBtn}
                >
                  <Text style={[styles.flecha, { color: colores.acento }]}>›</Text>
                </TouchableOpacity>
              </View>

              {/* Días de la semana */}
              <View style={styles.filaSemana}>
                {DIAS_SEMANA.map((sigla) => (
                  <View key={sigla} style={styles.celda}>
                    <Text style={[styles.sigla, { color: colores.sub }]}>
                      {sigla}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Grilla de días */}
              <View style={{ flexDirection: 'column', gap: 2 }}>
                {filas.map((filaSemana, idxSemana) => (
                  <View key={idxSemana} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    {filaSemana.map((fecha, idxDia) => {
                      const key = idxSemana + '-' + idxDia;
                      if (!fecha) {
                        return <View key={key} style={{ flex: 1 }} />;
                      }
                      const iso = isoDesdeFecha(fecha);
                      const esHoy = iso === isoDesdeFecha(hoy);
                      const esSeleccionada = iso === seleccionadaISO;
                      const esBloqueada = esFechaBloqueada(fecha);
                      return (
                        <View key={key} style={{ flex: 1, alignItems: 'center' }}>
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={`Elegir ${fechaBonita(iso)}`}
                            onPress={() => elegir(fecha)}
                            disabled={esSeleccionada || esBloqueada}
                            style={[
                              { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
                              esSeleccionada ? { backgroundColor: colores.acento } : null,
                              esHoy && !esSeleccionada ? { borderWidth: 2, borderColor: colores.hoyBorde, borderRadius: 999 } : null,
                            ]}
                          >
                            <Text style={[
                              { fontSize: 14, fontVariant: ['tabular-nums'], color: colores.diaTexto },
                              esSeleccionada ? { color: colores.acentoTexto, fontWeight: '700' } : null,
                              esBloqueada ? { opacity: 0.3 } : null,
                            ]}>
                              {fecha.getDate()}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>

              {/* Acceso rápido a hoy */}
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => elegir(hoy)}
                style={styles.botonHoy}
              >
                <Text style={[styles.botonHoyTexto, { color: colores.acento }]}>
                  Hoy
                </Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  velo: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  zonaAbierta: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '94%',
    maxWidth: 420,
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
  },
  filaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  flechaBtn: {
    width: 40,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  flecha: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '700',
  },
  tituloMes: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  filaSemana: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  celda: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigla: {
    fontSize: 12,
    fontWeight: '600',
  },
  grilla: {
    flexDirection: 'row',
  },
  dia: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
  },
  diaTexto: {
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  botonHoy: {
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  botonHoyTexto: {
    fontSize: 14,
    fontWeight: '700',
  },
});
