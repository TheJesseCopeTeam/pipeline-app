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
