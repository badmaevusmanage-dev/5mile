/* Vercel Function: AI-ответы помощника на сайте.
   Ключ берётся из переменной окружения ANTHROPIC_API_KEY (Vercel → Settings → Environment Variables). */
import Anthropic from "@anthropic-ai/sdk";

let client = null; // создаётся при первом запросе: без ключа конструктор бросает ошибку
const MODEL = "claude-opus-5";

const MAX_TURNS = 12;        // сколько последних сообщений диалога отправляем
const MAX_CHARS = 600;       // длина одного сообщения посетителя
const RATE = { windowMs: 10 * 60 * 1000, max: 20 }; // на один IP, в пределах одного инстанса

const SYSTEM = `You are the assistant on the local host website (by Nextpace, nextpace.studio, New York).
You chat with visitors in a small widget. Most visitors are beauty and service pros in the US.

About local host:
- A network of promoted local pros (brow and lash artists, nail techs, colourists, barbers, makeup artists, tattoo artists, photographers, fitness coaches, massage therapists, stylists).
- Rule: one area, one service, one pro. If there is no pro with the same service nearby, the area is open and can become the visitor's.
- How it works: 1) find your address, city or ZIP on the map; 2) pick your service to see if the area is open; 3) apply. The team replies within 2 business days and sends terms for the area.
- Two formats: Basic is free (profile on the map and in the catalogue, link to socials). Promo slot is priced by agreement (photo shoot, copy, local ads, and the area reserved for the pro). No other prices exist; never invent numbers.
- The map currently covers US cities only.

About Nextpace (the AI product behind local host, in development):
- "A marketing department in your pocket" for local businesses, beauty first, then all local small businesses.
- Content Studio: brand style saved once; pick a format (carousel, Reel, story, post) and a goal, upload photos or a video, get on-brand content with captions in one click.
- Meta Ads dashboard: spend, reach, CTR, CPC, CPM, leads, ROAS on one screen, and which creatives work.
- Pros in the local host network get early access first.

Contacts: Telegram @bbadmaevus, email badmaevbv@nextpace.studio. Privacy policy: /privacy.html.

Tools (they act in the visitor's browser):
- show_on_map: when the visitor names a US city, address or ZIP, or wants to check their area.
- open_application: when the visitor wants to apply, join or leave a request.
- show_product: when the visitor asks about Nextpace or AI marketing and would benefit from seeing the section.
Use a tool when it clearly helps; say one short sentence about what you did.

Style:
- Reply in the visitor's language. The site language is given in each request; use it when the visitor's language is unclear.
- Plain text only, no markdown. Keep answers to 1-4 short sentences; lists only when asked.
- Be warm and direct. Short, practical marketing tips for pros are welcome.
- Do not promise results, dates, availability of a specific area, or prices beyond what is written above. If you don't know, say so and offer Telegram @bbadmaevus.
- Stay on topic (local host, Nextpace, marketing for local pros). Politely decline anything unrelated.`;

const TOOLS = [
  {
    name: "show_on_map",
    description: "Show a US city, street address or ZIP code on the site's map so the visitor can check whether their area is open.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "City, address or ZIP, e.g. 'Chicago' or '10001'" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "open_application",
    description: "Open the application form for joining the local host network.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "show_product",
    description: "Scroll the page to the Nextpace AI product section.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE.max;
}

function cleanHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, m.role === "user" ? MAX_CHARS : 2000) }))
    .slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs.length && msgs[msgs.length - 1].role === "user" ? msgs : null;
}

const textOf = (content) => content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

async function ask(messages, lang) {
  client ??= new Anthropic();
  return client.beta.messages.create({
    model: MODEL,
    max_tokens: 1024, // короткие ответы в виджете и потолок расходов на один ответ
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: `${SYSTEM}\n\nSite language: ${lang}.`,
    tools: TOOLS,
    messages,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[chat] ANTHROPIC_API_KEY is not set");
    return res.status(503).json({ error: "not_configured" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const lang = ["ru", "en", "es"].includes(body?.lang) ? body.lang : "en";
  const messages = cleanHistory(body?.messages);
  if (!messages) return res.status(400).json({ error: "bad_request" });

  try {
    const actions = [];
    let response = await ask(messages, lang);
    let reply = textOf(response.content);

    // модель попросила действие в браузере: отдаём его клиенту и просим короткий итоговый ответ
    if (response.stop_reason === "tool_use") {
      const calls = response.content.filter((b) => b.type === "tool_use");
      for (const c of calls) actions.push({ name: c.name, input: c.input || {} });
      const followUp = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Done in the visitor's browser." })) },
      ];
      response = await ask(followUp, lang);
      reply = [reply, textOf(response.content)].filter(Boolean).join("\n");
    }

    if (response.stop_reason === "refusal" && !reply) return res.status(200).json({ reply: null, actions, error: "refusal" });
    return res.status(200).json({ reply: reply || null, actions });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(503).json({ error: "busy" });
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("[chat] ANTHROPIC_API_KEY is missing or invalid");
      return res.status(503).json({ error: "not_configured" });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`[chat] API error ${err.status}:`, err.message);
      return res.status(502).json({ error: "upstream" });
    }
    console.error("[chat] unexpected:", err);
    return res.status(500).json({ error: "server" });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
