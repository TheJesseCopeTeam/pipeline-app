// /api/daily-reminders.js
// Vercel serverless function — sends the daily morning brief email.
// Called by Vercel Cron each weekday at 14:00 UTC (7am PDT / 6am PST),
// and can also be invoked manually from the Vercel dashboard for testing.
//
// Required env vars:
//   VITE_SUPABASE_URL (or SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   REMINDER_EMAIL_TO       (comma-separated list is fine)
//   REMINDER_EMAIL_FROM     (optional — defaults to Resend's onboarding sender)

const TEAM_NAME = "The Jesse Cope Team";
const COMING_UP_DAYS = 5;

// ─── Date helpers ──────────────────────────────────────────────────────
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function friendlyDate(iso) {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Data loading ──────────────────────────────────────────────────────
async function fetchTable(supabaseUrl, key, table) {
  const url = `${supabaseUrl}/rest/v1/${table}?select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return [];
  return res.json();
}

// ─── Digest building ───────────────────────────────────────────────────
function buildDigest(rows) {
  const today = todayISO();
  const horizon = isoOffset(COMING_UP_DAYS);
  const overdue = [];
  const dueToday = [];
  const comingUp = [];

  const bucket = (dueDate, item) => {
    if (!dueDate) return;
    if (dueDate < today) overdue.push({ ...item, date: dueDate });
    else if (dueDate === today) dueToday.push({ ...item, date: dueDate });
    else if (dueDate <= horizon) comingUp.push({ ...item, date: dueDate });
  };

  // Transactions & milestones
  for (const row of (rows.transactions || [])) {
    const t = row.data || row;
    if (!t || !Array.isArray(t.milestones)) continue;
    if (t.status === "closed" || t.status === "fellThrough") continue;
    const addr = t.address || "(no address)";
    for (const m of t.milestones) {
      if (m.complete || !m.date) continue;
      bucket(m.date, {
        type: "milestone",
        label: m.label,
        source: addr,
      });
    }
  }

  // To-do lists
  for (const row of (rows.todo_lists || [])) {
    const list = row.data || row;
    if (!list || !Array.isArray(list.items)) continue;
    for (const item of list.items) {
      if (item.done) continue;
      if (!item.reminderType || item.reminderType === "none") continue;

      let dueDate = null;
      if (item.reminderType === "date" && item.reminderDate) {
        dueDate = item.reminderDate;
      } else if (item.reminderType === "frequency" && item.reminderDays > 0) {
        const base = item.lastReminded ||
          (item.createdAt ? String(item.createdAt).split("T")[0] : todayISO());
        const baseDate = new Date(`${base}T00:00:00`);
        baseDate.setDate(baseDate.getDate() + Number(item.reminderDays));
        dueDate = `${baseDate.getFullYear()}-${String(baseDate.getMonth() + 1).padStart(2, "0")}-${String(baseDate.getDate()).padStart(2, "0")}`;
      }
      bucket(dueDate, {
        type: "todo",
        label: item.text,
        source: `To-Do: ${list.name || ""}`,
      });
    }
  }

  // Future listings / buyers — stale check-ins
  const checkCheckIn = (item, label) => {
    if (!item || !item.checkInCadence || Number(item.checkInCadence) <= 0) return;
    if (!item.lastContact) {
      overdue.push({
        type: "checkin",
        label: `${label}: ${item.name || "unnamed"}`,
        source: "Check-in",
        date: "never contacted",
      });
      return;
    }
    const last = new Date(`${item.lastContact}T00:00:00`);
    last.setDate(last.getDate() + Number(item.checkInCadence));
    const dueDate = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
    bucket(dueDate, {
      type: "checkin",
      label: `${label}: ${item.name || "unnamed"}`,
      source: "Check-in",
    });
  };

  for (const row of (rows.future_listings || [])) {
    checkCheckIn(row.data || row, "Future Listing");
  }
  for (const row of (rows.future_buyers || [])) {
    checkCheckIn(row.data || row, "Future Buyer");
  }

  const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
  overdue.sort(byDate);
  dueToday.sort(byDate);
  comingUp.sort(byDate);

  return { overdue, dueToday, comingUp };
}

// ─── Email HTML ────────────────────────────────────────────────────────
function renderSection(title, items, color) {
  if (items.length === 0) return "";
  const rowHtml = items.map(item => {
    const dateLabel = friendlyDate(item.date) || item.date;
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #EDEBE6">
      <div style="font-family:Cambria,Georgia,serif;font-size:14px;color:#2D2D2D;font-weight:600">${escapeHtml(item.label)}</div>
      <div style="font-family:Cambria,Georgia,serif;font-size:12px;color:#8B7E6E;margin-top:2px">${escapeHtml(item.source)} &middot; ${escapeHtml(dateLabel)}</div>
    </td></tr>`;
  }).join("");
  return `<tr><td style="padding:18px 0 6px 0">
    <div style="font-family:Cambria,Georgia,serif;font-size:11px;letter-spacing:0.12em;color:${color};font-weight:700;text-transform:uppercase;border-bottom:2px solid ${color};padding-bottom:6px">
      ${escapeHtml(title)} (${items.length})
    </div></td></tr>${rowHtml}`;
}

