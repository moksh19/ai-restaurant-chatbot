// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// --- Load restaurants.json ---
const dataPath = path.join(__dirname, "restaurants.json");

function loadRestaurants() {
  const raw = fs.readFileSync(dataPath, "utf-8");
  return JSON.parse(raw);
}

function saveRestaurants(restaurants) {
  fs.writeFileSync(dataPath, JSON.stringify(restaurants, null, 2), "utf-8");
}

let restaurants = loadRestaurants();

// --- OpenAI setup ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Build system context from restaurant data
function buildRestaurantContext(restaurant) {
  const menuText = (restaurant.menu || [])
    .map(
      (section) =>
        `\n${section.category}:\n` +
        section.items
          .map(
            (item) =>
              `- ${item.name} (${item.price}) – ${item.notes ?? ""}`
          )
          .join("\n")
    )
    .join("\n");

  const offersText =
    restaurant.offers && restaurant.offers.length
      ? restaurant.offers.map((o) => `- ${o}`).join("\n")
      : "No active offers listed.";

  const faqText =
    restaurant.faq && restaurant.faq.length
      ? restaurant.faq.map((f) => `- ${f}`).join("\n")
      : "No FAQ available.";

  return `
You are a friendly, concise chatbot for the restaurant "${restaurant.name}".

ADDRESS:
${restaurant.address}

HOURS:
${restaurant.hours}

PHONE:
${restaurant.phone ?? "Not provided"}

ORDERING:
Send customers to this link for online orders:
${restaurant.orderingLink}

GOOGLE REVIEWS:
When appropriate, share this review link:
${restaurant.googleReviewLink}

CURRENT OFFERS:
${offersText}

MENU:
${menuText}

FAQ:
${faqText}

RULES:
- Always answer ONLY using the information above when possible.
- If you don't know something, say you're not sure and suggest calling the restaurant.
- When customers ask to order, always give the ordering link.
- When customers say they enjoyed, nicely encourage them to leave a Google review.
- Be short, clear, and friendly.
`;
}

// --- 1) Chat endpoint ---
app.post("/chat", async (req, res) => {
  try {
    const { restaurantId, message, history } = req.body;

    if (!restaurantId || !message) {
      return res
        .status(400)
        .json({ error: "restaurantId and message are required" });
    }

    const restaurant = restaurants[restaurantId];
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const systemPrompt = buildRestaurantContext(restaurant);
    const historyMessages = Array.isArray(history) ? history : [];

    const messages = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: message },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      temperature: 0.4,
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "AI error" });
  }
});

// --- 2) CRUD for restaurants ---

// List all
app.get("/restaurants", (req, res) => {
  res.json(Object.values(restaurants));
});

// Get one
app.get("/restaurants/:id", (req, res) => {
  const r = restaurants[req.params.id];
  if (!r) return res.status(404).json({ error: "Not found" });
  res.json(r);
});

// Create / update (upsert)
app.post("/restaurants/:id", (req, res) => {
  const id = req.params.id;
  const body = req.body;

  const existing = restaurants[id] || { id };

  // Merge existing data with new data (partial updates)
  const newRestaurant = {
    ...existing,
    ...body,
    id,
    // Ensure arrays don't get accidentally set to undefined
    offers: body.offers ?? existing.offers ?? [],
    menu: body.menu ?? existing.menu ?? [],
    faq: body.faq ?? existing.faq ?? [],
  };

  restaurants[id] = newRestaurant;
  saveRestaurants(restaurants);

  res.json(newRestaurant);
});


// Delete
app.delete("/restaurants/:id", (req, res) => {
  const id = req.params.id;
  if (!restaurants[id]) {
    return res.status(404).json({ error: "Not found" });
  }
  delete restaurants[id];
  saveRestaurants(restaurants);
  res.json({ success: true });
});

// --- 3) Optional: import from website URL ---
app.post("/import-from-url", async (req, res) => {
  try {
    const { restaurantId, url } = req.body;
    if (!url || !restaurantId) {
      return res
        .status(400)
        .json({ error: "restaurantId and url are required" });
    }

    const response = await fetch(url);
    const html = await response.text();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content:
            "You are a parser that extracts restaurant info. Extract name, address, hours, ordering link, google review link if present, offers, menu (categories and items with name, price, notes), FAQ. Respond ONLY with valid JSON.",
        },
        {
          role: "user",
          content: html,
        },
      ],
      temperature: 0,
    });

    let extractedJson;
    try {
      extractedJson = JSON.parse(completion.choices[0].message.content);
    } catch (e) {
      console.error("JSON parse error:", e);
      return res.status(500).json({ error: "Failed to parse AI JSON" });
    }

    const newRestaurant = {
      id: restaurantId,
      name: extractedJson.name || restaurantId,
      address: extractedJson.address || "",
      hours: extractedJson.hours || "",
      phone: extractedJson.phone || "",
      orderingLink: extractedJson.orderingLink || "",
      googleReviewLink: extractedJson.googleReviewLink || "",
      offers: extractedJson.offers || [],
      menu: extractedJson.menu || [],
      faq: extractedJson.faq || [],
    };

    restaurants[restaurantId] = newRestaurant;
    saveRestaurants(restaurants);

    res.json(newRestaurant);
  } catch (err) {
    console.error("Import error:", err);
    res.status(500).json({ error: "Failed to import" });
  }
});

// --- 4) Serve static files (widget.js etc.) ---
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});

app.use("/admin", express.static(path.join(path.resolve(), "public/admin")));
