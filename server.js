// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import OpenAI from "openai";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { JSDOM } from "jsdom";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------- Middleware ----------------------
app.use(cors());
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "public", "admin")));

// Landing page at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// Optional direct landing URL
app.get("/landing.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------- Restaurants store ----------------------
const restaurantsFile = path.join(__dirname, "restaurants.json");
let restaurants = {};

// Load restaurants from JSON (supports old array format)
async function loadRestaurants() {
  try {
    const data = await fs.readFile(restaurantsFile, "utf8");
    const parsed = JSON.parse(data);

    // If already object {id: restaurant}
    if (!Array.isArray(parsed) && typeof parsed === "object") {
      return parsed;
    }

    // If it's an array, convert to object keyed by id
    if (Array.isArray(parsed)) {
      const obj = {};
      for (const r of parsed) {
        if (r && r.id) obj[r.id] = r;
      }
      return obj;
    }

    return {};
  } catch (err) {
    console.error("Error loading restaurants.json:", err.message);
    return {};
  }
}

async function saveRestaurants(data) {
  try {
    await fs.writeFile(restaurantsFile, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving restaurants.json:", err);
  }
}

// ---------------------- Backup endpoint ----------------------
app.get("/admin/backup", (req, res) => {
  try {
    const backupJson = JSON.stringify(restaurants, null, 2);
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=restaurants-backup.json"
    );
    res.send(backupJson);
  } catch (err) {
    console.error("Backup error:", err);
    res.status(500).send("Error generating backup");
  }
});

// ---------------------- Cloudinary + Multer (image upload) ----------------------
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload-image", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const stream = cloudinary.uploader.upload_stream(
    { folder: "restaurant-menu" },
    (error, result) => {
      if (error) {
        console.error("Cloudinary upload error:", error);
        return res.status(500).json({ error: "Upload failed" });
      }
      res.json({ url: result.secure_url });
    }
  );

  stream.end(req.file.buffer);
});

// ---------------------- IMPORT MENU FROM URL ----------------------
app.post("/import-from-url", async (req, res) => {
  try {
    const { restaurantId, url } = req.body;
    if (!restaurantId || !url) {
      return res.status(400).json({ error: "restaurantId and url are required" });
    }

    const response = await fetch(url);
    const html = await response.text();

    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent || "";

    if (!text.trim()) {
      return res.status(500).json({ error: "No readable text found" });
    }

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `
Extract a restaurant menu from this text and return ONLY valid JSON:

[
  {
    "category": "Category Name",
    "items": [
      { "name": "Item Name", "price": "$0.00", "notes": "" }
    ]
  }
]

Text:
${text}
`,
        },
      ],
    });

    const raw = ai.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json/i, "").replace(/```$/i, "").trim();
    const menuJson = JSON.parse(cleaned);

    res.json({ menu: menuJson }); // preview only
  } catch (err) {
    console.error("URL import error:", err);
    res.status(500).json({ error: "Failed to import menu from URL" });
  }
});

// ---------------------- IMPORT MENU FROM IMAGE ----------------------
app.post("/import-from-image", upload.single("image"), async (req, res) => {
  try {
    const { restaurantId } = req.body;
    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId required" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "image required" });
    }

    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${req.file.mimetype};base64,${base64}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `
Extract a restaurant menu from this image and return ONLY valid JSON:

[
  {
    "category": "Category Name",
    "items": [
      { "name": "Item Name", "price": "$0.00", "notes": "" }
    ]
  }
]
`,
            },
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
    });

    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json/i, "").replace(/```$/i, "").trim();
    const menuJson = JSON.parse(cleaned);

    res.json({ menu: menuJson }); // preview only
  } catch (err) {
    console.error("Image import error:", err);
    res.status(500).json({ error: "Failed to import menu from image" });
  }
});

// ---------------------- IMPORT OFFERS FROM URL (2B) ----------------------
app.post("/import-offers-from-url", async (req, res) => {
  try {
    const { restaurantId, url } = req.body;

    if (!restaurantId || !url) {
      return res.status(400).json({ error: "restaurantId and url required" });
    }

    const response = await fetch(url);
    const html = await response.text();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `
Extract ONLY time-bound promotions / specials / discounts / offers from this HTML.
IGNORE normal menu items and regular prices.

Return STRICT JSON like this:

[
  {
    "title": "Name of promotion",
    "details": "Human-readable description",
    "code": "Coupon code or null",
    "startDate": "YYYY-MM-DD or null",
    "endDate": "YYYY-MM-DD or null",
    "startTime": "HH:MM or null",
    "endTime": "HH:MM or null",
    "daysOfWeek": [0,1,2]  // 0=Sunday..6=Saturday or []
  }
]

If dates or times are not clearly specified, set them to null.
HTML:
${html}
`,
        },
      ],
    });

    let raw = completion.choices[0].message.content.trim();
    raw = raw.replace(/^```json/i, "").replace(/```$/i, "").trim();
    const offers = JSON.parse(raw);

    return res.json({ offers });
  } catch (err) {
    console.error("import-offers-from-url failed:", err);
    return res.status(500).json({ error: "Failed to import offers from URL" });
  }
});

