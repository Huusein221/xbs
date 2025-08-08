// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
// If you're on Node 18+, fetch is global; otherwise: import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors()); // you can restrict origins later
const PORT = process.env.PORT || 3000;

const XBS_URL = "https://mtapi.net/?testMode=1";
const COUNTRY_WHITELIST = new Set(["ES", "FR", "PL"]);

// simple in-memory cache (per country)
let cache = { key: null, expires: 0, data: null };
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/apps/xbs-pudo", async (req, res) => {
  try {
    const country = String(req.query.country || "").toUpperCase();
    if (!country) {
      return res.status(400).json({ error: "Country query param is required, e.g. ?country=FR" });
    }
    if (!COUNTRY_WHITELIST.has(country)) {
      return res.status(400).json({ error: `Unsupported country: ${country}` });
    }

    // serve from cache
    if (cache.key === country && cache.expires > Date.now()) {
      res.set("Cache-Control", "public, max-age=600"); // 10 min CDN/browser
      return res.json({ locations: cache.data });
    }

    // 1) call XBS
    const payload = {
      Apikey: process.env.XBS_APIKEY,
      Command: "GetLocationsDaily",
      Location: { Country: country },
    };

    const apiRes = await fetch(XBS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await apiRes.json();

    if (!apiRes.ok || json.ErrorLevel > 0) {
      return res.status(502).json({
        error: json.Error || `XBS responded ${apiRes.status}`,
        raw: json,
      });
    }

    const points = Array.isArray(json.Location) ? json.Location : [];

    // 2) filter by carrier for FR/PL
    const filtered = points.filter((loc) => {
      const c = (loc.Carrier || "").toLowerCase();
      if (country === "FR") return c.includes("colis") && c.includes("prive"); // covers "Colis Privé"
      if (country === "PL") return c.includes("inpost"); // covers "InPost Collect Service"
      return true;
    });

    // 3) trim/shape fields and coerce lat/lng to numbers
    const locations = filtered.map((loc) => ({
      Id: loc.Id,
      Name: loc.Name,
      Address1: loc.Address1,
      Zip: loc.Zip,
      City: loc.City,
      Carrier: loc.Carrier,
      Latitude: loc.Latitude != null ? Number(loc.Latitude) : null,
      Longitude: loc.Longitude != null ? Number(loc.Longitude) : null,
    }));

    // cache result
    cache = { key: country, expires: Date.now() + TTL_MS, data: locations };

    res.set("Cache-Control", "public, max-age=600");
    return res.json({ locations });
  } catch (err) {
    console.error("🚨 Error in /apps/xbs-pudo:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ PUDO server listening on http://localhost:${PORT}`);
});
