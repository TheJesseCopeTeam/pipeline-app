// api/social-generate.js
// Vercel serverless function for The Jesse Cope Team — Pipeline "Social Media" tab.
//
// This version is tuned to match Jesse's ACTUAL posting style:
// ALL-CAPS headline, emoji line-markers, bulleted feature sections with
// headers, a price callout, and a "message me / link below" close + hashtags.
//
// SETUP is unchanged — you already did it:
//   - ANTHROPIC_API_KEY is set in Vercel env vars (no VITE_ prefix)
//   - This file lives at  api/social-generate.js
// Just replace the old file with this one and commit.
//
// Modes:
//   "listings" — uses the active listings in Pipeline (their NWMLS printouts +
//                photos stored under Listing Files). Picks listings from a plain-
//                English request, writes the post(s), and picks the photos.
//   "listing"  — one uploaded MLS sheet PDF
//   "random"   — non-listing content posts

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

const MODEL = "claude-sonnet-4-6";

// --- Jesse's brand voice + FORMAT, baked in ---------------------------------
const VOICE = `
You write Facebook/Instagram posts for The Jesse Cope Team, a real estate team at
RE/MAX Premier Group in Longview, WA, serving Cowlitz County / SW Washington
(Longview, Kelso, Castle Rock, Woodland, Toutle, Cathlamet).

CRITICAL: These posts must be VISUAL and SCANNABLE — never flat paragraphs.
Jesse's posts always have an ALL-CAPS headline, emoji markers at the start of
key lines, bulleted feature sections with little section headers, and a clear
call to action with hashtags. Match that energy and structure exactly.

VOICE:
- Warm, high-energy, enthusiastic, plainspoken. Sounds like a real local, not a corporate account.
- Uses CAPS for emphasis on headlines and key selling points (PRICE IMPROVEMENT, NEW LISTING, MOTIVATED SELLER, $15K PRICE DROP).
- Leans into local SW Washington life and the outdoor identity (shops, RV parking, acreage, room to roam, hunting/fishing country) when it fits the property.
- Excited but never fake — every claim ties to a real detail.

EMOJI:
- Use emoji as line-markers at the START of key lines, real-estate style:
  location-pin address, money-bag price, bed beds, bath baths, ruler square footage, house lot/acreage
  sparkle or key for the "Features you'll love" header, tree for "Outdoor highlights"
  mobile-phone for the "message me" call to action.
- One emoji per key line. Tasteful and useful, never a spammy wall of emoji.

HARD RULES:
- NEVER invent numbers. No made-up prices, square footage, bed/bath counts, mortgage rates, or stats.
  If a detail isn't provided, leave that line out entirely — do not guess.
- For the listing link, always end with the placeholder [paste listing link here] on its own line — you never know the real URL.
- Output ONLY the finished post, ready to copy-paste. No preamble, no "Here's your post:", no quotation marks wrapping it, no explanation.
`.trim();

// The exact skeleton to follow for a LISTING post.
const LISTING_SKELETON = `
Follow this structure (omit any line whose info you don't have — never invent it):

[ALL-CAPS HEADLINE — e.g. "NEW LISTING!" or "PRICE IMPROVEMENT + MOTIVATED SELLER!"]
(location pin) [Street Address, City, State]
(money bag) [Price]   -- if it's a price drop, add "— $[X]K PRICE DROP!" in caps
(bed) [X] Bedrooms | (bath) [X] Bathrooms | (ruler) ~[X] Sq Ft

[1–2 sentence hook that pulls the reader in and captures what's special.]

(sparkle) Features you'll love:
- [feature]
- [feature]
- [feature]
(4–6 bullets, using a bullet character)

(tree) Outdoor highlights:
- [feature]
- [feature]
(include this section only if there are outdoor/shop/land/parking features)

[One warm closing sentence summing up the appeal.]

(mobile phone) Message me for more details or click the link below for more info and pictures:
[paste listing link here]

[8–12 relevant hashtags on one line — see hashtag guidance]

Use real emoji (not these text labels) as the line markers, and a real bullet character for list items.
`.trim();

