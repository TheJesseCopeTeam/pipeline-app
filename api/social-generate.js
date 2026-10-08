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

// Phase D1: sharp for image compositing (overlays, branding).
// Vercel includes sharp automatically in serverless functions, but it also
// needs to be in package.json dependencies.
import sharp from "sharp";

const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Brand colors for overlays
const BRAND = {
  red: "#C8102E",      // RE/MAX red
  redDark: "#A00D25",
  charcoal: "#2E2B26",
  white: "#FFFFFF",
};

// Template labels (and any optional subtitle info)
function templateLabel(template) {
  const labels = {
    JUST_LISTED: "JUST LISTED",
    NEW_LISTING: "NEW LISTING",
    PRICE_DROP: "PRICE DROP",
    PRICE_IMPROVEMENT: "PRICE IMPROVEMENT",
    COMING_SOON: "COMING SOON",
    OPEN_HOUSE: "OPEN HOUSE",
    PENDING: "PENDING",
    UNDER_CONTRACT: "UNDER CONTRACT",
    SOLD: "SOLD",
    JUST_SOLD: "JUST SOLD",
  };
  return labels[template] || template.replace(/_/g, " ");
}

// Build the SVG overlay for a given template. Dimensions scaled from image.
function buildOverlaySvg(template, args, imgW, imgH) {
  const topStripH = Math.round(imgH * 0.13);
  const bottomStripH = Math.round(imgH * 0.09);
  const topFontSize = Math.round(topStripH * 0.52);
  const subFontSize = Math.round(topStripH * 0.26);
  const brandFontSize = Math.round(bottomStripH * 0.38);
  const contactFontSize = Math.round(bottomStripH * 0.28);
  const padding = Math.round(imgW * 0.025);

  const label = templateLabel(template);
  const subtitle = args.subtitle || "";
  const hasSubtitle = !!subtitle;

  // Position label — centered vertically if no subtitle, slightly up if there is one
  const labelY = hasSubtitle ? topStripH * 0.55 : topStripH * 0.68;
  const subtitleY = topStripH * 0.88;

  // Font strategy: Vercel's serverless Node runtime doesn't bundle Arial, so
  // we use the generic "sans-serif" family which librsvg (sharp's SVG
  // renderer) maps to whatever system font IS available (typically DejaVu
  // Sans on Linux). This renders real text instead of placeholder boxes.
  const FONT = "sans-serif";

  return `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
    <!-- Top red banner -->
    <rect x="0" y="0" width="${imgW}" height="${topStripH}" fill="${BRAND.red}" fill-opacity="0.95"/>
    <text x="${imgW / 2}" y="${labelY}" text-anchor="middle"
          font-family="${FONT}" font-weight="bold"
          font-size="${topFontSize}" fill="${BRAND.white}" letter-spacing="4">${label}</text>
    ${hasSubtitle ? `<text x="${imgW / 2}" y="${subtitleY}" text-anchor="middle"
          font-family="${FONT}" font-weight="bold"
          font-size="${subFontSize}" fill="${BRAND.white}" letter-spacing="2">${subtitle}</text>` : ""}

    <!-- Bottom brand bar -->
    <rect x="0" y="${imgH - bottomStripH}" width="${imgW}" height="${bottomStripH}" fill="${BRAND.charcoal}" fill-opacity="0.92"/>
    <text x="${padding}" y="${imgH - bottomStripH * 0.42}"
          font-family="${FONT}" font-weight="bold"
          font-size="${brandFontSize}" fill="${BRAND.white}" letter-spacing="1">RE/MAX</text>
    <text x="${padding + brandFontSize * 2.6}" y="${imgH - bottomStripH * 0.42}"
          font-family="${FONT}" font-weight="normal"
          font-size="${brandFontSize * 0.75}" fill="${BRAND.white}">PREMIER GROUP</text>
    <text x="${imgW - padding}" y="${imgH - bottomStripH * 0.6}" text-anchor="end"
          font-family="${FONT}" font-weight="bold"
          font-size="${contactFontSize}" fill="${BRAND.white}">THE JESSE COPE TEAM</text>
    <text x="${imgW - padding}" y="${imgH - bottomStripH * 0.22}" text-anchor="end"
          font-family="${FONT}" font-weight="normal"
          font-size="${contactFontSize * 0.9}" fill="${BRAND.white}">360-431-5915</text>
  </svg>`;
}

