// /api/social-generate.js
// Vercel serverless function that generates social media posts for
// The Jesse Cope Team's Pipeline app. Three modes:
//
//   1. random          — Random post of a given type (lifestyle, myth-buster, etc.)
//   2. listing         — Post from an uploaded MLS PDF sheet (base64)
//   3. my_listings     — Post from one or more existing listings in the app,
//                        with files pulled from Supabase Storage.
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   VITE_SUPABASE_URL (or SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY

const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Jesse's post style — applied to all modes.
const STYLE_GUIDE = `
POST STYLE — The Jesse Cope Team:
- Warm, conversational, confident. Written like talking to a neighbor.
- Open with ONE punchy, ALL-CAPS headline that sells the hook.
- Use emoji line-markers at the start of key sections (🏡 📍 ✨ 🔑 📸 💭 etc).
- Short bullet-style lines for property features. Keep it skimmable.
- End with a soft call-to-action and relevant hashtags (6-10) tied to the local area (Longview WA, Cowlitz County, Pacific Northwest).
- Never invent numbers. If a price, square footage, or key stat isn't given, use [brackets] for Jesse to fill in.
- Length: ~120-220 words for single-listing posts; ~200-320 for roundup posts.
- Team contacts to work in naturally when it fits: Jesse Cope (360-431-5915) and Mercedes Pucci (360-355-0646). Office: RE/MAX Premier Group, Longview WA.
`.trim();

// ───── Supabase helpers ────────────────────────────────────────────────
async function supaFetch(path, serviceRoleKey, supabaseUrl, init = {}) {
  const res = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${path} ${res.status}: ${t}`);
  }
  return res;
}

// Look up owner_id for each transaction (needed to construct storage paths).
async function getOwnerIdByTxn(serviceRoleKey, supabaseUrl, txnIds) {
  if (!txnIds || txnIds.length === 0) return {};
  const idsCsv = txnIds.map(id => `"${id}"`).join(",");
  const res = await supaFetch(
    `/rest/v1/transactions?select=id,owner_id&id=in.(${idsCsv})`,
    serviceRoleKey, supabaseUrl
  );
  const rows = await res.json();
  const map = {};
  for (const r of rows) map[r.id] = r.owner_id;
  return map;
}

// Create a signed URL for a single storage object.
async function signedUrl(serviceRoleKey, supabaseUrl, path, expiresInSec = 3600) {
  try {
    const res = await supaFetch(
      `/storage/v1/object/sign/documents/${path}`,
      serviceRoleKey, supabaseUrl,
      { method: "POST", body: JSON.stringify({ expiresIn: expiresInSec }) }
    );
    const data = await res.json();
    const pathSegment = data.signedURL || data.signedUrl || "";
    return `${supabaseUrl}/storage/v1${pathSegment}`;
  } catch (e) {
    console.error("signedUrl failed", path, e.message);
    return null;
  }
}

// ───── Claude API wrapper ──────────────────────────────────────────────
async function callClaude({ system, messages, max_tokens = 2000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Claude API ${res.status}: ${t}`);
  }
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("");
  return text;
}

// ───── Mode: random ────────────────────────────────────────────────────
async function doRandom({ postType, notes }) {
  const typeGuides = {
    surprise: "Pick the single BEST post for today — your choice. Could be anything that'd land well right now.",
    lifestyle: "A local-lifestyle moment — Cowlitz County / Longview / Kelso / PNW. What's great about living here.",
    first_time_buyer: "Encourage or educate first-time home buyers. Myth-bust fears, celebrate the achievement.",
    myth_buster: "Debunk a common real-estate misconception. Open with the myth, flip it, land the truth.",
    seasonal_tip: "A seasonal home-maintenance or home-improvement tip tied to the current time of year.",
    engagement: "A question to spark comments. Something fun or genuinely interesting.",
    just_listed_teaser: "A \"watch this space\" teaser about an upcoming listing — vague on specifics, big on anticipation.",
  };
  const typeHint = typeGuides[postType] || typeGuides.surprise;
  const post = await callClaude({
    system: `You are a social-media copywriter for The Jesse Cope Team real estate.\n\n${STYLE_GUIDE}`,
    messages: [{
      role: "user",
      content: `Write a ${postType === "surprise" ? "post of your choice" : `"${postType}" post`} for Facebook and Instagram.\n\nTYPE: ${typeHint}\n${notes ? `\nEXTRA DIRECTION: ${notes}` : ""}\n\nReturn just the post text — no commentary, no quotes around it.`,
    }],
  });
  return { post: post.trim() };
}