const HASHTAG_GUIDANCE = `
Hashtags: always include #TheJesseCopeTeam and #REMAX. Always include local ones:
#LongviewWA #KelsoWA #CowlitzCounty #SWWashington #WashingtonRealEstate
#PacificNorthwestRealEstate. Then add topical ones that fit the post, e.g.
#NewListing #PriceImprovement #HomeForSale #DreamProperty #AcreageProperty
#ShopSpace #JustListed. Pick 8–12 total for a listing, fewer (4–6) for a non-listing post.
`.trim();

const POST_TYPE_PROMPTS = {
  lifestyle:
    "Write a hyperlocal lifestyle post about the appeal of living in Cowlitz County / SW Washington. Give it a short ALL-CAPS or emoji-led hook, a punchy middle (a short bulleted list is welcome), and a call to action to message Jesse. Keep the energy of a listing post even though it's not a listing.",
  first_time_buyer:
    "Write an encouraging, myth-busting post for first-time buyers who think they can't afford it or need 20% down. Lead with a bold hook, keep it upbeat, use a few bullets if helpful, and end with a call to action to message Jesse / connect with lender Brandon Nickel. Use placeholders in [brackets] for any numbers.",
  myth_buster:
    "Write a punchy myth-buster post that busts one common real estate myth. Bold ALL-CAPS or emoji hook, quick explanation, clear call to action. Never invent stats — use [brackets] if a number would help.",
  seasonal_tip:
    "Write a practical seasonal home tip for SW Washington homeowners right now. Give it a bold/emoji hook and a short bulleted checklist, then a friendly call to action.",
  engagement:
    "Write a short, fun engagement question tied to local life, the outdoors, or homeownership, designed to get comments. Emoji-led, high energy, ends by inviting people to drop a comment.",
  just_listed_teaser:
    "Write a 'COMING SOON / teaser' post building anticipation for a listing WITHOUT a specific address or price (use placeholders). Bold headline, a few tantalizing emoji-led lines, and a call to action to message Jesse for early details.",
  surprise:
    "Pick whatever real-estate post type would perform best today and write it in Jesse's high-energy, emoji-led, scannable style with a clear call to action.",
};

async function callClaude(messages, system) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${detail}`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ─── "My listings" mode ──────────────────────────────────────────────────────
// The Pipeline sends every active listing (address, price, and temporary links
// to its NWMLS printout + photos). Step 1 figures out which listings the
// request is about. Step 2 reads those printouts/photos and writes the post(s),
// and picks which photos to use.

const PICK_MODEL = "claude-haiku-4-5";

async function callClaudeTool({ model, system, messages, tool, maxTokens }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "tool_use");
  if (!block) throw new Error("The AI didn't return a usable answer. Try again.");
  return block.input || {};
}

const PICK_TOOL = {
  name: "select_listings",
  description: "Choose which of Jesse's active listings the request is about.",
  input_schema: {
    type: "object",
    properties: {
      listing_ids: {
        type: "array",
        items: { type: "string" },
        description: "IDs of the listings the request refers to. All of them if the request says all/every/active listings or doesn't name specific ones.",
      },
    },
    required: ["listing_ids"],
  },
};

const POSTS_TOOL = {
  name: "deliver_posts",
  description: "Return the finished social media post(s).",
  input_schema: {
    type: "object",
    properties: {
      posts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short label for Jesse, e.g. '123 Main St — New Listing' or 'Active Listings Roundup'" },
            listing_ids: { type: "array", items: { type: "string" }, description: "IDs of the listing(s) this post covers" },
            post_text: { type: "string", description: "The finished, ready-to-paste post" },
            photo_labels: {
              type: "array",
              items: { type: "string" },
              description: "Labels of the photos to post with it (e.g. 'L1-P3'), best first, in the order to upload them",
            },
          },
          required: ["title", "listing_ids", "post_text", "photo_labels"],
        },
      },
    },
    required: ["posts"],
  },
};

const ROUNDUP_SKELETON = `
For ONE post covering several listings, follow this structure:

