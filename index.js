const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { ethers } = require("ethers");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// Charge tous les marchés depuis Polymarket et les sauvegarde dans Supabase
async function syncMarkets() {
  console.log("Synchronisation des marchés...");
  let allMarkets = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({ limit: 100, offset, order: "volume24hr", ascending: "false" });
    const data = await polyFetch(`${GAMMA_HOST}/markets?${params}`);
    if (!data || !Array.isArray(data) || data.length === 0) break;
    allMarkets = allMarkets.concat(data);
    if (data.length < 100) break;
    offset += 100;
  }
  // Filtre les marchés actifs uniquement
  const active = allMarkets.filter(m => m.active && !m.closed);
  // Sauvegarde dans Supabase
  const { error } = await supabase.from("markets").upsert(
    active.map(m => ({ id: m.id, data: m, updated_at: new Date().toISOString() })),
    { onConflict: "id" }
  );
  if (error) console.error("Erreur sync:", error.message);
  else console.log(`${active.length} marchés synchronisés`);
}

// Récupère les marchés depuis Supabase (instantané)
app.get("/markets", async (req, res) => {
  try {
    const { search = "" } = req.query;
    let query = supabase.from("markets").select("data");
    const { data, error } = await query;
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/price/:tokenId", async (req, res) => {
  try {
    const { side = "BUY" } = req.query;
    const data = await polyFetch(`${CLOB_HOST}/price?token_id=${req.params.tokenId}&side=${side}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/prices", async (req, res) => {
  try {
    const { tokenIds } = req.body;
    const data = await polyFetch(`${CLOB_HOST}/prices`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tokenIds),
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/orderbook/:tokenId", async (req, res) => {
  try {
    const data = await polyFetch(`${CLOB_HOST}/book?token_id=${req.params.tokenId}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/positions", async (req, res) => {
  try {
    const path    = `/data/positions?user=${FUNDER_ADDRESS}&sizeThreshold=0`;
    const headers = buildL2Headers("GET", path);
    const data    = await polyFetch(`${CLOB_HOST}${path}`, { headers });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/orders", async (req, res) => {
  try {
    const path    = `/orders?maker_address=${FUNDER_ADDRESS}`;
    const headers = buildL2Headers("GET", path);
    const data    = await polyFetch(`${CLOB_HOST}${path}`, { headers });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/trades", async (req, res) => {
  try {
    const path    = `/data/trades?maker_address=${FUNDER_ADDRESS}&limit=50`;
    const headers = buildL2Headers("GET", path);
    const data    = await polyFetch(`${CLOB_HOST}${path}`, { headers });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/order/:orderId", async (req, res) => {
  try {
    const path    = `/order`;
    const body    = JSON.stringify({ orderID: req.params.orderId });
    const headers = buildL2Headers("DELETE", path, body);
    const data    = await polyFetch(`${CLOB_HOST}${path}`, { method: "DELETE", headers, body });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lance une sync manuelle
app.post("/sync", async (req, res) => {
  await syncMarkets();
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, wallet: FUNDER_ADDRESS || "NON CONFIGURÉ", hasKey: !!PRIVATE_KEY, hasAPI: !!API_KEY });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Polymarket backend running on :${PORT}`);
  // Sync au démarrage puis toutes les heures
  await syncMarkets();
  setInterval(syncMarkets, 60 * 60 * 1000);
});