// ───── Mode: listing (uploaded MLS PDF sheet) ──────────────────────────
async function doListingFromPdf({ pdfBase64, notes }) {
  const post = await callClaude({
    system: `You are a social-media copywriter for The Jesse Cope Team real estate.\n\n${STYLE_GUIDE}`,
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
        },
        {
          type: "text",
          text: `Write a "Just Listed" social media post for the property in this MLS sheet. Pull real details from the sheet — don't invent anything. ${notes ? `\n\nEXTRA DIRECTION: ${notes}` : ""}\n\nReturn just the post text.`,
        },
      ],
    }],
  });
  return { post: post.trim() };
}

// ───── Mode: my_listings (from existing app listings) ──────────────────
async function doMyListings({ userInput, notes, listings }) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!serviceRoleKey || !supabaseUrl) {
    throw new Error("Server missing Supabase env vars");
  }

  // Resolve owner_id for each listing so we can build storage paths
  const txnIds = listings.map(l => l.id);
  const ownerIdByTxn = await getOwnerIdByTxn(serviceRoleKey, supabaseUrl, txnIds);

  // For each listing, sign URLs for its NWMLS printout and photos.
  // Limit photos per listing so we don't blow up tokens or request size.
  const PHOTOS_PER_LISTING = 8;
  const enriched = await Promise.all(listings.map(async (l) => {
    const ownerId = ownerIdByTxn[l.id];
    if (!ownerId) return { ...l, nwmlsUrl: null, photoUrls: [], coverPhotoUrl: null };

    const sign = (docId) => signedUrl(serviceRoleKey, supabaseUrl, `${ownerId}/${docId}`);

    // First NWMLS printout (if any)
    const nwmlsUrl = l.nwmlsDocIds && l.nwmlsDocIds[0]
      ? await sign(l.nwmlsDocIds[0])
      : null;

    // Up to N photos — cover first, then the rest in their saved order
    const photoIds = (l.photoDocIds || []).slice();
    let orderedIds = photoIds;
    if (l.coverPhotoId && photoIds.includes(l.coverPhotoId)) {
      orderedIds = [l.coverPhotoId, ...photoIds.filter(id => id !== l.coverPhotoId)];
    }
    orderedIds = orderedIds.slice(0, PHOTOS_PER_LISTING);
    const photoUrls = (await Promise.all(orderedIds.map(sign))).filter(Boolean);
    const coverPhotoUrl = l.coverPhotoId
      ? await sign(l.coverPhotoId)
      : (photoUrls[0] || null);

    return { ...l, nwmlsUrl, photoUrls, coverPhotoUrl };
  }));

  // Build a concise summary of the listings for the model
  const listingSummaries = enriched.map((l, i) => {
    const parts = [];
    parts.push(`Listing ${i + 1} (id: ${l.id})`);
    parts.push(`  Address: ${l.address || "—"}${l.city ? `, ${l.city}` : ""}${l.state ? `, ${l.state}` : ""}${l.zip ? ` ${l.zip}` : ""}`);
    if (l.listPrice) parts.push(`  List price: $${Number(l.listPrice).toLocaleString()}`);
    if (l.beds) parts.push(`  Beds: ${l.beds}`);
    if (l.baths) parts.push(`  Baths: ${l.baths}`);
    if (l.sqft) parts.push(`  Sqft: ${l.sqft}`);
    parts.push(`  NWMLS printout: ${l.nwmlsUrl ? "attached below" : "none"}`);
    parts.push(`  Photos available: ${l.photoUrls.length}`);
    return parts.join("\n");
  }).join("\n\n");

  const instructions = `
You are a social-media copywriter for The Jesse Cope Team real estate.

${STYLE_GUIDE}

TASK: Write a social-media post for the listings described below.

User's request: "${userInput || "Write a post for these listings"}"
${notes ? `Extra direction: ${notes}` : ""}

Available listings:
${listingSummaries}

Decide:
1. WHICH listings to feature. If the user named specific ones (e.g. "the 23rd and Bond listings"), use only those. If they said "all my active listings", use all of them. Otherwise, use your judgment.
2. ONE roundup post for multiple listings, OR per-listing posts. If the user said "a post" (singular) or asked for a roundup, make one post. If they said "posts" (plural) or asked for one per listing, make separate posts.
3. Which PHOTOS to use. Available photo URLs are provided per listing. Pick 1-5 of the strongest-looking photos (based on the ones attached) and return their URLs in the order they should be posted. For roundup posts, pick the cover photo of each featured listing.

Return your response as JSON only (no prose outside the JSON), with this exact shape:
{
  "post": "the full post text here",
  "photoUrls": ["url1", "url2", "..."]
}

If making multiple separate posts, join them with "\\n\\n═══════════════\\n\\n" inside the single post field.
`.trim();

  // Build content: instructions + each listing's NWMLS PDF + cover photo (if available)
  const content = [{ type: "text", text: instructions }];
  for (const l of enriched) {
    if (l.nwmlsUrl) {
      content.push({
        type: "document",
        source: { type: "url", url: l.nwmlsUrl },
      });
    }
    if (l.coverPhotoUrl) {
      content.push({
        type: "image",
        source: { type: "url", url: l.coverPhotoUrl },
      });
    }
  }

  const raw = await callClaude({
    system: "You are an expert real estate social-media copywriter. You return valid JSON when asked.",
    max_tokens: 3000,
    messages: [{ role: "user", content }],
  });

  // Parse JSON out of the response (model should return pure JSON, but we're defensive)
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch {}
    }
  }
  if (!parsed || typeof parsed.post !== "string") {
    // Fall back to treating the whole thing as the post
    return { post: raw.trim(), photoUrls: [] };
  }

  // Verify photoUrls are from the signed-URL pool (defense against hallucination)
  const validUrls = new Set(enriched.flatMap(l => l.photoUrls));
  const photoUrls = Array.isArray(parsed.photoUrls)
    ? parsed.photoUrls.filter(u => validUrls.has(u))
    : [];

  return { post: parsed.post.trim(), photoUrls };
}