// ---------------------- Menu merge helper ----------------------
function mergeMenus(oldMenu, newMenu) {
  const merged = oldMenu.map((c) => ({
    ...c,
    items: [...(c.items || [])],
  }));

  for (const newCat of newMenu) {
    const existingCat = merged.find(
      (c) =>
        c.category?.toLowerCase() === newCat.category?.toLowerCase()
    );

    if (!existingCat) {
      merged.push({
        category: newCat.category,
        items: newCat.items || [],
      });
    } else {
      for (const newItem of newCat.items || []) {
        const existingItem = existingCat.items.find(
          (i) => i.name?.toLowerCase() === newItem.name?.toLowerCase()
        );

        if (!existingItem) {
          existingCat.items.push(newItem);
        } else {
          existingItem.price = newItem.price || existingItem.price;
          existingItem.notes = newItem.notes || existingItem.notes;
          existingItem.image = newItem.image || existingItem.image;
        }
      }
    }
  }

  return merged;
}

// ---------------------- Offers active logic (for chat) ----------------------
function offerIsActive(offer, now = new Date()) {
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const dayOfWeek = now.getDay(); // 0=Sun..6=Sat

  if (offer.startDate && today < offer.startDate) return false;
  if (offer.endDate && today > offer.endDate) return false;

  if (Array.isArray(offer.daysOfWeek) && offer.daysOfWeek.length > 0) {
    if (!offer.daysOfWeek.includes(dayOfWeek)) return false;
  }

  if (offer.startTime || offer.endTime) {
    const [sh, sm] = (offer.startTime || "00:00").split(":").map(Number);
    const [eh, em] = (offer.endTime || "23:59").split(":").map(Number);

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;

    if (nowMinutes < startMinutes || nowMinutes > endMinutes) return false;
  }

  return true;
}

function getActiveOffers(restaurant, now = new Date()) {
  if (!restaurant.offers || !Array.isArray(restaurant.offers)) return [];
  return restaurant.offers.filter((o) => offerIsActive(o, now));
}

// ---------------------- RESTAURANTS ROUTES ----------------------
app.get("/restaurants", (req, res) => {
  try {
    res.json(Object.values(restaurants));
  } catch (err) {
    console.error("GET /restaurants error:", err);
    res.status(500).json({ error: "Failed to load restaurants" });
  }
});

app.post("/restaurants/:id", async (req, res) => {
  const id = req.params.id;
  const data = req.body || {};

  const existing = restaurants[id] || { id, menu: [], offers: [], faq: [] };

  // Handle menu
  let finalMenu = existing.menu;
  if (Array.isArray(data.menu)) {
    if (data.replace) {
      finalMenu = data.menu;
    } else {
      finalMenu = mergeMenus(existing.menu || [], data.menu);
    }
  }

  // Handle offers
  let finalOffers = existing.offers || [];
  if (Array.isArray(data.offers)) {
    if (data.replaceOffers) {
      finalOffers = data.offers;
    } else {
      finalOffers = [...(existing.offers || []), ...data.offers];
    }
  }

  const updated = {
    ...existing,
    ...data,
    id,
    menu: finalMenu,
    offers: finalOffers,
  };

  delete updated.replace;
  delete updated.replaceOffers;

  restaurants[id] = updated;
  await saveRestaurants(restaurants);

  res.json(updated);
});

// ---------------------- Chatbot ----------------------
app.post("/chat", async (req, res) => {
  try {
    const { restaurantId, message, history } = req.body;

    const restaurant = restaurants[restaurantId];
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const activeOffers = getActiveOffers(restaurant);
    const context = JSON.stringify(
      {
        ...restaurant,
        activeOffers,
      },
      null,
      2
    );

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a helpful AI assistant for a restaurant.
Use ONLY this JSON data to answer questions:

${context}

If user asks about deals/promos, ONLY mention items from "activeOffers".
If activeOffers is empty, say there are no current promotions.
`,
        },
        ...(history || []),
        { role: "user", content: message },
      ],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// ---------------------- Start server ----------------------
async function start() {
  restaurants = await loadRestaurants();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
