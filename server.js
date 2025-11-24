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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// =========================================================
// 📌 RESTAURANTS STORAGE (Object-Based, SAFE VERSION)
// =========================================================

const restaurantsFile = path.join(__dirname, "restaurants.json");

async function loadRestaurants() {
  try {
    const data = await fs.readFile(restaurantsFile, "utf8");
    const parsed = JSON.parse(data);

    // If already object → good
    if (!Array.isArray(parsed) && typeof parsed === "object") {
      return parsed;
    }

    // If array → convert to object
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
    await fs.writeFile(
      restaurantsFile,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("Error saving restaurants.json:", err);
  }
}

// Global restaurants object
let restaurants = {};


// =========================================================
// 📌 IMAGE UPLOAD (Cloudinary for menu editor images)
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
        console.error("Cloudinary error:", error);
        return res.status(500).json({ error: "Upload failed" });
      }
      res.json({ url: result.secure_url });
    }
  );

  stream.end(req.file.buffer);
});


// =========================================================
// 📌 IMPORT FROM WEBSITE URL (Preview Only)
// =========================================================

app.post("/import-from-url", async (req, res) => {
  try {
    const { restaurantId, url } = req.body;
    if (!restaurantId || !url)
      return res.status(400).json({ error: "restaurantId and url are required" });

    const response = await fetch(url);
    const html = await response.text();
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent || "";

    if (!text.trim())
      return res.status(500).json({ error: "No readable text found" });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `
Extract a restaurant menu from this text and return ONLY valid JSON.

FORMAT:
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
`
        }
      ]
    });

    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json/i, "").replace(/```$/, "").trim();

    let menuJson = JSON.parse(cleaned);

    res.json({ menu: menuJson }); // preview-only
  } catch (err) {
    console.error("URL Import Error:", err);
    res.status(500).json({ error: "Failed to import menu from URL" });
  }
});


// =========================================================
// 📌 IMPORT FROM IMAGE (Screenshot / JPG / PNG)
// =========================================================

app.post("/import-from-image", upload.single("image"), async (req, res) => {
  try {
    const { restaurantId } = req.body;
    if (!restaurantId)
      return res.status(400).json({ error: "restaurantId is required" });

    if (!req.file)
      return res.status(400).json({ error: "image file is required" });

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
Extract restaurant menu from this image.

Return ONLY valid JSON:

[
  {
    "category": "Category Name",
    "items": [
      { "name": "Item Name", "price": "$0.00", "notes": "" }
    ]
  }
]

Rules:
- category = headers like Pizzas, Sides, Drinks
- name = item name
- price = "$X.XX" or "" if missing
- notes = short description or ""
`
            },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json/i, "").replace(/```$/, "").trim();
    let menuJson = JSON.parse(cleaned);

    res.json({ menu: menuJson }); // preview-only
  } catch (err) {
    console.error("Image Import Error:", err);
    res.status(500).json({ error: "Failed to import menu from image" });
  }
});


// =========================================================
// 📌 RESTAURANT CRUD (MERGE SAFE)
// =========================================================

app.get("/restaurants", (req, res) => {
  res.json(Object.values(restaurants));
});

app.post("/restaurants/:id", async (req, res) => {
  const id = req.params.id;
  const body = req.body;

  const existing = restaurants[id] || { id };

  const updated = {
    ...existing,
    ...body,
    id,
  };

  restaurants[id] = updated;
  await saveRestaurants(restaurants);

  res.json(updated);
});


// =========================================================
// 📌 CHATBOT ENDPOINT
// =========================================================

app.post("/chat", async (req, res) => {
  try {
    const { restaurantId, message, history } = req.body;
    if (!restaurantId || !message)
      return res.status(400).json({ error: "restaurantId and message required" });

    const restaurant = restaurants[restaurantId];
    if (!restaurant)
      return res.status(404).json({ error: "Restaurant not found" });

    const context = JSON.stringify(restaurant, null, 2);

    const messages = [
      {
        role: "system",
        content: `You are a helpful restaurant AI. Use ONLY this data:\n${context}`
      },
      ...(history || []),
      { role: "user", content: message }
    ];

    const reply = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages
    });

    res.json({ reply: reply.choices[0].message.content });
  } catch (err) {
    console.error("Chat Error:", err);
    res.status(500).json({ error: "Chat failed" });
  }
});


// =========================================================
// START SERVER
// =========================================================

async function start() {
  restaurants = await loadRestaurants();
  app.listen(PORT, () => {
    console.log("Server running on port", PORT);
  });
}

start();