// ───── Mode: chat (Phase A — text only, listing-aware context) ─────────
// The frontend sends the running conversation plus a list of active listings
// as lightweight context. Claude replies in Jesse's voice. Phases B+ will
// fetch NWMLS data, photos, and generate image overlays when the user asks
// for them.
async function doChat({ messages, activeListings }) {
  const listingLines = (activeListings && activeListings.length > 0)
    ? activeListings.map((l, i) =>
        `${i + 1}. ${l.address || "(no address)"}${l.city ? `, ${l.city}` : ""}${l.listPrice ? ` ($${Number(l.listPrice).toLocaleString()})` : ""}`
      ).join("\n")
    : "(none in the app yet)";

  // Keep the system prompt SHORT and purely directive.
  const system = `You write Facebook and Instagram posts for Jesse Cope, a real estate broker at RE/MAX Premier Group in Longview, WA.

Jesse's active listings:
${listingLines}

YOUR JOB: Write the post. Every message. No exceptions.

HOW TO RESPOND:
- Jesse messages you → You reply with a finished post ready to copy/paste.
- Start your reply WITH the post itself. No preamble, no "here's your post", no "I'd love to help".
- Match addresses loosely (so "1745 23rd" matches "1745 23rd Avenue"). Use the matched listing's details.
- Missing info (price, sqft)? Use [brackets] like [price] or [bedrooms] for Jesse to fill in.
- Style: ALL-CAPS headline, warm tone, emoji accents, 6-10 Longview/Cowlitz County hashtags.
- Length: 120-250 words.
- Team contacts when it fits: Jesse 360-431-5915 / Mercedes 360-355-0646.

IF JESSE MENTIONS A PHOTO, IMAGE, PRICE BANNER, OR OVERLAY:
- Still write the full post as described above.
- At the very end (after hashtags), add ONE short italic line like: _(For the price-banner photo, pair this with a Canva graphic — in-app image overlays coming in a future update.)_
- Do NOT skip writing the post. Do NOT recommend external tools in the middle of your response.

For follow-ups ("make it shorter", "more casual", "swap the opening") → rewrite the previous post with those tweaks.`;

  const trimmed = (messages || []).slice(-20).map(m => ({
    role: m.role,
    content: m.content,
  }));

  if (trimmed.length === 0) {
    return { reply: "What would you like me to post about?", post: "What would you like me to post about?" };
  }

  const text = await callClaude({
    system,
    max_tokens: 1500,
    messages: trimmed,
  });

  const cleaned = (text || "").trim();

  // If Claude truly returned nothing (should be rare), surface that clearly
  // rather than letting the UI show an empty bubble.
  if (!cleaned) {
    return {
      reply: "Claude returned an empty response. Please try again or rephrase your request.",
      post: "Claude returned an empty response. Please try again or rephrase your request.",
      _debug: "empty response from Claude",
    };
  }

  return { reply: cleaned, post: cleaned };
}

// ───── Main handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const { mode } = body;

    if (mode === "chat") {
      const out = await doChat(body);
      return res.status(200).json(out);
    }
    if (mode === "random") {
      const out = await doRandom(body);
      return res.status(200).json(out);
    }
    if (mode === "listing") {
      if (!body.pdfBase64) {
        return res.status(400).json({ error: "pdfBase64 required for listing mode" });
      }
      const out = await doListingFromPdf(body);
      return res.status(200).json(out);
    }
    if (mode === "my_listings") {
      if (!Array.isArray(body.listings) || body.listings.length === 0) {
        return res.status(400).json({ error: "No listings provided" });
      }
      const out = await doMyListings(body);
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: `Unknown mode: ${mode}` });
  } catch (e) {
    console.error("social-generate error:", e);
    return res.status(500).json({ error: e.message || "Unknown error" });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: "8mb" } },
};
