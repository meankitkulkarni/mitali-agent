(function () {
  const cfg = window.MODERNBREAD_SUPABASE;
  if (!cfg || !cfg.url || !cfg.anonKey) throw new Error("Missing ModernBread Supabase configuration.");
  if (!window.supabase || !window.supabase.createClient) throw new Error("Supabase JavaScript client failed to load.");

  const client = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const TABLES = {
    products: "mb_products",
    merchants: "mb_merchants",
    orders: "mb_orders",
    expenses: "mb_expenses",
    stockEntries: "mb_stock_entries",
    trays: "mb_trays",
    openingBal: "mb_opening_balances",
    dailyDsr: "mb_daily_dsr_snapshots"
  };

  function tableFor(collectionName) {
    const table = TABLES[collectionName];
    if (!table) throw new Error("Unknown collection: " + collectionName);
    return table;
  }

  function makeDoc(row) {
    return { id: row.id, data: () => ({ id: row.id, ...(row.data || {}) }) };
  }

  function makeSnapshot(rows) {
    return { docs: (rows || []).map(makeDoc) };
  }

  async function fetchCollection(collectionName) {
    const { data, error } = await client
      .from(tableFor(collectionName))
      .select("id,data")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  function collection(collectionName) {
    const table = tableFor(collectionName);
    return {
      doc(docId) {
        return {
          async set(value, options) {
            const current = options && options.merge
              ? await client.from(table).select("data").eq("id", docId).maybeSingle()
              : { data: null, error: null };
            if (current.error) throw current.error;
            const next = options && options.merge
              ? { ...((current.data && current.data.data) || {}), ...(value || {}) }
              : (value || {});
            const { error } = await client
              .from(table)
              .upsert({ id: docId, data: next, deleted_at: null }, { onConflict: "id" });
            if (error) throw error;
          },
          async update(value) {
            const current = await client.from(table).select("data").eq("id", docId).maybeSingle();
            if (current.error) throw current.error;
            const next = { ...((current.data && current.data.data) || {}), ...(value || {}) };
            const { error } = await client
              .from(table)
              .upsert({ id: docId, data: next, deleted_at: null }, { onConflict: "id" });
            if (error) throw error;
          },
          async delete() {
            const { error } = await client.from(table).update({ deleted_at: new Date().toISOString() }).eq("id", docId);
            if (error) throw error;
          }
        };
      },
      async get() {
        return makeSnapshot(await fetchCollection(collectionName));
      },
      onSnapshot(callback) {
        let closed = false;
        const emit = () => fetchCollection(collectionName)
          .then(rows => { if (!closed) callback(makeSnapshot(rows)); })
          .catch(console.error);
        emit();
        const channel = client
          .channel("mb-" + collectionName)
          .on("postgres_changes", { event: "*", schema: "public", table }, emit)
          .subscribe();
        return () => {
          closed = true;
          client.removeChannel(channel);
        };
      }
    };
  }

  window.supabaseClient = client;
  window.db = {
    collection,
    batch() {
      const ops = [];
      return {
        set(ref, value, options) { ops.push(() => ref.set(value, options)); },
        commit() { return Promise.all(ops.map(op => op())); }
      };
    }
  };
})();
