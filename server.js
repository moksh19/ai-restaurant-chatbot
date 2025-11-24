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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Restaurants storage ----------

const restaurantsFile = path.join(__dirname, "restaurants.json");

async function loadRestaurants() {
  try {
    const data = await fs.readFile(restaurantsFile, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Error loading restaurants.json, using empty object:", err.message);
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

// ---------- Image upload (Cloudinary) ----------

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

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

// ---------- Import menu from URL (preview only) ----------

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
      console.error("JSON parse error on AI output:", cleaned);
      return res.status(500).json({ error: "AI returned invalid JSON" });
    }

    // IMPORTANT: do NOT save here. Just preview.
    return res.json({ menu: menuJson });
  } catch (err) {
    console.error("Import error:", err);
    return res.status(500).json({ error: "Failed to import menu" });
  }
});

// ---------- Restaurants CRUD ----------

// Get list of restaurants
app.get("/restaurants", (req, res) => {
  const list = Object.values(restaurants || {}).map((r) => ({
    id: r.id,
    ...r,
  }));
  res.json(list);
});

// Create / update restaurant (merge)
app.post("/restaurants/:id", async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};

  const existing = restaurants[id] || { id };

  const newRestaurant = {
    ...existing,
    ...body,
    id,
    offers: body.offers ?? existing.offers ?? [],
    menu: body.menu ?? existing.menu ?? [],
    faq: body.faq ?? existing.faq ?? [],
  };

  restaurants[id] = newRestaurant;
  await saveRestaurants(restaurants);

  res.json(newRestaurant);
});

// ---------- Chat endpoint ----------

app.post("/chat", async (req, res) => {
  try {
    const { restaurantId, message, history } = req.body || {};
    if (!restaurantId || !message) {
      return res
        .status(400)
        .json({ error: "restaurantId and message are required" });
    }

    const restaurant = restaurants[restaurantId];
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
- If you're asked something not in the data (like exact delivery zones, prices, or unavailable info), say you aren't sure and suggest calling the restaurant.
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

// ---------- Start server ----------

async function start() {
  restaurants = await loadRestaurants();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
});
