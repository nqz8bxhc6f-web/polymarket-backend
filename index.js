// ═══════════════════════════════════════════════════════════════
// POLYMARKET PRO — BACKEND NODE.JS
// Déploie sur Railway.app ou Render.com (gratuit)
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { ethers } = require("ethers");

const app  = express();
app.use(cors());
app.use(express.json());

// ── Variables d'environnement (à configurer sur Railway/Render) ──
const PRIVATE_KEY        = process.env.PRIVATE_KEY;        // ta clé privée 0x...
const API_KEY            = process.env.POLY_API_KEY;       // généré par le script
const API_SECRET         = process.env.POLY_API_SECRET;
const API_PASSPHRASE     = process.env.POLY_API_PASSPHRASE;
const FUNDER_ADDRESS     = process.env.FUNDER_ADDRESS;     // ton adresse Polymarket
const CLOB_HOST          = "https://clob.polymarket.com";
const GAMMA_HOST         = "https://gamma-api.polymarket.com";

// ── Helpers d'authentification L2 ──
function buildL2Headers(method, path, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message   = timestamp + method.toUpperCase() + path + (body || "");
  const signature = crypto
    .createHmac("sha256", Buffer.from(API_SECRET, "base64"))
    .update(message)
    .digest("base64");
  return {
    "POLY-API-KEY":    API_KEY,
    "POLY-SIGNATURE":  signature,
    "POLY-TIMESTAMP":  timestamp,
    "POLY-PASSPHRASE": API_PASSPHRASE,
    "Content-Type":    "application/json",
  };
}

// ── Helper fetch ──
async function polyFetch(url, opts = {}) {
  const res  = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { error: text }; }
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS PUBLICS (pas d'auth requise)
// ═══════════════════════════════════════════════════════════════

// Récupère les marchés politiques les plus actifs
app.get("/markets", async (req, res) => {
  try {
    const { limit = 20, tag = "politics", search = "" } = req.query;
    const params = new URLSearchParams({
      active:    "true",
      limit,
      order:     "volume24hr",
      ascending: "false",
      ...(tag    ? { tag_slug: tag } : {}),
      ...(search ? { question:  search } : {}),
    });
    const data = await polyFetch(`${GAMMA_HOST}/markets?${params}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Prix en temps réel d'un marché (token_id)
app.get("/price/:tokenId", async (req, res) => {
  try {
    const { side = "BUY" } = req.query;
    const data = await polyFetch(
      `${CLOB_HOST}/price?token_id=${req.params.tokenId}&side=${side}`
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Prix de plusieurs marchés d'un coup
app.post("/prices", async (req, res) => {
  try {
    const { tokenIds } = req.body; // array of { token_id, side }
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

// Order book complet
app.get("/orderbook/:tokenId", async (req, res) => {
  try {
    const data = await polyFetch(
      `${CLOB_HOST}/book?token_id=${req.params.tokenId}`
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historique des prix (graphique)
app.get("/history/:tokenId", async (req, res) => {
  try {
    const { interval = "1d" } = req.query;
    const data = await polyFetch(
      `${CLOB_HOST}/prices-history?market=${req.params.tokenId}&interval=${interval}&fidelity=60`
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS PRIVÉS (auth L2 requise)
// ═══════════════════════════════════════════════════════════════

// Mes positions ouvertes
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

// Mes ordres en cours
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

// Mon historique de trades
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

// Placer un ordre
// Body: { tokenId, price, size, side: "BUY"|"SELL", orderType: "GTC"|"FOK" }
app.post("/order", async (req, res) => {
  try {
    const { tokenId, price, size, side, orderType = "GTC" } = req.body;

    // Signer l'ordre EIP-712
    const wallet   = new ethers.Wallet(PRIVATE_KEY);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const domain = {
      name:              "Polymarket CTF Exchange",
      version:           "1",
      chainId:           137,
      verifyingContract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    };

    const types = {
      Order: [
        { name: "salt",       type: "uint256" },
        { name: "maker",      type: "address" },
        { name: "signer",     type: "address" },
        { name: "taker",      type: "address" },
        { name: "tokenId",    type: "uint256" },
        { name: "makerAmount",type: "uint256" },
        { name: "takerAmount",type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce",      type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side",       type: "uint8"   },
        { name: "signatureType", type: "uint8"},
      ],
    };

    const isBuy       = side === "BUY";
    const priceNum    = parseFloat(price);
    const sizeNum     = parseFloat(size);
    const makerAmount = isBuy
      ? Math.round(priceNum * sizeNum * 1e6)
      : Math.round(sizeNum * 1e6);
    const takerAmount = isBuy
      ? Math.round(sizeNum * 1e6)
      : Math.round(priceNum * sizeNum * 1e6);

    const orderData = {
      salt:        BigInt(Math.floor(Math.random() * 1e15)),
      maker:       FUNDER_ADDRESS,
      signer:      wallet.address,
      taker:       "0x0000000000000000000000000000000000000000",
      tokenId:     BigInt(tokenId),
      makerAmount: BigInt(makerAmount),
      takerAmount: BigInt(takerAmount),
      expiration:  BigInt(deadline),
      nonce:       BigInt(0),
      feeRateBps:  BigInt(0),
      side:        isBuy ? 0 : 1,
      signatureType: 0,
    };

    const signature = await wallet.signTypedData(domain, types, orderData);

    const body = JSON.stringify({
      order: {
        ...orderData,
        salt:        orderData.salt.toString(),
        tokenId:     orderData.tokenId.toString(),
        makerAmount: orderData.makerAmount.toString(),
        takerAmount: orderData.takerAmount.toString(),
        expiration:  orderData.expiration.toString(),
        nonce:       orderData.nonce.toString(),
        feeRateBps:  orderData.feeRateBps.toString(),
        signature,
      },
      owner:    FUNDER_ADDRESS,
      orderType,
    });

    const path    = "/order";
    const headers = buildL2Headers("POST", path, body);
    const data    = await polyFetch(`${CLOB_HOST}${path}`, {
      method:  "POST",
      headers,
      body,
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Annuler un ordre
app.delete("/order/:orderId", async (req, res) => {
  try {
    const path    = `/order`;
    const body    = JSON.stringify({ orderID: req.params.orderId });
    const headers = buildL2Headers("DELETE", path, body);
    const data    = await polyFetch(`${CLOB_HOST}${path}`, {
      method:  "DELETE",
      headers,
      body,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sanity check
app.get("/health", (req, res) => {
  res.json({
    ok:      true,
    wallet:  FUNDER_ADDRESS || "NON CONFIGURÉ",
    hasKey:  !!PRIVATE_KEY,
    hasAPI:  !!API_KEY,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Polymarket backend running on :${PORT}`));
