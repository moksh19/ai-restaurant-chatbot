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

// ------------------------------------
// Middleware
// ------------------------------------
app.use(cors());
app.use(express.json());

// Static
app.use(express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "public/admin")));

app.get("/landing.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// Redirect root to admin dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =========================================================
// RESTAURANT STORAGE (OBJECT-BASED, SAFE VERSION)
// =========================================================

const restaurantsFile = path.join(__dirname, "restaurants.json");

async function loadRestaurants() {
  try {
    const data = await fs.readFile(restaurantsFile, "utf8");
    const parsed = JSON.parse(data);

    // Already an object: good
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

let restaurants = {};

// =========================================================
// CLOUDINARY + MULTER (IMAGE UPLOAD)
// =========================================================

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

// =========================================================
// IMPORT FROM URL — PREVIEW ONLY
// =========================================================

app.post("/import-from-url", async (req, res) => {
  try {
    const { restaurantId, url } = req.body;

    if (!restaurantId || !url) {
      return res
        .status(400)
        .json({ error: "restaurantId and url are required" });
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
    const cleaned = raw.replace(/^```json/i, "").replace(/```$/, "").trim();

    const menuJson = JSON.parse(cleaned);

    res.json({ menu: menuJson }); // preview-only
  } catch (err) {
    console.error("URL import error:", err);
    res.status(500).json({ error: "Failed to import menu from URL" });
  }
});

// =========================================================
// IMPORT FROM IMAGE — PREVIEW ONLY
// =========================================================

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
    const cleaned = raw.replace(/^```json/i, "").replace(/```$/, "").trim();

    const menuJson = JSON.parse(cleaned);

    res.json({ menu: menuJson }); // preview-only
  } catch (err) {
    console.error("Image import error:", err);
    res.status(500).json({ error: "Failed to import menu from image" });
  }
});


// =========================================================
// IMPORT OFFERS FROM WEBSITE URL — PREVIEW ONLY
// =========================================================

app.post("/import-offers-from-url", async (req, res) => {
  try {
    const { restaurantId, url } = req.body;

    if (!restaurantId || !url) {
      return res.status(400).json({ error: "restaurantId and url required" });
    }

    // Fetch HTML from the website
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
`
        }
      ]
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

// =========================================================
// MERGE LOGIC — FOR MENUS
// =========================================================

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

// =========================================================
// RESTAURANTS ROUTES
// =========================================================

// used by dashboard
app.get("/restaurants", (req, res) => {
  res.json(Object.values(restaurants));
});

// Download full backup of all restaurants
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

app.post("/restaurants/:id", async (req, res) => {
  const id = req.params.id;
  const data = req.body || {};

  const existing = restaurants[id] || { id, menu: [], offers: [], faq: [] };

  // Handle menu
  let finalMenu = existing.menu;
  if (Array.isArray(data.menu)) {
    if (data.replace) {
      // FULL REPLACE of menu
      finalMenu = data.menu;
    } else {
      // MERGE menu
      finalMenu = mergeMenus(existing.menu, data.menu);
    }
  }

  // Handle offers (for 2B)
  let finalOffers = existing.offers || [];
  if (Array.isArray(data.offers)) {
    if (data.replaceOffers) {
      // FULL REPLACE of offers
      finalOffers = data.offers;
    } else {
      // APPEND to existing offers
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

  // Don't accidentally store control flags
  delete updated.replace;
  delete updated.replaceOffers;

  restaurants[id] = updated;
  await saveRestaurants(restaurants);

  res.json(updated);
});


// =========================================================
// CHATBOT
// =========================================================

app.post("/chat", async (req, res) => {
  try {
    const { restaurantId, message, history } = req.body;

    const restaurant = restaurants[restaurantId];
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const context = JSON.stringify(restaurant, null, 2);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful restaurant AI. Use ONLY this data:\n${context}`,
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

// =========================================================
// START SERVER
// =========================================================

async function start() {
  restaurants = await loadRestaurants();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