// Try to pull a price out of the user's text (e.g. "$450,000", "$450k", "450000")
function extractPrice(text) {
  if (!text) return null;
  // $450,000 or $450000 or $450.5k
  const m1 = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?[kK]?\b/);
  if (m1) {
    const raw = m1[1].replace(/,/g, "");
    let n = parseFloat(raw);
    if (m1[0].toLowerCase().includes("k")) n *= 1000;
    if (n > 0) return `$${Math.round(n).toLocaleString()}`;
  }
  return null;
}

// Try to pull a date/time out of the user's text (e.g. "Saturday 1-3pm")
function extractDateTime(text) {
  if (!text) return null;
  const days = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;
  const dayMatch = text.match(days);
  const timeMatch = text.match(/\b\d{1,2}(:\d{2})?\s?(am|pm)?(\s?[-–]\s?\d{1,2}(:\d{2})?\s?(am|pm)?)?\b/i);
  if (dayMatch && timeMatch) {
    return `${dayMatch[0][0].toUpperCase() + dayMatch[0].slice(1).toLowerCase()} ${timeMatch[0].trim()}`.toUpperCase();
  }
  if (dayMatch) return dayMatch[0].toUpperCase();
  return null;
}

// Download an image from URL and composite the overlay on top. Returns a
// base64 data URL that can be passed straight to the frontend.
async function composeBrandedImage(imageUrl, template, args = {}) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = sharp(buf).rotate(); // Honor EXIF orientation
    const meta = await img.metadata();
    const imgW = meta.width || 1920;
    const imgH = meta.height || 1080;

    const svg = buildOverlaySvg(template, args, imgW, imgH);
    const composited = await img
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer();

    return `data:image/jpeg;base64,${composited.toString("base64")}`;
  } catch (e) {
    console.error("composeBrandedImage failed:", e.message);
    return null;
  }
}

// Detect which overlay template (if any) the user is asking for.
// Returns { template, args } or null if no overlay should be applied.
function detectOverlayTemplate(text, listing) {
  const t = (text || "").toLowerCase();
  const args = {};

  // Order matters: check more specific phrases first
  if (t.includes("just sold")) return { template: "JUST_SOLD", args };
  if (t.includes("sold")) return { template: "SOLD", args };
  if (t.includes("under contract")) return { template: "UNDER_CONTRACT", args };
  if (t.includes("pending")) return { template: "PENDING", args };
  if (t.includes("open house")) {
    const dt = extractDateTime(text);
    if (dt) args.subtitle = dt;
    return { template: "OPEN_HOUSE", args };
  }
  if (t.includes("coming soon")) return { template: "COMING_SOON", args };
  if (t.includes("price drop") || t.includes("price reduced") || t.includes("price reduction")) {
    const p = extractPrice(text) || (listing && listing.listPrice ? `$${Number(listing.listPrice).toLocaleString()}` : null);
    if (p) args.subtitle = `NOW ${p}`;
    return { template: "PRICE_DROP", args };
  }
  if (t.includes("price improvement")) {
    const p = extractPrice(text) || (listing && listing.listPrice ? `$${Number(listing.listPrice).toLocaleString()}` : null);
    if (p) args.subtitle = `NOW ${p}`;
    return { template: "PRICE_IMPROVEMENT", args };
  }
  if (t.includes("new listing")) return { template: "NEW_LISTING", args };
  if (t.includes("just listed") || t.includes("just-listed")) return { template: "JUST_LISTED", args };

  return null;
}

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
// Phase B helpers: find listings mentioned in the user's latest message,
// then attach their NWMLS printout PDFs to the Claude call so Claude can
// pull real details (lot size, features, remarks) instead of guessing.

