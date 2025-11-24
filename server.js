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

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "public/admin")));

// ---------- OpenAI ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Restaurants storage ----------

const restaurantsFile = path.join(__dirname, "restaurants.json");

// We treat restaurants.json as an ARRAY of restaurant objects
async function loadRestaurants() {
  try {
    const data = await fs.readFile(restaurantsFile, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (err) {
    console.error("Error loading restaurants.json, using empty array:", err.message);
    return [];
  }
}

async function saveRestaurants(data) {
  try {
    await fs.writeFile(restaurantsFile, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving restaurants.json:", err);
  }
}

let restaurants = [];

// ---------- Multer + Cloudinary (for images) ----------

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

// Reusable multer instance (in-memory)
const upload = multer({ storage: multer.memoryStorage() });

// Upload a single image and return URL (used by menu editor)
app.post("/upload-image", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const stream = cloudinary.uploader.upload_stream(
    { folder: "restaurant-menu" },
    (error, result) => {
      if (error) {
        console.error("Cloudinary error:", error);
        return res.status(500).json({ error: "Upload failed" });
      }
      return res.json({ url: result.secure_url });
    }
  );

  stream.end(req.file.buffer);
});

// ---------- IMPORT FROM URL (preview only) ----------

app.post("/import-from-url", async (req, res) => {
  try {
    const { restaurantId, url } = req.body || {};

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
      return res
        .status(500)
        .json({ error: "No readable text found on page" });
    }

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Extract a restaurant menu from this text and return ONLY valid JSON.

Format:
[
  {
    "category": "Category Name",
    "items": [
      { "name": "Item Name", "price": "$0.00", "notes": "" }
    ]
  }
]

- "category" = section headers like "Pizzas", "Sides", "Drinks".
- "name" = item name.
- "price" = string like "$6.95" (or "" if you can't see it).
- "notes" = short description if visible, else "".

Text:
${text}`,
        },
      ],
    });

    const raw = ai.choices[0].message.content.trim();
    const cleaned = raw
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    let menuJson;
    try {
      menuJson = JSON.parse(cleaned);
    } catch (err) {
      console.error("JSON parse error on AI URL output:", cleaned);
      return res.status(500).json({ error: "AI returned invalid JSON" });
    }

    // PREVIEW ONLY – DO NOT SAVE HERE
    return res.json({ menu: menuJson });
  } catch (err) {
    console.error("Import-from-url error:", err);
    return res.status(500).json({ error: "Failed to import menu from URL" });
  }
});

// ---------- IMPORT FROM IMAGE (screenshot / photo) ----------

app.post("/import-from-image", upload.single("image"), async (req, res) => {
  try {
    const { restaurantId } = req.body || {};

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurantId is required" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "image file is required" });
    }

    // Convert image buffer to base64 data URL
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
              text: `You are extracting a restaurant menu from an image.

Return ONLY valid JSON in this exact format:

[
  {
    "category": "Category Name",
    "items": [
      { "name": "Item Name", "price": "$0.00", "notes": "" }
    ]
  }
]

Instructions:
- "category" = section headers like "Sides", "Salads", "Desserts", "Drinks".
- "name" = item name.
- "price" = string like "$6.95" or "$1.99". If the price is clearly visible, include it; if not, use "".
- "notes" = optional description; if none is visible, use "".
- Do NOT include any extra text or explanation, just the JSON array.`
            },
            {
              type: "image_url",
              image_url: { url: dataUrl }
            }
          ]
        }
      ]
    });

    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    let menuJson;
    try {
      menuJson = JSON.parse(cleaned);
    } catch (err) {
      console.error("JSON parse error on AI image output:", cleaned);
      return res
        .status(500)
        .json({ error: "AI returned invalid JSON from image" });
    }

    // PREVIEW ONLY – DO NOT SAVE HERE
    return res.json({ menu: menuJson });
  } catch (err) {
    console.error("Import-from-image error:", err);
    return res
      .status(500)
      .json({ error: "Failed to import menu from image" });
  }
});

// ---------- RESTAURANTS ENDPOINTS ----------

// GET all restaurants (array)
app.get("/restaurants", (req, res) => {
  res.json(restaurants);
});

// Create / update restaurant by id (merge)
app.post("/restaurants/:id", async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};

  const idx = restaurants.findIndex((r) => r.id === id);
  const existing = idx >= 0 ? restaurants[idx] : { id };

  const updated = {
    ...existing,
    ...body,
    id, // ensure id is consistent
  };

  if (idx >= 0) {
    restaurants[idx] = updated;
  } else {
    restaurants.push(updated);
  }

  await saveRestaurants(restaurants);
  res.json(updated);
});

// ---------- CHAT ENDPOINT ----------

app.post("/chat", async (req, res) => {
  try {
    const { restaurantId, message, history } = req.body || {};
    if (!restaurantId || !message) {
      return res
        .status(400)
        .json({ error: "restaurantId and message are required" });
    }

    const restaurant = restaurants.find((r) => r.id === restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const context = JSON.stringify(
      {
        name: restaurant.name,
        address: restaurant.address,
        phone: restaurant.phone,
        hours: restaurant.hours,
        orderingLink: restaurant.orderingLink,
        googleReviewLink: restaurant.googleReviewLink,
        offers: restaurant.offers,
        menu: restaurant.menu,
        faq: restaurant.faq,
      },
      null,
      2
    );

    const systemPrompt = `
You are a friendly, helpful AI chatbot for the restaurant "${restaurant.name}".

Use ONLY this restaurant data to answer questions:

${context}

Rules:
- If you're asked something not in the data (like exact delivery zones, live pricing changes, or unavailable info), say you aren't sure and suggest calling the restaurant.
- Be concise and conversational.
- When talking about menu items, mention category and price if available.
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: message },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// ---------- START SERVER ----------

async function start() {
  restaurants = await loadRestaurants();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
});
