// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // or omit if using Node18+
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors()); // allow all origins
app.use(express.json()); // parse JSON bodies

const PORT = process.env.PORT || 3000;

// Helper function to calculate total weight
function calculateWeight(lineItems) {
  return lineItems.reduce((total, item) => {
    return total + (item.grams * item.quantity / 1000); // Convert grams to kg
  }, 0);
}

// Helper function to check if order uses InPost shipping
function isInPostOrder(order) {
  const shippingLines = order.shipping_lines || [];
  return shippingLines.some(line => {
    const title = line.title || '';
    return title.includes('InPost z Hiszpanii') || 
           title.includes('France-Continent (Point Pack et Locker)');
  });
}

// Helper function to get country from InPost shipping method
function getInPostCountry(order) {
  const shippingLines = order.shipping_lines || [];
  const inpostLine = shippingLines.find(line => {
    const title = line.title || '';
    return title.includes('InPost z Hiszpanii') || 
           title.includes('France-Continent (Point Pack et Locker)');
  });
  
  if (inpostLine) {
    if (inpostLine.title.includes('InPost z Hiszpanii')) return 'PL';
    if (inpostLine.title.includes('France-Continent')) return 'FR';
  }
  
  return null;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Get PUDO locations for France and Poland
app.get("/apps/xbs-pudo", async (req, res) => {
  const country = req.query.country;
  const zip = req.query.zip;
  const city = req.query.city;

  if (!country) {
    return res.status(400).json({ 
      error: "Country query param is required, e.g. ?country=FR" 
    });
  }

  // For specific location search, use GetLocations instead of GetLocationsDaily
  const useSpecificLocation = zip && (country.toUpperCase() === 'IT' ? city : true);
  
  try {
    let requestBody;
    
    if (useSpecificLocation) {
      // Use GetLocations for specific zip/city searches
      requestBody = {
        Apikey: process.env.XBS_APIKEY,
        Command: "GetLocations",
        Location: {
          Country: country.toUpperCase(),
          Zip: zip,
          ...(country.toUpperCase() === 'IT' && city ? { City: city } : {})
        }
      };
    } else {
      // Use GetLocationsDaily for full country list
      requestBody = {
        Apikey: process.env.XBS_APIKEY,
        Command: "GetLocationsDaily",
        Location: { 
          Country: country.toUpperCase(),
          ShowTemporaryOutOfService: false
        }
      };
    }

    console.log('🔍 XBS API Request:', JSON.stringify(requestBody, null, 2));

    // Call the XBS API
    const apiRes = await fetch("https://mtapi.net/?testMode=1", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!apiRes.ok) {
      throw new Error(`XBS API responded with status ${apiRes.status}`);
    }

    const data = await apiRes.json();
    console.log('📦 XBS API Response ErrorLevel:', data.ErrorLevel);

    if (data.ErrorLevel !== 0) {
      throw new Error(`XBS API Error: ${data.Error || 'Unknown error'}`);
    }

    const points = data.Location || [];
    console.log(`📍 Found ${points.length} locations for ${country.toUpperCase()}`);

    // Filter for specific carriers based on country
    const filtered = points.filter((loc) => {
      const carrier = loc.Carrier || '';
      
      if (country.toUpperCase() === "FR") {
        // For France, look for Colis Prive carriers
        return carrier.toLowerCase().includes("colis prive");
      }
      
      if (country.toUpperCase() === "PL") {
        // For Poland, look for InPost carriers
        return carrier.toLowerCase().includes("inpost");
      }
      
      // For other countries, return all
      return true;
    });

    console.log(`✅ Filtered to ${filtered.length} locations for carrier requirements`);

    // Transform to the format you need
    const locations = filtered.map((loc) => ({
      id: loc.Id,
      name: loc.Name,
      address1: loc.Address1,
      address2: loc.Address2 || '',
      city: loc.City,
      zip: loc.Zip,
      country: loc.CountryCode,
      carrier: loc.Carrier,
      service: loc.Service,
      latitude: loc.Latitude,
      longitude: loc.Longitude,
      businessHours: loc.BusinessHours || ''
    }));

    res.json({ 
      success: true,
      country: country.toUpperCase(),
      totalFound: points.length,
      filtered: locations.length,
      locations: locations
    });

  } catch (err) {
    console.error("🚨 Error in /apps/xbs-pudo:", err);
    res.status(500).json({ 
      success: false,
      error: err.message,
      country: country.toUpperCase()
    });
  }
});

// Create a shipping label with PUDO location
app.post("/apps/xbs-shipment", async (req, res) => {
  try {
    const {
      shipperReference,
      service = "CLLCT", // Collect service for PUDO
      weight,
      value,
      currency = "EUR",
      pudoLocationId,
      consignorAddress,
      consigneeAddress, // This should be customer's home address, not PUDO address
      products
    } = req.body;

    // Validate required fields
    if (!pudoLocationId || !consigneeAddress || !products || !weight) {
      return res.status(400).json({
        error: "Missing required fields: pudoLocationId, consigneeAddress, products, weight"
      });
    }

    const requestBody = {
      Apikey: process.env.XBS_APIKEY,
      Command: "OrderShipment",
      Shipment: {
        LabelFormat: "PDF",
        ShipperReference: shipperReference || `SHOP-${Date.now()}`,
        Service: service,
        Weight: weight.toString(),
        WeightUnit: "kg",
        Value: value.toString(),
        Currency: currency,
        CustomsDuty: "DDU",
        Description: products.map(p => p.Description).join(", "),
        DeclarationType: "SaleOfGoods",
        DangerousGoods: "N",
        ConsignorAddress: consignorAddress,
        ConsigneeAddress: {
          ...consigneeAddress,
          PudoLocationId: pudoLocationId // This tells XBS to use the PUDO location
        },
        Products: products
      }
    };

    console.log('🏷️ Creating XBS shipment with PUDO:', pudoLocationId);

    const apiRes = await fetch("https://mtapi.net/?testMode=1", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!apiRes.ok) {
      throw new Error(`XBS API responded with status ${apiRes.status}`);
    }

    const data = await apiRes.json();

    if (data.ErrorLevel !== 0) {
      throw new Error(`XBS API Error: ${data.Error || 'Unknown error'}`);
    }

    res.json({
      success: true,
      trackingNumber: data.Shipment.TrackingNumber,
      shipperReference: data.Shipment.ShipperReference,
      carrier: data.Shipment.Carrier,
      labelImage: data.Shipment.LabelImage,
      labelFormat: data.Shipment.LabelFormat
    });

  } catch (err) {
    console.error("🚨 Error creating XBS shipment:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// NEW: Complete InPost order after PUDO selection
app.post("/apps/complete-inpost-order", async (req, res) => {
  try {
    const {
      orderId,
      orderNumber,
      pudoLocationId,
      orderData // Full Shopify order data
    } = req.body;

    console.log(`📦 Completing InPost order ${orderNumber} with PUDO: ${pudoLocationId}`);

    if (!isInPostOrder(orderData)) {
      return res.status(400).json({
        success: false,
        error: 'This order does not use InPost shipping'
      });
    }

    const shipping = orderData.shipping_address;
    const detectedCountry = getInPostCountry(orderData);

    if (!detectedCountry) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine country from InPost shipping method'
      });
    }

    // Create shipment with selected PUDO location
    const shipmentData = {
      shipperReference: `SHOP-${orderNumber}`,
      weight: calculateWeight(orderData.line_items),
      value: parseFloat(orderData.total_price),
      currency: orderData.currency,
      pudoLocationId: pudoLocationId, // The selected pickup point
      consignorAddress: {
        Name: "Andypola", // UPDATE THIS with your store name
        Address1: "Calafates 6", // UPDATE THIS with your warehouse address
        City: "Santa Pola", // UPDATE THIS
        Zip: "03130", // UPDATE THIS
        CountryCode: "ES" // UPDATE THIS if different
      },
      consigneeAddress: {
        Name: `${shipping.first_name} ${shipping.last_name}`,
        Address1: shipping.address1,
        Address2: shipping.address2 || '',
        City: shipping.city,
        Zip: shipping.zip,
        CountryCode: detectedCountry,
        Mobile: shipping.phone || '',
        Email: orderData.email
      },
      products: orderData.line_items.map(item => ({
        Description: item.title,
        Quantity: item.quantity,
        Weight: (item.grams * item.quantity) / 1000,
        Value: parseFloat(item.price),
        Currency: orderData.currency
      }))
    };

    console.log('🚀 Creating XBS shipment for country:', detectedCountry);

    // Call your existing shipment creation endpoint
    const response = await fetch(`${req.protocol}://${req.get('host')}/apps/xbs-shipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(shipmentData)
    });

    const result = await response.json();

    if (result.success) {
      console.log('✅ InPost shipment created:', result.trackingNumber);
      
      res.json({
        success: true,
        trackingNumber: result.trackingNumber,
        carrier: result.carrier,
        country: detectedCountry,
        message: 'Order successfully sent to InPost/Spring'
      });
    } else {
      throw new Error(result.error);
    }

  } catch (error) {
    console.error('❌ Error completing InPost order:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// NEW: Check if order needs PUDO selection
app.get("/apps/check-inpost-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // This endpoint will be called from the thank you page
    // For now, we'll return that PUDO selection is needed
    // Later you can add logic to check if PUDO was already selected
    
    res.json({
      needsPudoSelection: true,
      orderId: orderId
    });
    
  } catch (error) {
    console.error('❌ Error checking InPost order:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get available services for your account
app.get("/apps/xbs-services", async (req, res) => {
  try {
    const requestBody = {
      Apikey: process.env.XBS_APIKEY,
      Command: "GetServices"
    };

    const apiRes = await fetch("https://mtapi.net/?testMode=1", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!apiRes.ok) {
      throw new Error(`XBS API responded with status ${apiRes.status}`);
    }

    const data = await apiRes.json();

    res.json({
      success: true,
      allowedServices: data.Services.AllowedServices,
      allowedSpringClear: data.Services.AllowedSpringClear,
      allServices: data.Services.List
    });

  } catch (err) {
    console.error("🚨 Error getting XBS services:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Track a shipment
app.get("/apps/xbs-track/:trackingNumber", async (req, res) => {
  try {
    const { trackingNumber } = req.params;

    const requestBody = {
      Apikey: process.env.XBS_APIKEY,
      Command: "TrackShipment",
      Shipment: {
        TrackingNumber: trackingNumber
      }
    };

    const apiRes = await fetch("https://mtapi.net/?testMode=1", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!apiRes.ok) {
      throw new Error(`XBS API responded with status ${apiRes.status}`);
    }

    const data = await apiRes.json();

    res.json({
      success: true,
      trackingNumber: data.Shipment.TrackingNumber,
      carrier: data.Shipment.Carrier,
      events: data.Shipment.Events || []
    });

  } catch (err) {
    console.error("🚨 Error tracking XBS shipment:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ XBS PUDO server listening on http://localhost:${PORT}`);
  console.log(`📍 Available endpoints:`);
  console.log(`   GET  /health - Health check`);
  console.log(`   GET  /apps/xbs-pudo?country=FR&zip=75001 - Get PUDO locations`);
  console.log(`   POST /apps/xbs-shipment - Create shipment with PUDO`);
  console.log(`   POST /apps/complete-inpost-order - Complete InPost order with PUDO selection`);
  console.log(`   GET  /apps/check-inpost-order/:orderId - Check if order needs PUDO`);
  console.log(`   GET  /apps/xbs-services - Get available services`);
  console.log(`   GET  /apps/xbs-track/:trackingNumber - Track shipment`);
});
