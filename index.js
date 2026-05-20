const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const API_KEY        = process.env.POLY_API_KEY;
const API_SECRET     = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const CLOB_HOST      = "https://clob.polymarket.com";
const GAMMA_HOST     = "https://gamma-api.polymarket.com";

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

function buildL2Headers(method, path, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message   = timestamp + method.toUpperCase() + path + (body || "");
  const signature = crypto.createHmac("sha256", Buffer.from(API_SECRET, "base64")).update(message).digest("base64");
  return {
    "POLY-API-KEY":    API_KEY,
    "POLY-SIGNATURE":  signature,
    "POLY-TIMESTAMP":  timestamp,
    "POLY-PASSPHRASE": API_PASSPHRASE,
    "Content-Type":    "application/json",
  };
}

async function polyFetch(url, opts = {}) {
  const res  = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function insertBatch(markets) {
  for (let i = 0; i < markets.length; i += 10) {
    const batch = markets.slice(i, i + 10);
    try {
      await supabase.from("markets").upsert(
        batch.map(m => ({ id: m.id, data: m, updated_at: new Date().toISOString() })),
        { onConflict: "id" }
      );
    } catch(e) {
      console.log("Erreur insert:", e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

// Sync uniquement les marchés ACTIFS et supprime les terminés
async function syncAll() {
  console.log("Sync marchés actifs...");
  let offset = 0;
  let total = 0;
  while (true) {
    const params = new URLSearchParams({
      limit: 50, offset,
      order: "volume24hr", ascending: "false",
      active: "true", closed: "false"
    });
    const data = await polyFetch(`${GAMMA_HOST}/markets?${params}`);
    if (!data || !Array.isArray(data) || data.length === 0) break;
    const active = data.filter(m => m.active && !m.closed);
    if (supabase && active.length > 0) await insertBatch(active);
    total += active.length;
    console.log(`${total} marchés actifs synchronisés`);
    if (data.length < 50) break;
    offset += 50;
    await new Promise(r => setTimeout(r, 2000));
  }
  // Supprime les marchés terminés
  if (supabase) {
    await supabase.from("markets").delete().eq("data->>active", "false");
    await supabase.from("markets").delete().eq("data->>closed", "true");
  }
  console.log("Sync terminée !");
}

app.get("/markets", async (req, res) => {
  try {
    const { search = "", limit = 100, offset = 0 } = req.query;
    if (supabase) {
      const { data, error } = await supabase
        .from("markets").select("data")
        .range(+offset, +offset + +limit - 1);
      if (error) throw new Error(error.message);
      let markets = data.map(r => r.data);
      if (search) {
        const s = search.toLowerCase();
        markets = markets.filter(m =>
          (m.question || "").toLowerCase().includes(s) ||
          (m.slug || "").toLowerCase().includes(s)
        );
      }
      res.json(markets);
    } else {
      const params = new URLSearchParams({ limit, offset, order: "volume24hr", ascending: "false" });
      const data = await polyFetch(`${GAMMA_HOST}/markets?${params}`);
      res.json(data);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/price/:tokenId", async (req, res) => {
  try {
    const { side = "BUY" } = req.query;
    const data = await polyFetch(`${CLOB_HOST}/price?token_id=${req.params.tokenId}&side=${side}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/prices", async (req, res) => {
  try {
    const { tokenIds } = req.body;
    const data = await polyFetch(`${CLOB_HOST}/prices`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tokenIds),
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/orderbook/:tokenId", async (req, res) => {
  try {
    const data = await polyFetch(`${CLOB_HOST}/book?token_id=${req.params.tokenId}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/positions", async (req, res) => {
  try {
    const path = `/data/positions?user=${FUNDER_ADDRESS}&sizeThreshold=0`;
    const data = await polyFetch(`${CLOB_HOST}${path}`, { headers: buildL2Headers("GET", path) });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/orders", async (req, res) => {
  try {
    const path = `/orders?maker_address=${FUNDER_ADDRESS}`;
    const data = await polyFetch(`${CLOB_HOST}${path}`, { headers: buildL2Headers("GET", path) });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/trades", async (req, res) => {
  try {
    const path = `/data/trades?maker_address=${FUNDER_ADDRESS}&limit=50`;
    const data = await polyFetch(`${CLOB_HOST}${path}`, { headers: buildL2Headers("GET", path) });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/order/:orderId", async (req, res) => {
  try {
    const path = `/order`;
    const body = JSON.stringify({ orderID: req.params.orderId });
    const data = await polyFetch(`${CLOB_HOST}${path}`, { method: "DELETE", headers: buildL2Headers("DELETE", path, body), body });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/sync", async (req, res) => {
  res.json({ ok: true, message: "Sync démarrée" });
  syncAll().catch(console.error);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, wallet: FUNDER_ADDRESS || "NON CONFIGURÉ", hasKey: !!PRIVATE_KEY, hasAPI: !!API_KEY, hasDB: !!supabase });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on :${PORT}`);
  // Sync au démarrage
  setTimeout((
