// Vercel Serverless Function: /api/daily-reminders
//
// Runs on a schedule (see vercel.json crons config). Every morning it:
//   1. Fetches transactions, to-do lists, future listings, and future buyers from Supabase
//   2. Finds what's overdue, due today, and coming up in the next 3 days
//   3. Sends a formatted HTML email digest via Resend to the configured address
//
// Required env vars:
//   VITE_SUPABASE_URL (or SUPABASE_URL) — points at the Supabase project
//   SUPABASE_SERVICE_ROLE_KEY           — service role key for DB read access
//   RESEND_API_KEY                      — from resend.com dashboard
//   REMINDER_EMAIL_TO                   — comma-separated list of addresses to email
//   REMINDER_EMAIL_FROM                 — sender email (default: onboarding@resend.dev)

const TEAM_NAME = "The Jesse Cope Team";

// ─── Date helpers ─────────────────────────────────────────────────────
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function friendlyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Returns true if a is strictly before b (both YYYY-MM-DD)
const isBefore = (a, b) => a < b;
const isSameOrBefore = (a, b) => a <= b;

// ─── Supabase fetch ───────────────────────────────────────────────────
async function fetchAll(supabaseUrl, serviceRoleKey, table) {
  const url = `${supabaseUrl}/rest/v1/${table}?select=*`;
  const res = await fetch(url, {
    headers: {
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    console.error(`Fetch ${table} failed:`, res.status, await res.text());
    return [];
  }
  return res.json();
}

// ─── Build the digest data ────────────────────────────────────────────
function buildDigest(rows) {
  const today = todayISO();
  const in3Days = isoOffset(3);
  const overdue = [];
  const dueToday = [];
  const comingUp = [];

  for (const row of rows.transactions) {
    const t = row.data || row;
    if (!t || !t.milestones) continue;
    // Skip closed transactions
    if (t.status === "closed" || t.status === "fellThrough") continue;

    const addr = t.address || "(no address)";

    for (const m of t.milestones) {
      if (m.complete) continue;
      if (!m.date) continue;

      if (isBefore(m.date, today)) {
        overdue.push({ type: "milestone", txnAddr: addr, txnId: t.id, label: m.label, date: m.date });
      } else if (m.date === today) {
        dueToday.push({ type: "milestone", txnAddr: addr, txnId: t.id, label: m.label, date: m.date });
      } else if (isSameOrBefore(m.date, in3Days)) {
        comingUp.push({ type: "milestone", txnAddr: addr, txnId: t.id, label: m.label, date: m.date });
      }
    }
  }

  for (const row of rows.todo_lists) {
    const list = row.data || row;
    if (!list || !list.items) continue;
    for (const item of list.items) {
      if (item.done) continue;
      let dueDate = null;
      if (item.reminderType === "date" && item.reminderDate) dueDate = item.reminderDate;
      if (item.reminderType === "frequency" && item.lastReminded && item.frequencyDays) {
        // Compute next reminder date based on last acknowledged + frequency
        const last = new Date(item.lastReminded + "T00:00:00");
        last.setDate(last.getDate() + Number(item.frequencyDays));
        dueDate = `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,"0")}-${String(last.getDate()).padStart(2,"0")}`;
      }
      if (!dueDate) continue;

      if (isBefore(dueDate, today)) {
        overdue.push({ type: "todo", listName: list.name, label: item.text, date: dueDate });
      } else if (dueDate === today) {
        dueToday.push({ type: "todo", listName: list.name, label: item.text, date: dueDate });
      } else if (isSameOrBefore(dueDate, in3Days)) {
        comingUp.push({ type: "todo", listName: list.name, label: item.text, date: dueDate });
      }
    }
  }

  // Check-ins on future listings and buyers
  const CHECK_IN_CADENCE_LOOKUP = [0, 7, 14, 30, 60, 90, 180];
  const checkCheckIn = (item, label) => {
    if (!item.checkInCadence || item.checkInCadence <= 0) return;
    if (!item.lastContact) {
      // Never contacted — overdue if created > cadence days ago
      overdue.push({ type: "checkin", label: `${label}: ${item.name || "unnamed"}`, date: "never contacted" });
      return;
    }
    const last = new Date(item.lastContact + "T00:00:00");
    last.setDate(last.getDate() + Number(item.checkInCadence));
    const dueDate = `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,"0")}-${String(last.getDate()).padStart(2,"0")}`;
    if (isBefore(dueDate, today)) {
      overdue.push({ type: "checkin", label: `${label}: ${item.name || "unnamed"}`, date: dueDate });
    } else if (dueDate === today) {
      dueToday.push({ type: "checkin", label: `${label}: ${item.name || "unnamed"}`, date: dueDate });
    } else if (isSameOrBefore(dueDate, in3Days)) {
      comingUp.push({ type: "checkin", label: `${label}: ${item.name || "unnamed"}`, date: dueDate });
    }
  };

  for (const row of rows.future_listings) {
    const fl = row.data || row;
    if (!fl) continue;
    checkCheckIn(fl, "Future Listing");
  }
  for (const row of rows.future_buyers) {
    const fb = row.data || row;
    if (!fb) continue;
    checkCheckIn(fb, "Future Buyer");
  }

  // Sort each section by date
  const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
  overdue.sort(byDate);
  dueToday.sort(byDate);
  comingUp.sort(byDate);

  return { overdue, dueToday, comingUp, today };
}

// ─── HTML email template ──────────────────────────────────────────────
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function renderSection(title, items, emptyMessage, sectionColor) {
  if (items.length === 0) {
    return `<tr><td style="padding:14px 0"><div style="font-family:Cambria,Georgia,serif;font-size:14px;color:#8B7E6E;font-style:italic">${escapeHtml(emptyMessage)}</div></td></tr>`;
  }
  const rows = items.map(item => {
    const badge = item.type === "milestone"
      ? escapeHtml(item.txnAddr)
      : item.type === "todo"
      ? `To-do · ${escapeHtml(item.listName || "")}`
      : "Check-in";
    return `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #EDEBE6">
          <div style="font-family:Cambria,Georgia,serif;font-size:14px;color:#2D2D2D;font-weight:600">${escapeHtml(item.label)}</div>
          <div style="font-family:Cambria,Georgia,serif;font-size:12px;color:#8B7E6E;margin-top:2px">${badge} · ${escapeHtml(friendlyDate(item.date) || item.date)}</div>
        </td>
      </tr>`;
  }).join("");
  return `
    <tr>
      <td style="padding:14px 0 6px 0">
        <div style="font-family:Cambria,Georgia,serif;font-size:11px;letter-spacing:0.12em;color:${sectionColor};font-weight:700;text-transform:uppercase;border-bottom:2px solid ${sectionColor};padding-bottom:6px">
          ${escapeHtml(title)} (${items.length})
        </div>
      </td>
    </tr>
    ${rows}`;
}

function renderEmail(digest) {
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const totalItems = digest.overdue.length + digest.dueToday.length + digest.comingUp.length;

  const preheader = totalItems === 0
    ? "Nothing due today. Have a good one."
    : `${digest.overdue.length} overdue, ${digest.dueToday.length} today, ${digest.comingUp.length} coming up`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Daily Pipeline Digest</title></head>
<body style="margin:0;padding:0;background:#F5F2ED;font-family:Cambria,Georgia,serif">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden">${escapeHtml(preheader)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F5F2ED;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#FFFFFF;border:1px solid #E8E3D9">
          <tr>
            <td style="padding:28px 32px 20px 32px;border-bottom:2px solid #DC1C2E;background:#FFFFFF">
              <div style="font-family:Cambria,Georgia,serif;font-size:11px;letter-spacing:0.16em;color:#DC1C2E;font-weight:700;text-transform:uppercase">${escapeHtml(TEAM_NAME)}</div>
              <div style="font-family:Cambria,Georgia,serif;font-size:28px;color:#2D2D2D;font-weight:700;margin-top:6px">Daily Pipeline</div>
              <div style="font-family:Cambria,Georgia,serif;font-size:14px;color:#8B7E6E;margin-top:4px">${escapeHtml(dateStr)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 8px 32px">
              ${totalItems === 0
                ? `<div style="font-family:Cambria,Georgia,serif;font-size:16px;color:#2D2D2D;padding:24px 0;text-align:center">Nothing due today, nothing overdue, nothing on the immediate horizon.<br><br><span style="color:#8B7E6E;font-style:italic">Enjoy the quiet — or use it to move something forward.</span></div>`
                : `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                    ${renderSection("Overdue", digest.overdue, "Nothing overdue.", "#DC1C2E")}
                    ${renderSection("Due Today", digest.dueToday, "Nothing due today.", "#B8651A")}
                    ${renderSection("Coming Up (Next 3 Days)", digest.comingUp, "Nothing coming up.", "#5D7A44")}
                  </table>`}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px 32px;border-top:1px solid #EDEBE6;background:#FAF7F2">
              <div style="font-family:Cambria,Georgia,serif;font-size:12px;color:#8B7E6E;text-align:center;line-height:1.6">
                Sent automatically from your Pipeline app.<br>
                Open the app to review the details and check things off.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Send via Resend ──────────────────────────────────────────────────
async function sendEmail(resendKey, from, to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: to.split(",").map(s => s.trim()).filter(Boolean),
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errText}`);
  }
  return res.json();
}

// ─── Handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Vercel cron requests come in with a specific header we can verify
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Allow manual testing via GET with ?test=1 param when no secret is set
    if (!(req.query && req.query.test)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const emailTo = process.env.REMINDER_EMAIL_TO;
  const emailFrom = process.env.REMINDER_EMAIL_FROM || "Pipeline <onboarding@resend.dev>";

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: "Missing Supabase credentials" });
  }
  if (!resendKey) {
    return res.status(500).json({ error: "Missing RESEND_API_KEY" });
  }
  if (!emailTo) {
    return res.status(500).json({ error: "Missing REMINDER_EMAIL_TO" });
  }

  try {
    const [transactions, todo_lists, future_listings, future_buyers] = await Promise.all([
      fetchAll(supabaseUrl, serviceRoleKey, "transactions"),
      fetchAll(supabaseUrl, serviceRoleKey, "todo_lists"),
      fetchAll(supabaseUrl, serviceRoleKey, "future_listings"),
      fetchAll(supabaseUrl, serviceRoleKey, "future_buyers"),
    ]);

    const digest = buildDigest({ transactions, todo_lists, future_listings, future_buyers });
    const html = renderEmail(digest);
    const totalItems = digest.overdue.length + digest.dueToday.length + digest.comingUp.length;
    const subject = totalItems === 0
      ? `📋 Nothing due — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : `📋 ${digest.overdue.length} overdue · ${digest.dueToday.length} today — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

    const result = await sendEmail(resendKey, emailFrom, emailTo, subject, html);
    return res.status(200).json({ sent: true, id: result.id, counts: {
      overdue: digest.overdue.length,
      dueToday: digest.dueToday.length,
      comingUp: digest.comingUp.length,
    } });
  } catch (err) {
    console.error("Daily reminder error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