// Loose matching: a listing is "mentioned" if any 2+ consecutive words from
// its address appear in the message, OR if the street number appears as a
// standalone token (common shorthand like "1745").
function findMentionedListings(text, listings) {
  if (!text || !Array.isArray(listings)) return [];
  const lowered = String(text).toLowerCase();
  const found = [];
  for (const l of listings) {
    if (!l.address) continue;
    const addr = String(l.address).toLowerCase();
    const parts = addr.split(/\s+/).filter(Boolean);
    let hit = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const bigram = `${parts[i]} ${parts[i + 1]}`;
      if (lowered.includes(bigram)) { hit = true; break; }
    }
    if (!hit && parts[0] && /^\d+$/.test(parts[0])) {
      const re = new RegExp(`\\b${parts[0]}\\b`);
      if (re.test(lowered)) hit = true;
    }
    if (hit) found.push(l);
  }
  return found;
}

// Fetch signed URLs for the NWMLS printouts of mentioned listings so Claude
// can read them as PDF documents.
async function fetchNwmlsAttachments(mentionedListings) {
  if (!mentionedListings || mentionedListings.length === 0) return [];
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!serviceRoleKey || !supabaseUrl) return [];

  const txnIds = mentionedListings.map(l => l.id);
  const ownerIds = await getOwnerIdByTxn(serviceRoleKey, supabaseUrl, txnIds);

  const results = [];
  for (const l of mentionedListings) {
    const ownerId = ownerIds[l.id];
    if (!ownerId) continue;
    const docIds = Array.isArray(l.nwmlsDocIds) ? l.nwmlsDocIds : [];
    if (docIds.length === 0) continue;
    // Use the first NWMLS printout per listing (usually only one)
    const docId = docIds[0];
    const url = await signedUrl(serviceRoleKey, supabaseUrl, `${ownerId}/${docId}`);
    if (url) results.push({ listingId: l.id, address: l.address, url });
  }
  return results;
}

// Phase C: Fetch signed URLs for photos of mentioned listings. Cover photo
// first, then the rest in saved order. Capped to avoid token explosion.
const PHOTOS_PER_LISTING = 6;
async function fetchPhotoAttachments(mentionedListings) {
  if (!mentionedListings || mentionedListings.length === 0) return [];
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!serviceRoleKey || !supabaseUrl) return [];

  const txnIds = mentionedListings.map(l => l.id);
  const ownerIds = await getOwnerIdByTxn(serviceRoleKey, supabaseUrl, txnIds);

  const results = [];
  for (const l of mentionedListings) {
    const ownerId = ownerIds[l.id];
    if (!ownerId) continue;
    const photoIds = Array.isArray(l.photoDocIds) ? l.photoDocIds.slice() : [];
    if (photoIds.length === 0) continue;
    // Cover photo first if we have one
    let ordered = photoIds;
    if (l.coverPhotoId && photoIds.includes(l.coverPhotoId)) {
      ordered = [l.coverPhotoId, ...photoIds.filter(id => id !== l.coverPhotoId)];
    }
    ordered = ordered.slice(0, PHOTOS_PER_LISTING);
    for (const photoId of ordered) {
      const url = await signedUrl(serviceRoleKey, supabaseUrl, `${ownerId}/${photoId}`);
      if (url) {
        results.push({
          listingId: l.id,
          address: l.address,
          url,
          isCover: photoId === l.coverPhotoId,
        });
      }
    }
  }
  return results;
}

