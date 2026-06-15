// Vercel Serverless Function: /api/parse-contract
//
// Receives EITHER a base64 PDF (small files) or a signed URL (large files)
// plus a prompt from the browser, forwards to Anthropic's API using the
// ANTHROPIC_API_KEY environment variable (set in Vercel dashboard), and
// returns the response. Keeps the key server-side so it never reaches the
// user's browser.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Server not configured. Add ANTHROPIC_API_KEY in Vercel project settings."
    });
  }

  try {
    const { pdfBase64, pdfUrl, prompt } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }
    if (!pdfBase64 && !pdfUrl) {
      return res.status(400).json({ error: "Missing pdfBase64 or pdfUrl" });
    }

    // Build the document source: prefer URL when provided (large files),
    // fall back to base64 (small files).
    const documentSource = pdfUrl
      ? { type: "url", url: pdfUrl }
      : { type: "base64", media_type: "application/pdf", data: pdfBase64 };

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: documentSource },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("Anthropic API error:", upstream.status, errText);
      return res.status(upstream.status).json({
        error: `Anthropic API error (${upstream.status}). Check your API key and account credits.`,
      });
    }

    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error("Parse error:", err);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}

// Vercel: small base64 PDFs use this path; larger ones go via signed URL so the
// body stays tiny. 10 MB ceiling is plenty for either case.
export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};
