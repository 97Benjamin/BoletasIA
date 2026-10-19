import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import type { User } from '@supabase/supabase-js';
import { Redirect } from 'expo-router';

import { Text, View } from '@/components/Themed';
import { useThemeMode } from '@/components/ThemeMode';
import { supabase } from '@/src/services/supabase';
import { formatChileanPesos } from '@/src/utils/currency';

type DatabaseRow = Record<string, unknown>;
type DatabaseId = string | number;

type TransactionItem = {
  product: string;
  price: number | null;
  category: string | null;
  subcategory: string | null;
  tags: string[];
};

type TransactionDetail = {
  id: string;
  date: string | null;
  type: string | null;
  total: number | null;
  frequency: string | null;
  account: string | null;
  accountType: string | null;
  bank: string | null;
  accountBalance: number | null;
  merchant: string | null;
  category: string | null;
  subcategory: string | null;
  extraDetails: Array<{ label: string; value: string }>;
  items: TransactionItem[];
  tags: string[];
};

function rowsOrThrow(data: unknown, error: { message: string } | null) {
  if (error) throw new Error(error.message);
  return Array.isArray(data)
    ? data.filter(
        (row): row is DatabaseRow =>
          typeof row === 'object' && row !== null && !Array.isArray(row)
      )
    : [];
}

function readId(row: DatabaseRow, key: string): DatabaseId | null {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : null;
}