async function doChat({ messages, activeListings }) {
  // Build a rich listing summary — include ALL the fields Pipeline knows about
  // so Claude has them even when the NWMLS printout isn't attached.
  const listingLines = (activeListings && activeListings.length > 0)
    ? activeListings.map((l, i) => {
        const parts = [`${i + 1}. ${l.address || "(no address)"}`];
        if (l.city || l.state) parts.push([l.city, l.state].filter(Boolean).join(", "));
        if (l.listPrice) parts.push(`Price: $${Number(l.listPrice).toLocaleString()}`);
        if (l.beds) parts.push(`${l.beds} beds`);
        if (l.baths) parts.push(`${l.baths} baths`);
        if (l.sqft) parts.push(`${Number(l.sqft).toLocaleString()} sqft`);
        parts.push(`NWMLS printout: ${l.hasNwmls ? "yes" : "no"}`);
        parts.push(`Photos: ${l.photoCount || 0}`);
        return parts.join(" | ");
      }).join("\n")
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

  // Phase B+C: Find listings mentioned in the latest user message and attach
  // their NWMLS printout PDFs AND photos so Claude has the real details and
  // visual context to work with.
  const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
  const lastText = lastUserMsg?.content || "";
  const mentioned = findMentionedListings(lastText, activeListings);
  const nwmlsAtt = await fetchNwmlsAttachments(mentioned);
  const photoAtt = await fetchPhotoAttachments(mentioned);

  // If we have attachments, convert the LAST user message into a multimodal
  // message with the PDFs and photos attached.
  if ((nwmlsAtt.length > 0 || photoAtt.length > 0) && trimmed.length > 0) {
    const lastIdx = trimmed.length - 1;
    const lastMsg = trimmed[lastIdx];
    if (lastMsg.role === "user" && typeof lastMsg.content === "string") {
      const noteLines = [];
      if (nwmlsAtt.length > 0) {
        nwmlsAtt.forEach(a => noteLines.push(`Attached: NWMLS printout for ${a.address}.`));
      }
      if (photoAtt.length > 0) {
        noteLines.push(`Attached: ${photoAtt.length} photo${photoAtt.length === 1 ? "" : "s"} from the listing${photoAtt.length === 1 ? "" : "s"} (cover photo first).`);
      }

      const content = [
        {
          type: "text",
          text: `${lastMsg.content}\n\n${noteLines.join("\n")}\n(Pull real details from the attached NWMLS printout(s). The photos are for your visual reference — mention things you can actually see in them. Do not invent anything.)`,
        },
      ];
      // Attach PDFs first
      for (const a of nwmlsAtt) {
        content.push({ type: "document", source: { type: "url", url: a.url } });
      }
      // Then photos
      for (const p of photoAtt) {
        content.push({ type: "image", source: { type: "url", url: p.url } });
      }
      trimmed[lastIdx] = { role: "user", content };
    }
  }

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

  // Phase C: Return the photos we attached so the frontend can display them
  // as thumbnails with download links.
  const photosForFrontend = photoAtt.map(p => ({
    url: p.url,
    address: p.address,
    isCover: p.isCover,
  }));

  // Phase D1+D2: Detect overlay template from message and compose branded
  // graphic. Templates include JUST LISTED, PRICE DROP, OPEN HOUSE, COMING
  // SOON, PENDING, SOLD, etc.
  const brandedPhotos = [];
  const firstMentioned = mentioned[0] || null;
  const overlayInfo = detectOverlayTemplate(lastText, firstMentioned);
  if (overlayInfo && photoAtt.length > 0) {
    // Use the cover photo (first one) of the first mentioned listing
    const coverPhoto = photoAtt.find(p => p.isCover) || photoAtt[0];
    if (coverPhoto) {
      const brandedDataUrl = await composeBrandedImage(
        coverPhoto.url,
        overlayInfo.template,
        overlayInfo.args
      );
      if (brandedDataUrl) {
        brandedPhotos.push({
          url: brandedDataUrl,
          address: coverPhoto.address,
          template: overlayInfo.template,
          branded: true,
        });
      }
    }
  }

  return {
    reply: cleaned,
    post: cleaned,
    photos: photosForFrontend,
    brandedPhotos,
  };
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