[ALL-CAPS HEADLINE — e.g. "CHECK OUT OUR ACTIVE LISTINGS!"]
[1 short sentence intro.]

Then for each listing, a block like:
(house) [Street Address, City]
(money bag) [Price] | (bed) [X] Bd | (bath) [X] Ba | (ruler) ~[X] Sq Ft
(sparkle) [one short line on what stands out]

(blank line between listings)

(mobile phone) Message me for more details or click the links below for more info and pictures:
[paste listing links here]

[8–12 relevant hashtags on one line]

Use real emoji (not these text labels).
`.trim();

function listingFactsText(l) {
  const lines = [
    `Address: ${[l.address, l.city, l.state, l.zip].filter(Boolean).join(", ") || "(not entered)"}`,
  ];
  if (l.listPrice) lines.push(`List price in Pipeline: $${String(l.listPrice).replace(/^\$/, "")}`);
  if (l.includedItems) lines.push(`Included items: ${l.includedItems}`);
  return lines.join("\n");
}

async function handleListings(body) {
  const request = String(body.request || "").slice(0, 2000) || "Create a post for each of my active listings.";
  const all = Array.isArray(body.listings) ? body.listings : [];
  if (all.length === 0) {
    return { status: 400, json: { error: "No active listings were sent." } };
  }

  // Step 1 — which listings?
  let selected = all;
  if (!body.forceAll && all.length > 1) {
    const roster = all
      .map((l) => `${l.id} | ${[l.address, l.city].filter(Boolean).join(", ")} | ${l.listPrice ? "$" + l.listPrice : "price not entered"}`)
      .join("\n");
    const pick = await callClaudeTool({
      model: PICK_MODEL,
      maxTokens: 500,
      system: "You match a real estate agent's request to his listings. Agents refer to listings loosely by street name or number (e.g. 'the 23rd listing' = an address on 23rd Ave; 'Bond' = Bond Rd). If the request says all/every/active listings, or names none, select all of them.",
      tool: PICK_TOOL,
      messages: [{ role: "user", content: `Active listings (id | address | price):\n${roster}\n\nRequest: "${request}"` }],
    });
    const ids = new Set((pick.listing_ids || []).map(String));
    selected = all.filter((l) => ids.has(String(l.id)));
    if (selected.length === 0) {
      return {
        status: 400,
        json: { error: "I couldn't tell which listings you meant. Name the street (e.g. \"the Bond Rd listing\") or tap the listings in the list." },
      };
    }
  }

  const MAX_LISTINGS = 8;
  if (selected.length > MAX_LISTINGS) selected = selected.slice(0, MAX_LISTINGS);
  const photosPer = selected.length <= 2 ? 12 : selected.length <= 4 ? 8 : 5;

  // Step 2 — build the content: facts + NWMLS printout + labeled photos per listing
  const content = [];
  const labelToPhoto = {};
  selected.forEach((l, i) => {
    const n = i + 1;
    content.push({ type: "text", text: `=== LISTING L${n} (id: ${l.id}) ===\n${listingFactsText(l)}` });

    const nwmls = Array.isArray(l.nwmls) ? l.nwmls.slice(0, 2) : [];
    if (nwmls.length === 0) {
      content.push({ type: "text", text: `(No NWMLS printout uploaded for L${n} — use only the facts above and the photos. Leave out any detail you don't have.)` });
    }
    nwmls.forEach((d) => {
      if (!d.url) return;
      if (String(d.type || "").startsWith("image/")) {
        content.push({ type: "text", text: `NWMLS printout page for L${n}:` });
        content.push({ type: "image", source: { type: "url", url: d.url } });
      } else {
        content.push({ type: "text", text: `NWMLS printout for L${n}:` });
        content.push({ type: "document", source: { type: "url", url: d.url } });
      }
    });

    const photos = Array.isArray(l.photos) ? l.photos.slice(0, photosPer) : [];
    photos.forEach((p, k) => {
      if (!p.url) return;
      const label = `L${n}-P${k + 1}`;
      labelToPhoto[label] = p.id;
      content.push({ type: "text", text: `Photo ${label}:` });
      content.push({ type: "image", source: { type: "url", url: p.url } });
    });
  });

  const instruction = `
Jesse's request: "${request}"

Write what he asked for using the listings above (L1, L2, ...). Pull details from each NWMLS printout:
address, price, beds/baths, square footage, lot/acreage, standout interior features, and any
outdoor/shop/land/parking highlights. The photos help you see what stands out, but don't
describe anything you can't confirm from the printout or a photo.

HOW MANY POSTS:
- If he asks for ONE post covering several or all listings (e.g. "a post with all my active listings",
  "a roundup"), write ONE roundup post.
- If he asks for a post for each listing, or names one listing, write one post per listing.
- If he only selected/mentioned one listing, write one post.
- If it's unclear and there are several listings, write one post per listing.

For a single-listing post:
${LISTING_SKELETON}

${ROUNDUP_SKELETON}

${HASHTAG_GUIDANCE}

If the request mentions a price change, open house, coming soon, or anything else, adapt the
headline and add that info — use [brackets] for any number or time he didn't give you.

PHOTOS: for each post, pick photos by their labels (e.g. "L1-P3") in the order to upload them.
Lead with the strongest exterior/front shot, then the best interior rooms (kitchen, living, primary),
then outdoor/shop/view shots. Skip blurry, dark, duplicate, or non-photo images (floor plans, maps, logos).
Single-listing post: 6–10 photos if available. Roundup: the 1–2 best photos per listing, 10 max total.

Only include details actually found in the material above. Do NOT invent anything.
Return everything with the deliver_posts tool.
`.trim();
  content.push({ type: "text", text: instruction });

  const out = await callClaudeTool({
    model: MODEL,
    maxTokens: 6000,
    system: VOICE,
    tool: POSTS_TOOL,
    messages: [{ role: "user", content }],
  });

  const validIds = new Set(selected.map((l) => String(l.id)));
  const posts = (out.posts || []).map((p) => ({
    title: p.title || "",
    listingIds: (p.listing_ids || []).map(String).filter((id) => validIds.has(id)),
    post: String(p.post_text || "").trim(),
    photoIds: (p.photo_labels || []).map((lab) => labelToPhoto[String(lab).trim()]).filter(Boolean),
  })).filter((p) => p.post);

  return { status: 200, json: { posts, usedListingIds: selected.map((l) => l.id) } };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not set in Vercel environment variables." });
  }

  try {
    const { mode, postType, pdfBase64, notes } = req.body || {};

    if (mode === "listings") {
      const out = await handleListings(req.body || {});
      return res.status(out.status).json(out.json);
    }

    let messages;

    if (mode === "listing") {
      if (!pdfBase64) {
        return res.status(400).json({ error: "No listing sheet provided." });
      }
      const instruction = `
Below is an MLS listing data sheet. Read it and write ONE ready-to-post listing
post in Jesse's exact style, pulling the real details from the sheet (address,
price, beds/baths, square footage, lot/acreage, standout interior features,
and any outdoor/shop/land/parking highlights).

${LISTING_SKELETON}

${HASHTAG_GUIDANCE}

Only include details actually found on the sheet. Do NOT invent anything.
${notes ? `\nExtra direction from Jesse: ${notes}` : ""}
`.trim();

      messages = [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
            },
            { type: "text", text: instruction },
          ],
        },
      ];
    } else {
      const base = POST_TYPE_PROMPTS[postType] || POST_TYPE_PROMPTS.surprise;
      const instruction = `
${base}

${HASHTAG_GUIDANCE}

Make it fresh — assume Jesse posts often, so avoid clichés he's likely used before.
Keep it visual and scannable (emoji-led lines, short bullets where useful), never a flat paragraph.
${notes ? `\nExtra direction from Jesse: ${notes}` : ""}
`.trim();

      messages = [{ role: "user", content: instruction }];
    }

    const post = await callClaude(messages, VOICE);
    return res.status(200).json({ post });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Generation failed." });
  }
}