function readText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readAmount(row: DatabaseRow, key: string): number | null {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function formatFieldName(field: string) {
  return field
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatFieldValue(value: unknown) {
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (value !== null && value !== undefined) {
    return JSON.stringify(value);
  }
  return '';
}

function indexRows(rows: DatabaseRow[]) {
  return new Map(
    rows.flatMap((row) => {
      const id = readId(row, 'id');
      return id === null ? [] : [[String(id), row] as const];
    })
  );
}

function formatDate(date: string | null) {
  if (!date) return 'Fecha no disponible';
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatAmount(amount: number | null) {
  if (amount === null) return 'Monto no disponible';
  return formatChileanPesos(amount);
}

function groupRows(rows: DatabaseRow[], foreignKey: string) {
  const grouped = new Map<string, DatabaseRow[]>();
  for (const row of rows) {
    const id = readId(row, foreignKey);
    if (id === null) continue;
    const key = String(id);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

export default function TransactionsScreen() {
  const { colorScheme } = useThemeMode();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<TransactionDetail[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

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
      .then(({ data: { user: currentUser }, error: authError }) => {
        if (!isMounted || authEventReceived) return;
        if (authError) {
          setError(`No se pudo validar la sesión: ${authError.message}`);
        } else {
          setUser(currentUser);
        }
        setLoading(false);
      })
      .catch((authError: unknown) => {
        if (!isMounted || authEventReceived) return;
        setError(
          `No se pudo validar la sesión: ${
            authError instanceof Error
              ? authError.message
              : 'Error desconocido'
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
      setTransactions([]);
      setTransactionsLoading(false);
      return;
    }

    let isMounted = true;
    setError('');
    setTransactions([]);
    setTransactionsLoading(true);

    async function loadTransactions() {
      try {
        const { data: transactionData, error: transactionError } =
          await supabase
            .from('transacciones')
            .select('*')
            .eq('user_id', userId)
            .order('fecha', { ascending: false });
        const transactionRows = rowsOrThrow(
          transactionData,
          transactionError
        );

        if (transactionRows.length === 0) {
          if (isMounted) setTransactions([]);
          return;
        }

        const transactionIds = transactionRows
          .map((row) => readId(row, 'id'))
          .filter((id): id is DatabaseId => id !== null);
        const accountIds = [
          ...new Set(
            transactionRows
              .map((row) => readId(row, 'cuenta_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];
        const merchantIds = [
          ...new Set(
            transactionRows
              .map((row) => readId(row, 'comercio_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];
        const categoryIds = [
          ...new Set(
            transactionRows
              .map((row) => readId(row, 'categoria_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];

        const [
          accountResult,
          merchantResult,
          categoryResult,
          itemResult,
          transactionTagResult,
        ] = await Promise.all([
          accountIds.length
            ? supabase.from('cuentas').select('*').in('id', accountIds)
            : Promise.resolve({ data: [], error: null }),
          merchantIds.length
            ? supabase.from('comercios').select('*').in('id', merchantIds)
            : Promise.resolve({ data: [], error: null }),
          categoryIds.length
            ? supabase.from('categorias').select('*').in('id', categoryIds)
            : Promise.resolve({ data: [], error: null }),
          supabase
            .from('transaccion_items')
            .select('*')
            .in('transaccion_id', transactionIds),
          supabase
            .from('transaccion_etiquetas')
            .select('*')
            .in('transaccion_id', transactionIds),
        ]);

        const accountRows = rowsOrThrow(accountResult.data, accountResult.error);
        const merchantRows = rowsOrThrow(
          merchantResult.data,
          merchantResult.error
        );
        const categoryRows = rowsOrThrow(
          categoryResult.data,
          categoryResult.error
        );
        const itemRows = rowsOrThrow(itemResult.data, itemResult.error);
        const transactionTagRows = rowsOrThrow(
          transactionTagResult.data,
          transactionTagResult.error
        );
        const itemIds = itemRows
          .map((row) => readId(row, 'id'))
          .filter((id): id is DatabaseId => id !== null);
        const itemTagResult = itemIds.length
          ? await supabase
              .from('transaccion_item_etiquetas')
              .select('*')
              .in('transaccion_item_id', itemIds)
          : { data: [], error: null };
        const itemTagRows = rowsOrThrow(
          itemTagResult.data,
          itemTagResult.error
        );
        const itemCategoryIds = itemRows
          .map((row) => readId(row, 'categoria_id'))
          .filter((id): id is DatabaseId => id !== null);
        const allCategoryIds = [
          ...new Set([...categoryIds, ...itemCategoryIds.map(String)]),
        ];
        const extraCategoryResult = allCategoryIds.length
          ? await supabase
              .from('categorias')
              .select('*')
              .in('id', allCategoryIds)
          : { data: [], error: null };
        const extraCategoryRows = rowsOrThrow(
          extraCategoryResult.data,
          extraCategoryResult.error
        );
        const itemSubcategoryIds = itemRows
          .map((row) => readId(row, 'subcategoria_id'))
          .filter((id): id is DatabaseId => id !== null);
        const transactionSubcategoryIds = transactionRows
          .map((row) => readId(row, 'subcategoria_id'))
          .filter((id): id is DatabaseId => id !== null);
        const subcategoryIds = [
          ...new Set(
            [...itemSubcategoryIds, ...transactionSubcategoryIds].map(String)
          ),
        ];
        const subcategoryResult = subcategoryIds.length
          ? await supabase
              .from('subcategorias')
              .select('*')
              .in('id', subcategoryIds)
          : { data: [], error: null };
        const subcategoryRows = rowsOrThrow(
          subcategoryResult.data,
          subcategoryResult.error
        );

        const tagIds = [
          ...new Set(
            [...transactionTagRows, ...itemTagRows]
              .map((row) => readId(row, 'etiqueta_id'))
              .filter((id): id is DatabaseId => id !== null)
              .map(String)
          ),
        ];
        const tagResult = tagIds.length
          ? await supabase.from('etiquetas').select('*').in('id', tagIds)
          : { data: [], error: null };
        const tagRows = rowsOrThrow(tagResult.data, tagResult.error);

        const accountsById = indexRows(accountRows);
        const merchantsById = indexRows(merchantRows);
        const categoriesById = indexRows([
          ...categoryRows,
          ...extraCategoryRows,
        ]);
        const subcategoriesById = indexRows(subcategoryRows);
        const tagsById = indexRows(tagRows);
        const itemsByTransaction = groupRows(itemRows, 'transaccion_id');
        const tagsByItem = groupRows(itemTagRows, 'transaccion_item_id');
        const tagsByTransaction = groupRows(
          transactionTagRows,
          'transaccion_id'
        );

        const results = transactionRows.map((row): TransactionDetail => {
          const account = accountsById.get(String(readId(row, 'cuenta_id')));
          const merchant = merchantsById.get(
            String(readId(row, 'comercio_id'))
          );
          const category = categoriesById.get(
            String(readId(row, 'categoria_id'))
          );
          const subcategory = subcategoriesById.get(
            String(readId(row, 'subcategoria_id'))
          );
          const id = readId(row, 'id');
          const rowItems =
            id === null ? [] : itemsByTransaction.get(String(id)) ?? [];
          const rowTags =
            id === null ? [] : tagsByTransaction.get(String(id)) ?? [];

          return {
            id: id === null ? '—' : String(id),
            date: readText(row, 'fecha'),
            type: readText(row, 'tipo'),
            total: readAmount(row, 'total'),
            frequency: readText(row, 'frecuencia'),
            account: account ? readText(account, 'nombre') : null,
            accountType: account ? readText(account, 'tipo') : null,
            bank: account ? readText(account, 'banco') : null,
            accountBalance: account
              ? readAmount(account, 'saldo_actual')
              : null,
            merchant: merchant ? readText(merchant, 'nombre') : null,
            category: category ? readText(category, 'nombre') : null,
            subcategory: subcategory
              ? readText(subcategory, 'nombre')
              : null,
            extraDetails: Object.entries(row)
              .filter(
                ([key]) =>
                  ![
                    'id',
                    'user_id',
                    'cuenta_id',
                    'comercio_id',
                    'categoria_id',
                    'tipo',
                    'fecha',
                    'total',
                    'frecuencia',
                  ].includes(key)
              )
              .flatMap(([key, value]) => {
                const formattedValue = formatFieldValue(value);
                return formattedValue
                  ? [{ label: formatFieldName(key), value: formattedValue }]
                  : [];
              }),
            items: rowItems.map((item) => ({
              product: readText(item, 'producto') ?? 'Artículo',
              price: readAmount(item, 'precio'),
              category: categoriesById.has(String(readId(item, 'categoria_id')))
                ? readText(
                    categoriesById.get(String(readId(item, 'categoria_id'))) ??
                      {},
                    'nombre'
                  )
                : null,
              subcategory: subcategoriesById.has(
                String(readId(item, 'subcategoria_id'))
              )
                ? readText(
                    subcategoriesById.get(
                      String(readId(item, 'subcategoria_id'))
                    ) ?? {},
                    'nombre'
                  )
                : null,
              tags: (tagsByItem.get(
                String(readId(item, 'id'))
              ) ?? []).flatMap((tagLink) => {
                const tagId = readId(tagLink, 'etiqueta_id');
                const tag =
                  tagId === null ? null : tagsById.get(String(tagId));
                const name = tag ? readText(tag, 'nombre') : null;
                return name ? [name] : [];
              }),
            })),
            tags: rowTags.flatMap((tagLink) => {
              const tagId = readId(tagLink, 'etiqueta_id');
              if (tagId === null) return [];
              const tag = tagsById.get(String(tagId));
              const name = tag ? readText(tag, 'nombre') : null;
              return name ? [name] : [];
            }),
          };
        });

        if (isMounted) setTransactions(results);
      } catch (loadError: unknown) {
        if (isMounted) {
          setError(
            `No se pudieron cargar las transacciones: ${
              loadError instanceof Error
                ? loadError.message
                : 'Error desconocido'
            }`
          );
        }
      } finally {
        if (isMounted) setTransactionsLoading(false);
      }
    }

    void loadTransactions();
    return () => {
      isMounted = false;
    };
  }, [user?.id, reload]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (!user && !error) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Transacciones</Text>
      <Text style={styles.subtitle} lightColor="#6b7280" darkColor="#9ca3af">
        Historial de movimientos de tu cuenta
      </Text>

      {transactionsLoading ? (
        <View style={styles.messageCard} lightColor="#ffffff" darkColor="#1f2937">
          <ActivityIndicator size="large" color="#4f46e5" />
          <Text style={styles.message} lightColor="#6b7280" darkColor="#9ca3af">
            Cargando transacciones...
          </Text>
        </View>
      ) : error ? (
        <View style={styles.messageCard} lightColor="#ffffff" darkColor="#1f2937">
          <Text style={styles.error} lightColor="#b91c1c" darkColor="#fca5a5">
            {error}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setReload((value) => value + 1)}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : transactions.length === 0 ? (
        <View style={styles.messageCard} lightColor="#ffffff" darkColor="#1f2937">
          <Text style={styles.message} lightColor="#6b7280" darkColor="#9ca3af">
            Todavía no tienes transacciones registradas.
          </Text>
        </View>
      ) : (
        transactions.map((transaction) => (
          <View
            key={transaction.id}
            style={styles.card}
            lightColor="#ffffff"
            darkColor="#1f2937"
          >
            <View style={styles.cardHeader} lightColor="transparent" darkColor="transparent">
              <View lightColor="transparent" darkColor="transparent">
                <Text style={styles.date} lightColor="#6b7280" darkColor="#9ca3af">
                  {formatDate(transaction.date)}
                </Text>
                <Text style={styles.merchant}>
                  {transaction.merchant ?? 'Comercio no especificado'}
                </Text>
              </View>
              <Text style={styles.total}>
                {formatAmount(transaction.total)}
              </Text>
            </View>

            <View
              style={styles.separator}
              lightColor="#e5e7eb"
              darkColor="#374151"
            />

            <View style={styles.detailsGrid} lightColor="transparent" darkColor="transparent">
              <Detail label="Tipo" value={transaction.type} />
              <Detail label="Categoría" value={transaction.category} />
              <Detail label="Subcategoría" value={transaction.subcategory} />
              <Detail label="Cuenta" value={transaction.account} />
              <Detail label="Banco" value={transaction.bank} />
              <Detail label="Tipo de cuenta" value={transaction.accountType} />
              <Detail
                label="Saldo de la cuenta"
                value={
                  transaction.accountBalance === null
                    ? null
                    : formatAmount(transaction.accountBalance)
                }
              />
              <Detail label="Frecuencia" value={transaction.frequency} />
              <Detail label="ID de transacción" value={transaction.id} />
              {transaction.extraDetails.map((detail) => (
                <Detail
                  key={`${transaction.id}-${detail.label}`}
                  label={detail.label}
                  value={detail.value}
                />
              ))}
            </View>

            {transaction.items.length > 0 ? (
              <>
                <Text style={styles.sectionTitle}>Artículos</Text>
                {transaction.items.map((item, index) => (
                  <View
                    key={`${transaction.id}-item-${index}`}
                    style={styles.itemContainer}
                    lightColor="transparent"
                    darkColor="transparent"
                  >
                    <View
                      style={styles.itemRow}
                      lightColor="transparent"
                      darkColor="transparent"
                    >
                      <Text style={styles.itemName}>{item.product}</Text>
                      <Text style={styles.itemPrice}>
                        {formatAmount(item.price)}
                      </Text>
                    </View>
                    {item.category || item.subcategory || item.tags.length > 0 ? (
                      <Text
                        style={styles.itemMetadata}
                        lightColor="#6b7280"
                        darkColor="#9ca3af"
                      >
                        {[item.category, item.subcategory]
                          .filter(Boolean)
                          .join(' · ')}
                        {item.tags.length > 0
                          ? `${item.category || item.subcategory ? ' · ' : ''}${item.tags
                              .map((tag) => `#${tag}`)
                              .join(' ')}`
                          : ''}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </>
            ) : null}

            {transaction.tags.length > 0 ? (
              <View style={styles.tags} lightColor="transparent" darkColor="transparent">
                {transaction.tags.map((tag) => (
                  <Text
                    key={`${transaction.id}-${tag}`}
                    style={[
                      styles.tag,
                      {
                        backgroundColor:
                          colorScheme === 'dark' ? '#3730a3' : '#e0e7ff',
                      },
                    ]}
                    lightColor="#4338ca"
                    darkColor="#c7d2fe"
                  >
                    #{tag}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.detail} lightColor="transparent" darkColor="transparent">
      <Text style={styles.detailLabel} lightColor="#6b7280" darkColor="#9ca3af">
        {label}
      </Text>
      <Text style={styles.detailValue}>{value}</Text>
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
    flexGrow: 1,
    padding: 24,
    paddingBottom: 36,
  },
  heading: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 16,
    marginTop: 6,
    marginBottom: 24,
  },
  card: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  date: {
    fontSize: 13,
    marginBottom: 4,
  },
  merchant: {
    fontSize: 20,
    fontWeight: '600',
  },
  total: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'right',
  },
  separator: {
    height: 1,
    marginVertical: 16,
  },
  detailsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  detail: {
    minWidth: '42%',
    flexGrow: 1,
  },
  detailLabel: {
    fontSize: 12,
    marginBottom: 3,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 18,
    marginBottom: 8,
  },
  itemContainer: {
    paddingVertical: 6,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  itemName: {
    flex: 1,
    fontSize: 14,
  },
  itemMetadata: {
    fontSize: 12,
    marginTop: 4,
  },
  itemPrice: {
    fontSize: 14,
    fontWeight: '500',
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  tag: {
    overflow: 'hidden',
    borderRadius: 12,
    paddingVertical: 5,
    paddingHorizontal: 9,
    backgroundColor: '#e0e7ff',
    fontSize: 12,
    fontWeight: '600',
  },
  messageCard: {
    alignItems: 'center',
    borderRadius: 16,
    padding: 24,
    gap: 12,
  },
  message: {
    fontSize: 15,
    textAlign: 'center',
  },
  error: {
    fontSize: 15,
    textAlign: 'center',
  },
  retryButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  retryText: {
    color: '#4f46e5',
    fontWeight: '600',
  },
});
