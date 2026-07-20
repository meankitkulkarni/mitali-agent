(function () {
  const cfg = window.MODERNBREAD_SUPABASE;
  if (!cfg || !cfg.url || !cfg.anonKey) throw new Error("Missing ModernBread Supabase configuration.");
  if (!window.supabase || !window.supabase.createClient) throw new Error("Supabase JavaScript client failed to load.");

  const client = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const TABLE = "mb_documents";

  function makeDoc(row) {
    return { id: row.id, data: () => ({ id: row.id, ...(row.data || {}) }) };
  }

  function makeSnapshot(rows) {
    return { docs: (rows || []).map(makeDoc) };
  }

  async function fetchCollection(collectionName) {
    const { data, error } = await client
      .from(TABLE)
      .select("id,data")
      .eq("collection", collectionName)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  function collection(collectionName) {
    return {
      doc(docId) {
        return {
          async set(value, options) {
            const current = options && options.merge
              ? await client.from(TABLE).select("data").eq("collection", collectionName).eq("id", docId).maybeSingle()
              : { data: null, error: null };
            if (current.error) throw current.error;
            const next = options && options.merge
              ? { ...((current.data && current.data.data) || {}), ...(value || {}) }
              : (value || {});
            const { error } = await client
              .from(TABLE)
              .upsert({ collection: collectionName, id: docId, data: next }, { onConflict: "collection,id" });
            if (error) throw error;
          },
          async update(value) {
            const current = await client.from(TABLE).select("data").eq("collection", collectionName).eq("id", docId).maybeSingle();
            if (current.error) throw current.error;
            const next = { ...((current.data && current.data.data) || {}), ...(value || {}) };
            const { error } = await client
              .from(TABLE)
              .upsert({ collection: collectionName, id: docId, data: next }, { onConflict: "collection,id" });
            if (error) throw error;
          },
          async delete() {
            const { error } = await client.from(TABLE).delete().eq("collection", collectionName).eq("id", docId);
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
          .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: TABLE,
            filter: "collection=eq." + collectionName
          }, emit)
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
