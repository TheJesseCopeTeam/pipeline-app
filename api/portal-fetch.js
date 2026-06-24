// Vercel Serverless Function: /api/portal-fetch
//
// Public endpoint — no auth required. Looks up a transaction by portal_token
// and returns a SANITIZED version (no commission, no private notes, no
// confidential fields) plus signed download URLs for any documents.
//
// Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS — the token itself is the
// access control. The token must be long enough to be unguessable (32+ chars).

const SAFE_PORTAL_FIELDS = [
  "id", "type", "status", "address", "city", "state", "zip",
  "price", "listPrice", "earnestMoney", "downPayment",
  "contractDate", "closingDate", "financingType",
  "milestones", "documents", "clientPortal",
  "sellerName", "buyerName",
];

// Fields we strip out before sending to the client portal
const NEVER_SHARE_FIELDS = [
  "commission", "listingCommission", "buyingCommission",
  "notes", // private notes — clientNotes (inside clientPortal) is separate and shared
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { token } = req.body || {};
  if (!token || typeof token !== "string" || token.length < 16) {
    return res.status(400).json({ error: "Invalid token" });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({
      error: "Portal not configured. Server is missing Supabase credentials.",
    });
  }

  try {
    // Query the transactions table for one matching this token, with portal enabled.
    // Using PostgREST's JSON containment operator @> via the REST API.
    const queryUrl = `${supabaseUrl}/rest/v1/transactions?` +
      `select=id,owner_id,data&` +
      `data->>portalToken=eq.${encodeURIComponent(token)}&` +
      `limit=1`;
    const lookup = await fetch(queryUrl, {
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!lookup.ok) {
      const errText = await lookup.text();
      console.error("Portal lookup failed:", lookup.status, errText);
      return res.status(500).json({ error: "Database lookup failed" });
    }

    const rows = await lookup.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: "Portal link not found. It may have been disabled or regenerated." });
    }

    const row = rows[0];
    const txn = row.data || {};
    const portal = txn.clientPortal || {};

    if (!portal.enabled) {
      return res.status(404).json({ error: "Portal is not enabled for this transaction." });
    }

    // Build sanitized transaction object
    const safe = {};
    for (const key of SAFE_PORTAL_FIELDS) {
      if (txn[key] !== undefined) safe[key] = txn[key];
    }
    // Strip confidential fields explicitly (belt and suspenders)
    for (const bad of NEVER_SHARE_FIELDS) {
      delete safe[bad];
    }

    // Filter milestones to only those flagged as visible to clients
    const visibleMs = new Set(portal.visibleMilestones || []);
    if (safe.milestones && visibleMs.size > 0) {
      safe.milestones = safe.milestones.filter(m => visibleMs.has(m.id));
    } else if (visibleMs.size === 0) {
      safe.milestones = [];
    }

    // Strip the visibleMilestones list itself + commission flags from clientPortal
    if (safe.clientPortal) {
      const { visibleMilestones, ...portalRest } = safe.clientPortal;
      // showFinancials controls whether we expose price-y fields
      if (portalRest.showFinancials === false) {
        delete safe.price;
        delete safe.listPrice;
        delete safe.earnestMoney;
        delete safe.downPayment;
      }
      safe.clientPortal = portalRest;
    }

    // Generate signed download URLs for documents (1 hour validity)
    if (Array.isArray(safe.documents) && safe.documents.length > 0) {
      const ownerId = row.owner_id;
      const signedDocs = await Promise.all(safe.documents.map(async (doc) => {
        if (!doc.cloud) {
          // Local-mode docs can't be served via portal — skip them
          return { ...doc, downloadUrl: null, unavailable: true };
        }
        try {
          const path = `${ownerId}/${doc.id}`;
          // Don't URL-encode the path — Supabase wants literal slashes here.
          // If we encode, the path Supabase signs differs from the path the
          // client hits later → "InvalidSignature" error.
          const signUrl = `${supabaseUrl}/storage/v1/object/sign/documents/${path}`;
          const signRes = await fetch(signUrl, {
            method: "POST",
            headers: {
              "apikey": serviceRoleKey,
              "Authorization": `Bearer ${serviceRoleKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ expiresIn: 3600 }),
          });
          if (!signRes.ok) {
            const errText = await signRes.text();
            console.error("Sign URL failed:", signRes.status, errText);
            return { ...doc, downloadUrl: null, unavailable: true };
          }
          const signData = await signRes.json();
          // signedURL is a path starting with /object/sign/... — prefix with the storage base URL
          const pathSegment = signData.signedURL || signData.signedUrl || "";
          const fullUrl = `${supabaseUrl}/storage/v1${pathSegment}`;
          return {
            id: doc.id,
            name: doc.name,
            type: doc.type,
            size: doc.size,
            addedAt: doc.addedAt,
            downloadUrl: fullUrl,
          };
        } catch (e) {
          console.error("Sign URL failed for doc", doc.id, e);
          return { ...doc, downloadUrl: null, unavailable: true };
        }
      }));
      safe.documents = signedDocs;
    }

    return res.status(200).json({ transaction: safe });
  } catch (err) {
    console.error("Portal fetch error:", err);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "1mb" },
  },
};
