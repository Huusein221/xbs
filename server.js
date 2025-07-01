// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // or omit if using Node18+
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors()); // allow all origins

const PORT = process.env.PORT || 3000;
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
app.get("/apps/xbs-pudo", async (req, res) => {
  const country = req.query.country;
  if (!country) {
    return res
      .status(400)
      .json({ error: "Country query param is required, e.g. ?country=FR" });
  }

  try {
    // 1) call the XBS API
    const apiRes = await fetch("https://mtapi.net/?testMode=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Apikey: process.env.XBS_APIKEY,
        Command: "GetLocationsDaily",
        Location: { Country: country.toUpperCase() },
      }),
    });

    if (!apiRes.ok) {
      throw new Error(`XBS responded ${apiRes.status}`);
    }

    const data = await apiRes.json();
    const points = data.Location || [];

    // 2) filter for FR or PL carriers
    const filtered = points.filter((loc) => {
      if (country.toUpperCase() === "FR") {
        return loc.Carrier?.includes("Colis Prive");
      }
      if (country.toUpperCase() === "PL") {
        return loc.Carrier?.includes("InPost Collect Service");
      }
      return true;
    });

    // 3) trim to the fields you need
// pseudo-code in server.js
const springRes = await springGetLocations(country);
const locations = springRes.Location.map(loc => ({
  Id:        loc.Id,
  Name:      loc.Name,
  Address1:  loc.Address1,
  Zip:       loc.Zip,
  City:      loc.City,
  // ← add these:
  Carrier:   loc.Carrier,
  Latitude:  loc.Latitude,
  Longitude: loc.Longitude
}));
res.json({ locations });

    // 4) respond with CORS headers
    res.json({ locations });
  } catch (err) {
    console.error("🚨 Error in /apps/xbs-pudo:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ PUDO server listening on http://localhost:${PORT}`);
});
