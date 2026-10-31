// Bus liviano de datos para las pantallas de tabs.
//
// Problema: cada tab (index, two, ingresos-gastos, scan) vive montado dentro
// del tabs navigator de expo-router, así que sus useEffect de carga solo
// dependen de user?.id o de contadores locales: al guardar un gasto o editar
// el catálogo, las demás pantallas seguían mostrando datos viejos hasta
// recargar la página entera.
//
// Solución: una señal en memoria (Set de oyentes) que cualquier pantalla
// dispara después de mutar datos y que todas las pantallas vivas escuchan
// para volver a pedir sus datos. Además, el pulso sube cada vez que el tab
// recupera el foco (por ejemplo, cambios hechos en otro dispositivo).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

type Oyente = () => void;

const oyentes = new Set<Oyente>();

/** Deja de escuchar cuando la pantalla que se suscribió se desmonta. */
export function escucharCambios(oyente: Oyente) {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}

/**
 * Avisar a todas las pantallas vivas que la data cambió (gasto guardado,
 * catálogo editado, cuenta creada, etc.). Se llama después de cada mutación
 * confirmada con éxito.
 */
export function notificarCambio() {
  for (const oyente of Array.from(oyentes)) {
    try {
      oyente();
    } catch {
      // Un oyente con error no debe romper al resto de las pantallas.
      oyentes.delete(oyente);
    }
  }
}

/**
 * Número que sube cuando cualquier pantalla notifica un cambio de datos y
 * cuando esta pantalla recupera el foco (cambio de tab). Sumar el valor
 * devuelto a las dependencias del useEffect que carga datos:
 *
 *   const pulsoDatos = usePulsoDatos();
 *   useEffect(() => { ...cargar... }, [user?.id, pulsoDatos]);
 *
 * El primer foco se salta: coincide con la carga inicial del useEffect y no
 * conviene pedir los datos dos veces al abrir la pantalla.
 */
export function usePulsoDatos() {
  const [pulso, setPulso] = useState(0);
  const subir = useCallback(() => setPulso((valor) => valor + 1), []);

  useEffect(() => escucharCambios(subir), [subir]);

  const primerFoco = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (primerFoco.current) {
        primerFoco.current = false;
        return;
      }
      subir();
    }, [subir])
  );

  return pulso;
}
