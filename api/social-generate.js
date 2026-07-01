// api/social-generate.js
// Vercel serverless function for The Jesse Cope Team — Pipeline "Social Media" tab.
//
// SETUP (one time):
//   1. Put this file at the ROOT of your repo as:  api/social-generate.js
//   2. In Vercel → Project → Settings → Environment Variables, add:
//        Name:  ANTHROPIC_API_KEY
//        Value: <your key from console.anthropic.com>
//      IMPORTANT: do NOT prefix it with VITE_ — that would leak the key to the browser.
//   3. Redeploy. Done.
//
// The React tab calls this at  POST /api/social-generate

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } }, // MLS PDFs are small; headroom just in case
};

const MODEL = "claude-sonnet-4-6"; // swap the model string here if you ever want to

// --- Jesse's brand voice, baked in so every post sounds like him -------------
const VOICE = `
You write social media posts for The Jesse Cope Team, a real estate team at RE/MAX
Premier Group in Longview, WA, serving Cowlitz County / SW Washington (Longview,
Kelso, Castle Rock, Woodland, Toutle, Cathlamet).

VOICE & STYLE:
- Warm, energetic, buyer-and-seller focused, plainspoken. Talks like a real local, not a corporate account.
- Leans into the local outdoor identity: hunting, fishing, backpacking, rivers (the Toutle),
  mountains, elk, the trade-off of small-town living over the big-city commute. Use this
  flavor naturally — don't force it into every post.
- Feature lists are semicolon-separated. Uses CAPS for emphasis on key selling points
  (e.g. NO HOA; RV PARKING; MOVE-IN READY).
- Short, punchy sentences. A little personality and humor is welcome.
- Sign longer/value posts as "— The Jesse Cope Team" when it fits. Not every post needs it.
- End most posts with a light call to action (send a message, let's talk, drop a comment).
- Add 3-6 relevant hashtags at the end. Always local ones like #CowlitzCounty #SWWashington
  #LongviewWA #KelsoWA plus topical ones. Never overdo hashtags.
- One or two tasteful emojis max. Never spammy.

HARD RULES (do not break):
- NEVER invent specific numbers: no made-up mortgage rates, prices, interest rates, days-on-market,
  appreciation percentages, or market statistics. If a number would strengthen the post, insert a
  clearly bracketed placeholder like [current rate] or [price] for Jesse to fill in.
- When a lender is referenced, it's Brandon Nickel, Life Mortgage (NMLS #2042243). Only mention him
  when relevant.
- Never make legal, tax, or guaranteed-outcome promises.
- Output ONLY the post text, ready to copy-paste. No preamble, no explanations, no quotation marks
  around the whole thing, no "Here's your post:".
`.trim();

const POST_TYPE_PROMPTS = {
  lifestyle:
    "Write a hyperlocal lifestyle post about the appeal of living in Cowlitz County / SW Washington.",
  first_time_buyer:
    "Write an encouraging, myth-busting post aimed at first-time home buyers who think they can't afford it or need 20% down. Reassure and invite them to run real numbers.",
  myth_buster:
    "Write a punchy post that busts one common real estate myth (financing, timing, listing, inspections, etc.). Pick a good one.",
  seasonal_tip:
    "Write a practical seasonal home-maintenance or homeowner tip relevant to SW Washington homeowners right now.",
  engagement:
    "Write a short, fun engagement question designed to get comments — tie it to local life, the outdoors, or homeownership.",
  just_listed_teaser:
    "Write a 'building anticipation' teaser post for an upcoming or fresh listing WITHOUT specific address or price (use placeholders if needed). Make people want to ask for details.",
  surprise:
    "Pick whatever real-estate-related post type you think would perform best today and write it. Vary it up.",
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
      max_tokens: 1024,
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
Below is an MLS listing data sheet. Read it and write ONE ready-to-post social media
post announcing this listing. Pull the real details from the sheet: address (or general
area if you'd rather tease it), price, beds/baths, square footage, lot size, standout
features, and any highlights. Lead with what makes it special. Use the semicolon feature
list style with CAPS on the best selling points. If a detail isn't in the sheet, leave it
out — do NOT guess. Do not invent any numbers that aren't on the sheet.
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
      // random / topical post
      const base =
        POST_TYPE_PROMPTS[postType] || POST_TYPE_PROMPTS.surprise;
      const instruction = `${base}${
        notes ? `\n\nExtra direction from Jesse: ${notes}` : ""
      }\n\nMake it fresh — assume Jesse posts often, so avoid clichés he's likely used before.`;

      messages = [{ role: "user", content: instruction }];
    }

    const post = await callClaude(messages, VOICE);
    return res.status(200).json({ post });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Generation failed." });
  }
}
