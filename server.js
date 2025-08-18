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

// NEW: Get Shopify order data
async function getShopifyOrder(orderNumber) {
  try {
    // For now, we'll create mock data based on the shipping method
    // Later you can integrate with Shopify Admin API if needed
    console.log('🔍 Getting order data for:', orderNumber);
    
    // Mock order data for testing - replace with real Shopify API call
    return {
      order_number: orderNumber,
      email: 'customer@example.com',
      total_price: '50.00',
      currency: 'EUR',
      shipping_address: {
        first_name: 'Test',
        last_name: 'Customer',
        address1: '123 Test Street',
        address2: '',
        city: 'Paris', // Default for testing
        zip: '75001',
        phone: '+33123456789'
      },
      shipping_lines: [
        {
          title: 'France-Continent (Point Pack et Locker)', // Mock InPost France
          price: '5.00'
        }
      ],
      line_items: [
        {
          title: 'Test Product',
          quantity: 1,
          price: '45.00',
          grams: 500
        }
      ]
    };
  } catch (error) {
    console.error('Error getting Shopify order:', error);
    return null;
  }
}

// NEW: Complete InPost order after PUDO selection
app.post("/apps/complete-inpost-order", async (req, res) => {
  try {
    const {
      orderId,
      orderNumber,
      pudoLocationId,
      country // We'll use the country from the frontend
    } = req.body;

    console.log(`📦 Completing InPost order ${orderNumber} with PUDO: ${pudoLocationId}`);

    if (!orderNumber) {
      return res.status(400).json({
        success: false,
        error: 'Order number is required'
      });
    }

    if (!pudoLocationId) {
      return res.status(400).json({
        success: false,
        error: 'PUDO location must be selected'
      });
    }

    // Get order data (mock for now)
    const orderData = await getShopifyOrder(orderNumber);
    
    if (!orderData) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Use the country passed from frontend or detect from order
    const detectedCountry = country || getInPostCountry(orderData) || 'FR';
    const shipping = orderData.shipping_address;

    console.log('🚀 Creating XBS shipment for country:', detectedCountry);

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

// NEW: PUDO Selection Page
app.get("/pudo-selection", (req, res) => {
  const orderId = req.query.orderId;
  const orderNumber = req.query.orderNumber;
  const country = req.query.country;

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Seleccionar Punto de Recogida InPost</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #f8f9fa;
          padding: 20px;
        }
        .container { 
          max-width: 1200px; 
          margin: 0 auto; 
          background: white; 
          border-radius: 12px; 
          overflow: hidden;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header { 
          background: linear-gradient(135deg, #0066cc, #004499);
          color: white; 
          padding: 30px; 
          text-align: center; 
        }
        .header h1 { margin-bottom: 10px; }
        .header p { opacity: 0.9; }
        .content { padding: 30px; }
        .order-info { 
          background: #f8f9fa; 
          padding: 20px; 
          border-radius: 8px; 
          margin-bottom: 30px;
          border-left: 4px solid #0066cc;
        }
        .search-section { margin-bottom: 30px; }
        .search-box { 
          display: flex; 
          gap: 10px; 
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        .search-box input { 
          flex: 1; 
          min-width: 200px;
          padding: 12px; 
          border: 2px solid #ddd; 
          border-radius: 6px; 
          font-size: 16px;
        }
        .search-box button { 
          padding: 12px 24px; 
          background: #0066cc; 
          color: white; 
          border: none; 
          border-radius: 6px; 
          cursor: pointer;
          font-size: 16px;
          transition: background 0.3s;
        }
        .search-box button:hover { background: #0052a3; }
        .search-box button:disabled { background: #ccc; cursor: not-allowed; }
        .loading { 
          text-align: center; 
          padding: 40px; 
          color: #666;
        }
        .locations-grid { 
          display: grid; 
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); 
          gap: 20px; 
          margin-bottom: 30px;
        }
        .location-card { 
          border: 2px solid #eee; 
          border-radius: 8px; 
          padding: 20px; 
          cursor: pointer;
          transition: all 0.3s;
        }
        .location-card:hover { 
          border-color: #0066cc; 
          box-shadow: 0 4px 12px rgba(0,102,204,0.15);
        }
        .location-card.selected { 
          border-color: #0066cc; 
          background: #f0f8ff;
        }
        .location-name { 
          font-weight: bold; 
          color: #333; 
          margin-bottom: 8px;
          font-size: 16px;
        }
        .location-address { 
          color: #666; 
          margin-bottom: 10px;
          line-height: 1.4;
        }
        .location-carrier { 
          background: #e3f2fd; 
          color: #1976d2; 
          padding: 4px 8px; 
          border-radius: 4px; 
          font-size: 12px;
          display: inline-block;
        }
        .confirm-section { 
          position: sticky; 
          bottom: 0; 
          background: white; 
          padding: 20px; 
          border-top: 2px solid #eee;
          text-align: center;
        }
        .confirm-btn { 
          background: #28a745; 
          color: white; 
          border: none; 
          padding: 15px 40px; 
          border-radius: 6px; 
          font-size: 18px; 
          cursor: pointer;
          transition: background 0.3s;
        }
        .confirm-btn:hover { background: #218838; }
        .confirm-btn:disabled { background: #ccc; cursor: not-allowed; }
        .error { 
          background: #f8d7da; 
          color: #721c24; 
          padding: 15px; 
          border-radius: 6px; 
          margin: 20px 0;
        }
        .success { 
          background: #d4edda; 
          color: #155724; 
          padding: 15px; 
          border-radius: 6px; 
          margin: 20px 0;
        }
        @media (max-width: 768px) {
          .container { margin: 10px; }
          .content { padding: 20px; }
          .search-box { flex-direction: column; }
          .search-box input, .search-box button { width: 100%; }
          .locations-grid { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📦 Seleccionar Punto de Recogida</h1>
          <p>Elige tu punto de recogida InPost preferido</p>
        </div>
        
        <div class="content">
          <div class="order-info">
            <h3>Información del Pedido</h3>
            <p><strong>Número de pedido:</strong> ${orderNumber || 'No especificado'}</p>
            <p><strong>País:</strong> ${country === 'PL' ? '🇵🇱 Polonia' : country === 'FR' ? '🇫🇷 Francia' : 'No especificado'}</p>
          </div>
          
          <div class="search-section">
            <h3>Buscar Puntos de Recogida</h3>
            <div class="search-box">
              <input type="text" id="zipInput" placeholder="Código postal (ej: 75001)" />
              <input type="text" id="cityInput" placeholder="Ciudad (opcional)" />
              <button onclick="searchLocations()">Buscar</button>
            </div>
          </div>
          
          <div id="loadingDiv" class="loading" style="display: none;">
            🔍 Buscando puntos de recogida...
          </div>
          
          <div id="errorDiv" class="error" style="display: none;"></div>
          
          <div id="locationsDiv" class="locations-grid"></div>
          
          <div class="confirm-section">
            <button id="confirmBtn" class="confirm-btn" onclick="confirmSelection()" disabled>
              Confirmar Punto de Recogida Seleccionado
            </button>
          </div>
        </div>
      </div>
      
      <script>
        let selectedLocation = null;
        const country = '${country}' || 'FR';
        const orderNumber = '${orderNumber}';
        const orderId = '${orderId}';
        
        function searchLocations() {
          const zip = document.getElementById('zipInput').value.trim();
          const city = document.getElementById('cityInput').value.trim();
          
          if (!zip) {
            showError('Por favor introduce un código postal');
            return;
          }
          
          document.getElementById('loadingDiv').style.display = 'block';
          document.getElementById('errorDiv').style.display = 'none';
          document.getElementById('locationsDiv').innerHTML = '';
          
          let url = '/apps/xbs-pudo?country=' + country + '&zip=' + encodeURIComponent(zip);
          if (city) {
            url += '&city=' + encodeURIComponent(city);
          }
          
          fetch(url)
            .then(response => response.json())
            .then(data => {
              document.getElementById('loadingDiv').style.display = 'none';
              
              if (data.success) {
                displayLocations(data.locations);
              } else {
                showError('Error al buscar ubicaciones: ' + data.error);
              }
            })
            .catch(error => {
              document.getElementById('loadingDiv').style.display = 'none';
              showError('Error de conexión: ' + error.message);
            });
        }
        
        function displayLocations(locations) {
          const div = document.getElementById('locationsDiv');
          
          if (locations.length === 0) {
            div.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No se encontraron puntos de recogida en esta área.</p>';
            return;
          }
          
          div.innerHTML = locations.map(loc => \`
            <div class="location-card" onclick="selectLocation('\${loc.id}', this)">
              <div class="location-name">\${loc.name}</div>
              <div class="location-address">
                \${loc.address1}<br>
                \${loc.zip} \${loc.city}
              </div>
              <div class="location-carrier">\${loc.carrier}</div>
            </div>
          \`).join('');
        }
        
        function selectLocation(locationId, element) {
          // Remove previous selection
          document.querySelectorAll('.location-card').forEach(card => {
            card.classList.remove('selected');
          });
          
          // Select current
          element.classList.add('selected');
          selectedLocation = locationId;
          
          // Enable confirm button
          document.getElementById('confirmBtn').disabled = false;
        }
        
        function confirmSelection() {
          if (!selectedLocation) {
            showError('Por favor selecciona un punto de recogida');
            return;
          }
          
          document.getElementById('confirmBtn').disabled = true;
          document.getElementById('confirmBtn').textContent = 'Procesando...';
          
          // Here we'll call your complete order endpoint
          fetch('/apps/complete-inpost-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId: orderId,
              orderNumber: orderNumber,
              pudoLocationId: selectedLocation,
              country: country // Pass the country from URL
            })
          })
          .then(response => response.json())
          .then(data => {
            if (data.success) {
              showSuccess('¡Perfecto! Tu pedido ha sido enviado al punto de recogida seleccionado. Número de seguimiento: ' + data.trackingNumber);
              document.getElementById('confirmBtn').textContent = 'Completado ✓';
            } else {
              showError('Error al procesar el pedido: ' + data.error);
              document.getElementById('confirmBtn').disabled = false;
              document.getElementById('confirmBtn').textContent = 'Confirmar Punto de Recogida Seleccionado';
            }
          })
          .catch(error => {
            showError('Error de conexión: ' + error.message);
            document.getElementById('confirmBtn').disabled = false;
            document.getElementById('confirmBtn').textContent = 'Confirmar Punto de Recogida Seleccionado';
          });
        }
        
        function showError(message) {
          const div = document.getElementById('errorDiv');
          div.textContent = message;
          div.style.display = 'block';
        }
        
        function showSuccess(message) {
          const div = document.getElementById('errorDiv');
          div.innerHTML = message;
          div.className = 'success';
          div.style.display = 'block';
        }
        
        // Auto-search if we have country
        if (country === 'FR') {
          document.getElementById('zipInput').placeholder = 'Código postal francés (ej: 75001)';
        } else if (country === 'PL') {
          document.getElementById('zipInput').placeholder = 'Código postal polaco (ej: 00-001)';
        }
      </script>
    </body>
    </html>
  `);
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
  console.log(`   GET  /pudo-selection - PUDO selection page for customers`);
  console.log(`🌐 PUDO Selection URL: https://xbs-yje6tg.fly.dev/pudo-selection`);
});
