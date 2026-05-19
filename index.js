const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { ethers } = require("ethers");

const app  = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const API_KEY        = process.env.POLY_API_KEY;
const API_SECRET     = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
const CLOB_HOST      = "https://clob.polymarket.com";
const GAMMA_HOST     = "https://gamma-api.polymarket.com";

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

app.get("/markets", async (req, res) => {
  try {
    const { limit = 100, offset = 0, search = "" } = req.query;
    const params = new URLSearchParams({
      active:    "true",
      limit,
      offset,
      order:     "volume24hr",
      ascending: "false",
      ...(search ? { question: search } : {}),
    });
    const data = await polyFetch(`${GAMMA_HOST}/markets?${params}`);
    res.json(data);
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
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(tokenIds),
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

app.get("/health", (req, res) => {
  res.json({ ok: true, wallet: FUNDER_ADDRESS || "NON CONFIGURÉ", hasKey: !!PRIVATE_KEY, hasAPI: !!API_KEY });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Polymarket backend running on :${PORT}`));