function renderEmail(digest) {
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
  const total = digest.overdue.length + digest.dueToday.length + digest.comingUp.length;

  const body = total === 0
    ? `<div style="font-family:Cambria,Georgia,serif;font-size:16px;color:#2D2D2D;padding:24px 0;text-align:center">
         Nothing due today, nothing overdue, nothing on the immediate horizon.<br><br>
         <span style="color:#8B7E6E;font-style:italic">Enjoy the quiet &mdash; or use it to move something forward.</span>
       </div>`
    : `<table cellpadding="0" cellspacing="0" width="100%">
         ${renderSection("Overdue", digest.overdue, "#DC1C2E")}
         ${renderSection("Due Today", digest.dueToday, "#B8651A")}
         ${renderSection(`Coming Up (Next ${COMING_UP_DAYS} Days)`, digest.comingUp, "#5D7A44")}
       </table>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Daily Pipeline</title></head>
    <body style="margin:0;padding:0;background:#F5F2ED;font-family:Cambria,Georgia,serif">
      <table cellpadding="0" cellspacing="0" width="100%" style="background:#F5F2ED;padding:32px 16px">
        <tr><td align="center">
          <table cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#FFFFFF;border:1px solid #E8E3D9">
            <tr><td style="padding:28px 32px 20px 32px;border-bottom:2px solid #DC1C2E">
              <div style="font-family:Cambria,Georgia,serif;font-size:11px;letter-spacing:0.16em;color:#DC1C2E;font-weight:700;text-transform:uppercase">${escapeHtml(TEAM_NAME)}</div>
              <div style="font-family:Cambria,Georgia,serif;font-size:28px;color:#2D2D2D;font-weight:700;margin-top:6px">Daily Pipeline</div>
              <div style="font-family:Cambria,Georgia,serif;font-size:14px;color:#8B7E6E;margin-top:4px">${escapeHtml(dateStr)}</div>
            </td></tr>
            <tr><td style="padding:20px 32px 8px 32px">${body}</td></tr>
            <tr><td style="padding:20px 32px 32px 32px;border-top:1px solid #EDEBE6;background:#FAF7F2">
              <div style="font-family:Cambria,Georgia,serif;font-size:12px;color:#8B7E6E;text-align:center;line-height:1.6">
                Sent automatically from your Pipeline app.<br>Open the app to review details and check things off.
              </div>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body></html>`;
}

// ─── Email send ────────────────────────────────────────────────────────
async function sendEmail(key, from, to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
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
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }
  return res.json();
}

// ─── Handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const emailTo = process.env.REMINDER_EMAIL_TO;
  const emailFrom = process.env.REMINDER_EMAIL_FROM || "Pipeline <onboarding@resend.dev>";

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: "Missing Supabase env vars" });
  }
  if (!resendKey) {
    return res.status(500).json({ error: "Missing RESEND_API_KEY" });
  }
  if (!emailTo) {
    return res.status(500).json({ error: "Missing REMINDER_EMAIL_TO" });
  }

  try {
    const results = await Promise.all([
      fetchTable(supabaseUrl, serviceRoleKey, "transactions"),
      fetchTable(supabaseUrl, serviceRoleKey, "todo_lists"),
      fetchTable(supabaseUrl, serviceRoleKey, "future_listings"),
      fetchTable(supabaseUrl, serviceRoleKey, "future_buyers"),
    ]);
    const rows = {
      transactions: results[0],
      todo_lists: results[1],
      future_listings: results[2],
      future_buyers: results[3],
    };
    const digest = buildDigest(rows);
    const html = renderEmail(digest);
    const total = digest.overdue.length + digest.dueToday.length + digest.comingUp.length;
    const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const subject = total === 0
      ? `Nothing due — ${today}`
      : `${digest.overdue.length} overdue, ${digest.dueToday.length} today — ${today}`;

    const result = await sendEmail(resendKey, emailFrom, emailTo, subject, html);
    return res.status(200).json({
      sent: true,
      id: result.id,
      counts: {
        overdue: digest.overdue.length,
        dueToday: digest.dueToday.length,
        comingUp: digest.comingUp.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
