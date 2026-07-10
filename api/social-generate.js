import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Plus, Home, Users, X, Calendar, Phone, Mail, MapPin, Building2,
  DollarSign, FileText, Trash2, Edit3, CheckCircle2, Circle, Briefcase,
  AlertCircle, ChevronRight, Search, TrendingUp, Clock, Package,
  Upload, Loader2, Download, Sparkles, AlertTriangle, UserCircle2,
  Landmark, Scale, PiggyBank, Percent, Bell, LogOut, Activity, Send,
  Menu
} from "lucide-react";
import {
  supabase, supabaseConfigured,
  signUp, signIn, signOut, resetPassword,
  getCurrentUser, onAuthChange,
  loadAll, upsert, remove,
  loadSettings, saveSettings,
  subscribeToTable,
} from "./supabase";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────
// Milestones with `informational: true` are date references, not tasks
// (no complete checkbox, no reminder — they just record when something happened).
// Milestones with `noDate: true` don't have a date field (used for tasks
// where the date can't be predicted, like Title Contingency).
// `hint` is optional helper text shown near the field.
const LISTING_PHASE_MILESTONES = [
  { id: "listDate",       label: "Listing Date",       informational: true },
  { id: "expirationDate", label: "Listing Expiration", informational: true },
];

const PENDING_PHASE_MILESTONES = [
  { id: "mutualAcceptance",     label: "Mutual Acceptance",     informational: true },
  { id: "earnestMoney",         label: "Earnest Money Deposit" },
  { id: "inspection",           label: "Inspection Contingency" },
  { id: "septicInspection",     label: "Septic Inspection" },
  { id: "wellInspection",       label: "Well Inspection" },
  { id: "inspectionResponse",   label: "Inspection Response", noDate: true,
    hint: "Can be submitted any time within the inspection contingency period" },
  { id: "titleReview",          label: "Title Contingency", noDate: true,
    hint: "5 days after receiving title commitment" },
  { id: "appraisal",            label: "Appraisal" },
  { id: "financingContingency", label: "Financing Contingency" },
  { id: "noticeToPerform",      label: "Notice to Perform" },
  { id: "finalWalkthrough",     label: "Final Walkthrough" },
  { id: "closing",              label: "Closing / COE" },
];

function milestonesForType(type) {
  return type === "listing"
    ? [...LISTING_PHASE_MILESTONES, ...PENDING_PHASE_MILESTONES]
    : PENDING_PHASE_MILESTONES;
}

const STATUS_OPTIONS = [
  { value: "active",        label: "Active",         color: "var(--accent)" },
  { value: "pending",       label: "Pending",        color: "#c9852b" },
  { value: "underContract", label: "Under Contract", color: "#7b9a5a" },
  { value: "closed",        label: "Closed",         color: "#6b6b6b" },
  { value: "fellThrough",   label: "Fell Through",   color: "#a94d4d" },
];

// ─── Stage helpers ─────────────────────────────────────────────────────────
// Transactions are bucketed into one of three stages based on their status.
// Used by the Active/Pending/Closed tabs.
function isClosedStage(txn) {
  return txn.status === "closed" || txn.status === "fellThrough";
}
function isPendingStage(txn) {
  return txn.status === "pending" || txn.status === "underContract";
}
function isActiveStage(txn) {
  // Anything that's not pending or closed counts as active.
  return !isPendingStage(txn) && !isClosedStage(txn);
}

const FINANCING_TYPES = ["Conventional", "FHA", "VA", "USDA", "Cash", "Other"];

// Fields that are ABSOLUTELY NEVER shared with clients via the portal.
// This is enforced at the data layer in Phase 2 so it cannot be bypassed by a UI bug.
const CLIENT_PORTAL_NEVER_SHARE = [
  "commission",
  "listingCommission",
  "buyingCommission",
  "notes",              // private notes (clientNotes is separate)
  "createdAt",
  "clientPortal",       // the portal config itself
];

const CONTACT_ROLES = [
  { key: "listingBroker", label: "Listing Broker",  icon: Briefcase },
  { key: "sellingBroker", label: "Selling Broker",  icon: Briefcase },
  { key: "escrow",        label: "Escrow Officer",  icon: Scale },
  { key: "lender",        label: "Lender",          icon: Landmark },
];

// Build a deduped directory of all contacts across all transactions.
// Used for autocomplete suggestions in the contact name fields — if you've
// already worked with "Brandon Nickel" at Fibre Federal once, typing "Brand"
// in the next transaction's lender section will offer to fill all his info.
function getContactDirectory(transactions) {
  const map = new Map(); // key: lowercase name; value: merged contact info
  for (const txn of transactions || []) {
    if (!txn || !txn.contacts) continue;
    for (const role of CONTACT_ROLES) {
      const c = txn.contacts[role.key];
      if (!c || !c.name || !c.name.trim()) continue;
      const key = c.name.trim().toLowerCase();
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          name: c.name.trim(),
          company: c.company || "",
          phone: c.phone || "",
          email: c.email || "",
          lastSeen: txn.updatedAt || txn.createdAt || "",
        });
      } else {
        // Merge — prefer non-empty fields from later entries
        if (!existing.company && c.company) existing.company = c.company;
        if (!existing.phone && c.phone) existing.phone = c.phone;
        if (!existing.email && c.email) existing.email = c.email;
      }
    }
  }
  // Return as array, sorted alphabetically by name
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

const STORAGE_KEY = "rea_transactions_v2";
const LEGACY_KEY  = "rea_transactions_v1";
const DEFAULT_REMINDER_DAYS = 5;

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────
const fmtMoney = (n) => {
  const num = parseFloat(n);
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(num);
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const fmtDateShort = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
};

const daysUntil = (iso) => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / (1000 * 60 * 60 * 24));
};

const formatLocalDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const addDays = (iso, days) => {
  if (!iso || days === null || days === undefined || days === "") return "";
  const n = parseInt(days, 10);
  if (isNaN(n)) return "";
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return formatLocalDate(d);
};

// ────────────────────────────────────────────────────────────────────────────
// Federal holiday + business day logic (real estate contract rules)
//
// Rule (matches WA NWMLS Form 21 and similar):
//   • Contract periods ≤ 5 days → business days only (skip Sat/Sun/federal holidays)
//   • Contract periods > 5 days → calendar days, but if deadline lands on a
//     weekend or holiday, push to the next business day.
// ────────────────────────────────────────────────────────────────────────────

// Returns nth occurrence of a weekday in a given month/year (1-indexed week).
// month: 1-12, weekday: 0=Sun..6=Sat
function nthWeekdayOfMonth(year, month, weekday, n) {
  const d = new Date(year, month - 1, 1);
  const offset = (weekday - d.getDay() + 7) % 7;
  d.setDate(1 + offset + (n - 1) * 7);
  return formatLocalDate(d);
}

function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(year, month, 0); // last day of month
  const offset = (d.getDay() - weekday + 7) % 7;
  d.setDate(d.getDate() - offset);
  return formatLocalDate(d);
}

// If a fixed-date holiday falls on a weekend, observed on nearest weekday
function observedHoliday(year, month, day) {
  const d = new Date(year, month - 1, day);
  if (d.getDay() === 6)      d.setDate(d.getDate() - 1); // Sat → Fri
  else if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  return formatLocalDate(d);
}

const _holidayCache = {};
function getFederalHolidays(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  const list = new Set([
    observedHoliday(year, 1, 1),         // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3),    // MLK Day (3rd Mon Jan)
    nthWeekdayOfMonth(year, 2, 1, 3),    // Presidents' Day (3rd Mon Feb)
    lastWeekdayOfMonth(year, 5, 1),      // Memorial Day (last Mon May)
    observedHoliday(year, 6, 19),        // Juneteenth
    observedHoliday(year, 7, 4),         // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1),    // Labor Day (1st Mon Sep)
    nthWeekdayOfMonth(year, 10, 1, 2),   // Columbus / Indigenous Peoples' Day
    observedHoliday(year, 11, 11),       // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4),   // Thanksgiving (4th Thu Nov)
    observedHoliday(year, 12, 25),       // Christmas
  ]);
  _holidayCache[year] = list;
  return list;
}

function isFederalHoliday(iso) {
  if (!iso) return false;
  const year = parseInt(iso.slice(0, 4), 10);
  return getFederalHolidays(year).has(iso);
}

function isBusinessDay(iso) {
  if (!iso) return false;
  const d = new Date(iso + "T00:00:00");
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !isFederalHoliday(iso);
}

function nextBusinessDay(iso) {
  let cur = iso;
  while (!isBusinessDay(cur)) cur = addDays(cur, 1);
  return cur;
}

// Main: compute a real-estate deadline from a base date + N days, applying the
// 5-day rule. Returns YYYY-MM-DD. baseDate is the contract reference date
// (e.g. mutual acceptance) — counting starts the day AFTER.
function computeDeadline(baseDate, daysParam) {
  if (!baseDate || daysParam === null || daysParam === undefined || daysParam === "") return "";
  const n = parseInt(daysParam, 10);
  if (isNaN(n)) return "";

  if (n <= 5) {
    // Business days only — skip Sat/Sun/federal holidays while counting
    let cur = baseDate;
    let counted = 0;
    while (counted < n) {
      cur = addDays(cur, 1);
      if (isBusinessDay(cur)) counted++;
    }
    return cur;
  } else {
    // Calendar days, then roll to next business day if deadline lands on
    // a weekend or federal holiday
    return nextBusinessDay(addDays(baseDate, n));
  }
}

const lastName = (s) => {
  if (!s) return "";
  // Handles "First Last", "First and Second Last", "Last, First"
  const trimmed = s.trim();
  if (trimmed.includes(",")) return trimmed.split(",")[0].trim();
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1];
};

const newId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ────────────────────────────────────────────────────────────────────────────
// Contract parsing (Anthropic API, runs inside Claude artifacts)
// Two flows: LISTING AGREEMENT (seller signs to list) and PURCHASE CONTRACT
// (buyer + seller signs to go pending).
// ────────────────────────────────────────────────────────────────────────────
const LISTING_AGREEMENT_PROMPT = `You are extracting information from a real estate LISTING AGREEMENT (the document a seller signs to list a property — not a purchase contract).

Return ONLY a valid JSON object — no markdown, no preamble. Use null for any field you cannot determine.

{
  "address": "Full street address of the subject property",
  "city": "",
  "state": "Two-letter state code",
  "zip": "",
  "sellerName": "Seller(s) full name; join multiple with 'and'",
  "sellerPhone": "",
  "sellerEmail": "",
  "listPrice": "Number only, no currency symbol or commas",
  "listDate": "YYYY-MM-DD; the listing start date",
  "expirationDate": "YYYY-MM-DD; when the listing agreement expires",
  "commissionPercent": "Total combined commission percentage if only one is given, e.g. 5",
  "listingCommissionPercent": "Listing side commission percentage as a number, e.g. 2.5",
  "buyingCommissionPercent": "Buying/selling side commission percentage as a number, e.g. 2.5",
  "listingBroker": { "name": "", "company": "", "phone": "", "email": "" },
  "includedItems": "Personal property included (appliances, fixtures), as a comma-separated string",
  "specialTerms": "Any special listing instructions, showing notes, or terms worth recording"
}

Be conservative — only fill a field with clear information from the listing agreement.`;

const PURCHASE_CONTRACT_PROMPT = `You are extracting information from a real estate PURCHASE CONTRACT (buyer + seller agreement).

Return ONLY a valid JSON object — no markdown, no code fences, no preamble. Use null for any field you cannot determine confidently.

{
  "address": "Full street address of the subject property",
  "city": "City",
  "state": "Two-letter state code",
  "zip": "ZIP",

  "sellerName": "Seller(s) full name. If multiple, join with 'and'.",
  "buyerName": "Buyer(s) full name. If multiple, join with 'and'.",

  "purchasePrice": "Number only, no currency symbol or commas",
  "earnestMoneyAmount": "Number only",
  "downPaymentAmount": "Number only",
  "closingCostsAmount": "Number only if specified (seller-paid or buyer-paid concessions)",
  "commissionPercent": "Total combined commission percentage if only one is given (e.g. 5)",
  "listingCommissionPercent": "Listing side commission percentage as a number, e.g. 2.5",
  "buyingCommissionPercent": "Buying/selling side commission percentage as a number, e.g. 2.5",
  "financingType": "One of: Conventional, FHA, VA, USDA, Cash, Other",

  "includedItems": "Personal property included (appliances, fixtures), as a single comma-separated string",

  "mutualAcceptanceDate": "YYYY-MM-DD; the date the contract was fully signed",
  "closingDate": "YYYY-MM-DD",
  "earnestMoneyDueDate": "YYYY-MM-DD if a specific date is given",
  "earnestMoneyDays": "Integer days from mutual acceptance, if a period is given instead of a date",
  "noticeToPerformDate": "YYYY-MM-DD if a specific date is given",
  "noticeToPerformDays": "Integer days from mutual acceptance if a period is given (e.g. '3 days after mutual acceptance')",

  "inspectionDate": "YYYY-MM-DD if a specific date is given for inspection contingency end",
  "inspectionDays": "Integer days from mutual acceptance for inspection contingency, if a period is given",
  "titleReviewDays": "Integer days for title review period",
  "appraisalDays": "Integer days for appraisal contingency",
  "financingContingencyDays": "Integer days for financing contingency",
  "finalWalkthroughDaysBeforeClose": "Integer days before closing for final walkthrough",

  "wellInspectionDate": "YYYY-MM-DD if a well inspection deadline is specified",
  "septicInspectionDate": "YYYY-MM-DD if a septic inspection deadline is specified",

  "listingBroker": { "name": "", "company": "", "phone": "", "email": "" },
  "sellingBroker": { "name": "", "company": "", "phone": "", "email": "" },
  "escrowOfficer": { "name": "", "company": "", "phone": "", "email": "" },
  "lender":        { "name": "", "company": "", "phone": "", "email": "" }
}

Be conservative: only fill a field with clear information from the contract.`;

async function parsePDF(file, prompt) {
  // For small PDFs (< 3 MB), send as base64 in the request body — fast, no extra round trip.
  // For larger PDFs, upload to Supabase Storage first and pass a signed URL,
  // which bypasses Vercel's 4.5 MB request body limit.
  const SMALL_FILE_LIMIT = 3 * 1024 * 1024;

  let body;
  let tempPath = null;

  if (file.size <= SMALL_FILE_LIMIT) {
    // ── Small file path: base64 in body
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const result = r.result;
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      r.onerror = () => reject(new Error("Could not read file"));
      r.readAsDataURL(file);
    });
    body = JSON.stringify({ pdfBase64: base64, prompt });
  } else {
    // ── Large file path: upload to Storage, send signed URL
    const user = await getCurrentUser();
    if (!user) {
      throw new Error("This PDF is too large (over 3 MB). Sign in to use cloud parsing for large files.");
    }
    tempPath = `${user.id}/_parse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from("documents")
      .upload(tempPath, file, { contentType: "application/pdf", upsert: true });
    if (uploadErr) throw new Error("Couldn't upload PDF for parsing: " + uploadErr.message);

    const { data: urlData, error: urlErr } = await supabase.storage
      .from("documents")
      .createSignedUrl(tempPath, 3600);
    if (urlErr) {
      try { await supabase.storage.from("documents").remove([tempPath]); } catch (e) {}
      throw new Error("Couldn't create signed URL: " + urlErr.message);
    }
    body = JSON.stringify({ pdfUrl: urlData.signedUrl, prompt });
  }

  try {
    // Calls our own serverless function at /api/parse-contract — the API key
    // lives on the server, never in the browser.
    const response = await fetch("/api/parse-contract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      let msg = `Parsing service unavailable (${response.status})`;
      try { const j = await response.json(); if (j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }

    const data = await response.json();
    const text = (data.content || []).map(b => b.text || "").join("").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("Couldn't read document — fill in manually.");
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch (e) { throw new Error("Document response wasn't valid JSON — fill in manually."); }
  } finally {
    // Always clean up the temp upload, success or failure
    if (tempPath) {
      try { await supabase.storage.from("documents").remove([tempPath]); }
      catch (e) { /* ignore cleanup failures */ }
    }
  }
}

const parseListingAgreement = (file) => parsePDF(file, LISTING_AGREEMENT_PROMPT);
const parsePurchaseContract  = (file) => parsePDF(file, PURCHASE_CONTRACT_PROMPT);

function applyListingAgreement(form, x) {
  const merged = JSON.parse(JSON.stringify(form));

  if (x.address) merged.address = x.address;
  if (x.city)    merged.city = x.city;
  if (x.state)   merged.state = x.state;
  if (x.zip)     merged.zip = x.zip;

  if (x.sellerName)  merged.sellerName  = x.sellerName;
  if (x.sellerPhone) merged.sellerPhone = x.sellerPhone;
  if (x.sellerEmail) merged.sellerEmail = x.sellerEmail;

  if (x.listPrice) merged.listPrice = String(x.listPrice);
  // Also seed the purchase-price field with list price as a starting value
  if (x.listPrice && !merged.price) merged.price = String(x.listPrice);
  if (x.commissionPercent != null) merged.commission = String(x.commissionPercent);
  if (x.listingCommissionPercent != null) merged.listingCommission = String(x.listingCommissionPercent);
  if (x.buyingCommissionPercent != null) merged.buyingCommission = String(x.buyingCommissionPercent);

  if (x.includedItems) merged.includedItems = x.includedItems;
  if (x.specialTerms)  merged.notes = merged.notes
    ? `${merged.notes}\n\nListing terms: ${x.specialTerms}`
    : `Listing terms: ${x.specialTerms}`;

  // Listing milestones
  const setMilestone = (id, date) => {
    if (!date) return;
    const m = merged.milestones.find(m => m.id === id);
    if (m) m.date = date;
  };
  setMilestone("listDate", x.listDate);
  setMilestone("expirationDate", x.expirationDate);

  // Listing broker contact
  if (x.listingBroker) {
    const lb = merged.contacts.listingBroker;
    if (x.listingBroker.name)    lb.name = x.listingBroker.name;
    if (x.listingBroker.company) lb.company = x.listingBroker.company;
    if (x.listingBroker.phone)   lb.phone = x.listingBroker.phone;
    if (x.listingBroker.email)   lb.email = x.listingBroker.email;
  }

  return merged;
}

function applyPurchaseContract(form, x) {
  const merged = JSON.parse(JSON.stringify(form));

  if (x.address) merged.address = x.address;
  if (x.city) merged.city = x.city;
  if (x.state) merged.state = x.state;
  if (x.zip) merged.zip = x.zip;

  if (x.sellerName) merged.sellerName = x.sellerName;
  if (x.buyerName)  merged.buyerName  = x.buyerName;

  if (x.purchasePrice)      merged.price = String(x.purchasePrice);
  if (x.earnestMoneyAmount) merged.earnestMoney = String(x.earnestMoneyAmount);
  if (x.downPaymentAmount)  merged.downPayment = String(x.downPaymentAmount);
  if (x.closingCostsAmount) merged.closingCosts = String(x.closingCostsAmount);
  if (x.commissionPercent != null) merged.commission = String(x.commissionPercent);
  if (x.listingCommissionPercent != null) merged.listingCommission = String(x.listingCommissionPercent);
  if (x.buyingCommissionPercent != null) merged.buyingCommission = String(x.buyingCommissionPercent);
  if (x.financingType)      merged.financing = x.financingType;
  if (x.includedItems)      merged.includedItems = x.includedItems;

  if (x.mutualAcceptanceDate) merged.contractDate = x.mutualAcceptanceDate;
  if (x.closingDate)          merged.closingDate  = x.closingDate;

  // Contacts
  const copyContact = (src, dst) => {
    if (!src) return;
    if (src.name)    merged.contacts[dst].name    = src.name;
    if (src.company) merged.contacts[dst].company = src.company;
    if (src.phone)   merged.contacts[dst].phone   = src.phone;
    if (src.email)   merged.contacts[dst].email   = src.email;
  };
  copyContact(x.listingBroker, "listingBroker");
  copyContact(x.sellingBroker, "sellingBroker");
  copyContact(x.escrowOfficer, "escrow");
  copyContact(x.lender,        "lender");

  // Milestones
  const setMilestone = (id, date) => {
    if (!date) return;
    const m = merged.milestones.find(x => x.id === id);
    if (m) m.date = date;
  };
  const base = x.mutualAcceptanceDate;
  const close = x.closingDate;

  setMilestone("mutualAcceptance", base);
  setMilestone("closing", close);

  if (x.earnestMoneyDueDate) setMilestone("earnestMoney", x.earnestMoneyDueDate);
  else if (base && x.earnestMoneyDays != null) setMilestone("earnestMoney", computeDeadline(base, x.earnestMoneyDays));

  if (x.inspectionDate) setMilestone("inspection", x.inspectionDate);
  else if (base && x.inspectionDays != null) setMilestone("inspection", computeDeadline(base, x.inspectionDays));

  // Inspection Response has no fixed date (can happen any time within
  // the inspection contingency), so we don't compute or store one.
  if (base && x.titleReviewDays != null)        setMilestone("titleReview", computeDeadline(base, x.titleReviewDays));
  if (base && x.appraisalDays != null)          setMilestone("appraisal", computeDeadline(base, x.appraisalDays));
  if (base && x.financingContingencyDays != null) setMilestone("financingContingency", computeDeadline(base, x.financingContingencyDays));

  if (x.noticeToPerformDate) setMilestone("noticeToPerform", x.noticeToPerformDate);
  else if (base && x.noticeToPerformDays != null) setMilestone("noticeToPerform", computeDeadline(base, x.noticeToPerformDays));

  if (close) {
    const wt = x.finalWalkthroughDaysBeforeClose;
    // Walkthrough is BEFORE close — use plain calendar days backward, then roll
    // backward to keep it before closing if it lands on weekend/holiday.
    let walkthrough = addDays(close, -(wt != null ? wt : 1));
    while (walkthrough && !isBusinessDay(walkthrough)) {
      walkthrough = addDays(walkthrough, -1);
    }
    setMilestone("finalWalkthrough", walkthrough);
  }

  // Set standard septic/well inspection milestones if the AI found them.
  // These are now part of the default timeline, so no need to add as custom.
  if (x.wellInspectionDate)   setMilestone("wellInspection", x.wellInspectionDate);
  if (x.septicInspectionDate) setMilestone("septicInspection", x.septicInspectionDate);

  // Going from listing → pending: bump status if we just got a purchase contract
  // and the deal was previously just an active listing.
  if (merged.status === "active" && (x.mutualAcceptanceDate || x.purchasePrice)) {
    merged.status = "pending";
  }

  return merged;
}

// ────────────────────────────────────────────────────────────────────────────
// .ics Calendar export (universal — Google/Apple/Outlook all support import)
// ────────────────────────────────────────────────────────────────────────────
function generateICS(txn) {
  const esc = (s) => String(s)
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
  const dateFmt = (iso) => iso.replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";

  const contactsLine = CONTACT_ROLES
    .map(r => {
      const c = txn.contacts?.[r.key];
      if (!c || !c.name) return null;
      return `${r.label}: ${c.name}${c.phone ? ` (${c.phone})` : ""}`;
    })
    .filter(Boolean)
    .join("\\n");

  const baseDesc = [
    `Seller: ${txn.sellerName || "—"}`,
    `Buyer: ${txn.buyerName || "—"}`,
    `Price: ${fmtMoney(txn.price)}`,
    txn.financing ? `Financing: ${txn.financing}` : null,
    contactsLine ? `\\n${contactsLine}` : null,
  ].filter(Boolean).join("\\n");

  const events = [];
  txn.milestones.forEach(m => {
    if (!m.date) return;
    const dt = dateFmt(m.date);
    const endDt = dateFmt(addDays(m.date, 1));
    const summary = `${m.label} — ${txn.address || "Property"}`;
    const desc = m.notes
      ? `${m.notes}\\n\\n${baseDesc}`
      : baseDesc;
    const lead = m.reminderDays != null && m.reminderDays !== ""
      ? parseInt(m.reminderDays, 10)
      : DEFAULT_REMINDER_DAYS;
    const eventLines = [
      "BEGIN:VEVENT",
      `UID:${txn.id}-${m.id}@pipeline`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dt}`,
      `DTEND;VALUE=DATE:${endDt}`,
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(desc)}`,
    ];
    if (!isNaN(lead) && lead > 0) {
      eventLines.push(
        "BEGIN:VALARM",
        `TRIGGER:-P${lead}D`,
        "ACTION:DISPLAY",
        `DESCRIPTION:${esc(m.label + " in " + lead + " day" + (lead === 1 ? "" : "s"))}`,
        "END:VALARM",
      );
    }
    eventLines.push(
      "BEGIN:VALARM",
      "TRIGGER:-PT2H",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(m.label + " in 2 hours")}`,
      "END:VALARM",
      "END:VEVENT",
    );
    events.push(eventLines.join("\r\n"));
  });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Pipeline//Transaction Manager//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

function downloadICS(txn) {
  const ics = generateICS(txn);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (txn.address || "transaction").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 60);
  a.download = `${safeName || "transaction"}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ────────────────────────────────────────────────────────────────────────────
// Factory + Migration
// ────────────────────────────────────────────────────────────────────────────
function newTransaction(type) {
  return {
    id: `txn_${newId()}`,
    type,
    status: "active",
    address: "", city: "", state: "", zip: "",
    sellerName: "", sellerEmail: "", sellerPhone: "",
    buyerName: "",  buyerEmail: "",  buyerPhone: "",
    listPrice: "", price: "", earnestMoney: "", downPayment: "", closingCosts: "",
    commission: "", listingCommission: "", buyingCommission: "",
    financing: "",
    includedItems: "",
    contractDate: "", closingDate: "",
    milestones: milestonesForType(type).map(m => ({
      id: m.id, label: m.label, date: "", complete: false, notes: "",
      custom: false, reminderDays: DEFAULT_REMINDER_DAYS,
      informational: !!m.informational,
      noDate: !!m.noDate,
      hint: m.hint || "",
    })),
    contacts: {
      listingBroker: { name: "", company: "", phone: "", email: "" },
      sellingBroker: { name: "", company: "", phone: "", email: "" },
      escrow:        { name: "", company: "", phone: "", email: "" },
      lender:        { name: "", company: "", phone: "", email: "" },
    },
    prelistChecklist: [],
    closingChecklist: [],
    documents: [],  // metadata only: { id, name, type, size, addedAt }
    clientPortal: { enabled: false, clients: [], visibleMilestones: [], clientNotes: "", showFinancials: true },
    notes: "",
    createdAt: new Date().toISOString(),
  };
}

// Migrate v1 transactions to v2 schema
function migrateV1(old) {
  const t = newTransaction(old.type || "listing");
  t.id = old.id || t.id;
  t.status = old.status || "active";
  t.address = old.address || "";
  t.city = old.city || ""; t.state = old.state || ""; t.zip = old.zip || "";
  t.price = old.price || "";
  t.contractDate = old.contractDate || "";
  t.listDate = old.listDate || "";
  t.notes = old.notes || "";
  // Old "clientName" maps to whichever party the agent represented
  if (old.type === "listing") {
    t.sellerName = old.clientName || ""; t.sellerEmail = old.clientEmail || ""; t.sellerPhone = old.clientPhone || "";
  } else {
    t.buyerName  = old.clientName || ""; t.buyerEmail  = old.clientEmail || ""; t.buyerPhone  = old.clientPhone || "";
  }
  // Map old milestones object → new array
  if (old.milestones) {
    Object.entries(old.milestones).forEach(([k, v]) => {
      const m = t.milestones.find(x => x.id === k);
      if (m && v) { m.date = v.date || ""; m.complete = !!v.complete; }
    });
    if (old.milestones.closing) {
      const m = t.milestones.find(x => x.id === "closing");
      if (m) t.closingDate = m.date;
    }
  }
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers used by the cloud loader
// ────────────────────────────────────────────────────────────────────────────

// Ensures a transaction has the full current schema even if it was created
// before some field was added. Smart-merges milestones so old data picks up
// newly-added standard milestones without losing user customizations.
function ensureTxnSchema(t) {
  const base = newTransaction(t.type || "listing");
  const existingMilestones = t.milestones || [];

  // Build the standard milestone list, merging existing data by id.
  // If a NEW standard milestone (like septic/well) has a matching custom
  // one by label (from a prior AI parse), copy that custom's data over
  // and mark the custom for removal.
  const customIdsToRemove = new Set();
  const baseStandards = base.milestones.map(bm => {
    const byId = existingMilestones.find(em => em.id === bm.id);
    if (byId) {
      return { ...bm, ...byId, reminderDays: byId.reminderDays ?? DEFAULT_REMINDER_DAYS };
    }
    // Try to find a legacy custom milestone matching by label
    const byLabel = existingMilestones.find(em => em.custom && em.label.toLowerCase() === bm.label.toLowerCase());
    if (byLabel) {
      customIdsToRemove.add(byLabel.id);
      return { ...bm, date: byLabel.date || "", complete: !!byLabel.complete, notes: byLabel.notes || "", reminderDays: byLabel.reminderDays ?? DEFAULT_REMINDER_DAYS };
    }
    return bm;
  });
  const customs = existingMilestones
    .filter(em => em.custom && !customIdsToRemove.has(em.id))
    .map(em => ({ ...em, reminderDays: em.reminderDays ?? DEFAULT_REMINDER_DAYS }));
  if (t.listDate) {
    const listMs = baseStandards.find(m => m.id === "listDate");
    if (listMs && !listMs.date) listMs.date = t.listDate;
  }
  return {
    ...base,
    ...t,
    milestones: [...baseStandards, ...customs],
    contacts: { ...base.contacts, ...(t.contacts || {}) },
  };
}

// Reloads a table from Supabase — used by realtime subscriptions
async function reloadTable(tableName, setter, applyEnsure) {
  try {
    const data = await loadAll(tableName);
    setter(applyEnsure ? data.map(ensureTxnSchema) : data);
  } catch (e) {
    console.error("Realtime reload failed:", e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN — sign in / sign up / password reset
// ════════════════════════════════════════════════════════════════════════════
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup" | "reset"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const submit = async (e) => {
    e?.preventDefault();
    setError(""); setMessage("");
    if (!email.trim()) { setError("Email is required."); return; }
    if (mode !== "reset" && !password) { setError("Password is required."); return; }
    if (mode === "signup" && password.length < 8) { setError("Password must be at least 8 characters."); return; }

    setWorking(true);
    try {
      if (mode === "signin") {
        const { user } = await signIn(email.trim(), password);
        onAuthed(user);
      } else if (mode === "signup") {
        const { user } = await signUp(email.trim(), password);
        if (user) {
          setMessage("Account created! Check your email to confirm, then sign in.");
          setMode("signin");
        } else {
          setMessage("Check your email for a confirmation link.");
        }
      } else if (mode === "reset") {
        await resetPassword(email.trim());
        setMessage("If that email exists, a reset link has been sent.");
        setMode("signin");
      }
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div style={styles.app}><Style />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 420, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ ...styles.eyebrow, marginBottom: 8 }}>The Jesse Cope Team</div>
            <h1 style={{ ...styles.title, fontSize: 36 }}>Pipeline</h1>
          </div>
          <form onSubmit={submit} style={{ background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 14, padding: 28 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500, marginBottom: 6 }}>
              {mode === "signin" && "Sign in"}
              {mode === "signup" && "Create account"}
              {mode === "reset" && "Reset password"}
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 20 }}>
              {mode === "signin" && "Welcome back."}
              {mode === "signup" && "Create the one shared team account."}
              {mode === "reset" && "Enter your email — we'll send a reset link."}
            </div>

            {error && (
              <div style={{ padding: "10px 14px", background: "rgba(196, 96, 47, 0.1)", border: "1px solid var(--accent-soft)", borderRadius: 8, color: "var(--accent)", fontSize: 13, marginBottom: 16 }}>
                {error}
              </div>
            )}
            {message && (
              <div style={{ padding: "10px 14px", background: "rgba(123, 154, 90, 0.1)", border: "1px solid rgba(123, 154, 90, 0.3)", borderRadius: 8, color: "#5a7a3a", fontSize: 13, marginBottom: 16 }}>
                {message}
              </div>
            )}

            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                style={styles.input} autoComplete="email" autoFocus />
            </Field>

            {mode !== "reset" && (
              <Field label="Password">
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  style={styles.input}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"} />
              </Field>
            )}

            <button type="submit" disabled={working}
              style={{ ...styles.btn, ...styles.btnPrimary, width: "100%", padding: "12px", marginTop: 16, opacity: working ? 0.6 : 1, justifyContent: "center" }}>
              {working ? <Loader2 size={16} className="spin" /> : null}
              {mode === "signin" && "Sign in"}
              {mode === "signup" && "Create account"}
              {mode === "reset" && "Send reset link"}
            </button>

            <div style={{ marginTop: 20, fontSize: 12, color: "var(--ink-soft)", textAlign: "center", display: "flex", flexDirection: "column", gap: 6 }}>
              {mode === "signin" && (
                <>
                  <button type="button" onClick={() => { setMode("signup"); setError(""); setMessage(""); }}
                    style={{ background: "transparent", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: 12 }}>
                    Need an account? Create one
                  </button>
                  <button type="button" onClick={() => { setMode("reset"); setError(""); setMessage(""); }}
                    style={{ background: "transparent", border: "none", color: "var(--ink-soft)", cursor: "pointer", padding: 0, fontSize: 12, textDecoration: "underline" }}>
                    Forgot password
                  </button>
                </>
              )}
              {(mode === "signup" || mode === "reset") && (
                <button type="button" onClick={() => { setMode("signin"); setError(""); setMessage(""); }}
                  style={{ background: "transparent", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: 12 }}>
                  Back to sign in
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MIGRATION MODAL — one-click upload of local data to the cloud
// ════════════════════════════════════════════════════════════════════════════
function MigrationModal({ onClose, onComplete }) {
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [counts, setCounts] = useState({ txns: 0, fl: 0, fb: 0, vds: 0 });

  // Count local data on mount
  useEffect(() => {
    const c = { txns: 0, fl: 0, fb: 0, vds: 0 };
    try { const v = localStorage.getItem(STORAGE_KEY); if (v) c.txns = JSON.parse(v).length; } catch (e) {}
    try { const v = localStorage.getItem(FUTURE_LISTINGS_KEY); if (v) c.fl = JSON.parse(v).length; } catch (e) {}
    try { const v = localStorage.getItem(FUTURE_BUYERS_KEY); if (v) c.fb = JSON.parse(v).length; } catch (e) {}
    try { const v = localStorage.getItem(VENDORS_KEY); if (v) c.vds = JSON.parse(v).length; } catch (e) {}
    setCounts(c);
  }, []);

  const totalCount = counts.txns + counts.fl + counts.fb + counts.vds;

  const migrate = async () => {
    setWorking(true); setError("");
    try {
      // Transactions
      const txns = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch (e) { return []; } })();
      for (let i = 0; i < txns.length; i++) {
        setProgress(`Uploading transaction ${i + 1} of ${txns.length}…`);
        await upsert("transactions", txns[i]);
      }
      const fls = (() => { try { return JSON.parse(localStorage.getItem(FUTURE_LISTINGS_KEY) || "[]"); } catch (e) { return []; } })();
      for (let i = 0; i < fls.length; i++) {
        setProgress(`Uploading future listing ${i + 1} of ${fls.length}…`);
        await upsert("future_listings", fls[i]);
      }
      const fbs = (() => { try { return JSON.parse(localStorage.getItem(FUTURE_BUYERS_KEY) || "[]"); } catch (e) { return []; } })();
      for (let i = 0; i < fbs.length; i++) {
        setProgress(`Uploading future buyer ${i + 1} of ${fbs.length}…`);
        await upsert("future_buyers", fbs[i]);
      }
      const vds = (() => { try { return JSON.parse(localStorage.getItem(VENDORS_KEY) || "[]"); } catch (e) { return []; } })();
      for (let i = 0; i < vds.length; i++) {
        setProgress(`Uploading vendor ${i + 1} of ${vds.length}…`);
        await upsert("vendors", vds[i]);
      }
      setProgress("Done!");
      setDone(true);
      onComplete();
    } catch (e) {
      setError("Migration failed: " + e.message + ". Your local data is still safe — try again.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div style={styles.modalBackdrop} onClick={!working ? onClose : undefined}>
      <div style={{ ...styles.modal, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Cloud Migration</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--ink)" }}>Move local data to cloud</div>
          </div>
          {!working && <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>}
        </div>
        <div style={styles.modalBody}>
          {totalCount === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--ink-soft)" }}>
              No local data to migrate.
            </div>
          ) : !done ? (
            <>
              <p style={{ fontSize: 14, color: "var(--ink)", lineHeight: 1.6, marginBottom: 16 }}>
                You have data saved locally on this device. Click below to upload it to the cloud.
                Your local copy will stay intact as a backup.
              </p>
              <div style={{ background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 }}>What will be migrated</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 13 }}>
                  <div>Transactions: <strong>{counts.txns}</strong></div>
                  <div>Future Listings: <strong>{counts.fl}</strong></div>
                  <div>Future Buyers: <strong>{counts.fb}</strong></div>
                  <div>Vendors: <strong>{counts.vds}</strong></div>
                </div>
              </div>
              {error && (
                <div style={{ padding: "10px 14px", background: "rgba(196, 96, 47, 0.1)", border: "1px solid var(--accent-soft)", borderRadius: 8, color: "var(--accent)", fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}
              {working && (
                <div style={{ padding: "10px 14px", background: "rgba(196, 96, 47, 0.05)", borderRadius: 8, fontSize: 13, color: "var(--ink-soft)", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
                  <Loader2 size={14} className="spin" /> {progress}
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: 20, textAlign: "center" }}>
              <CheckCircle2 size={48} style={{ color: "var(--accent)", marginBottom: 12 }} />
              <div style={{ fontFamily: "var(--font-display)", fontSize: 22, marginBottom: 6 }}>Migration complete</div>
              <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                Your data is now in the cloud and will sync across devices.
                Your local copy is still safe as a backup.
              </p>
            </div>
          )}
        </div>
        <div style={styles.modalFooter}>
          <div style={{ flex: 1 }} />
          {totalCount > 0 && !done && (
            <button onClick={migrate} disabled={working}
              style={{ ...styles.btn, ...styles.btnPrimary, opacity: working ? 0.6 : 1 }}>
              {working ? <><Loader2 size={14} className="spin" /> Migrating…</> : <><Upload size={14} /> Migrate {totalCount} items</>}
            </button>
          )}
          {(done || totalCount === 0) && (
            <button onClick={onClose} style={{ ...styles.btn, ...styles.btnPrimary }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);

  // ── Portal route detection ──────────────────────────────────────────────
  // If the URL is /portal/{token} (path-based, requires SPA rewrites in
  // Vercel) OR /#/portal/{token} (hash-based, works everywhere without
  // server config), render the public ClientPortalView instead of the
  // broker app. Hash-based is the more reliable form because hashes
  // never reach the server.
  const portalToken = useMemo(() => {
    if (typeof window === "undefined") return null;
    const path = window.location.pathname;
    const hash = window.location.hash || "";
    const pathMatch = path.match(/^\/portal\/([A-Za-z0-9_-]+)\/?$/);
    if (pathMatch) return pathMatch[1];
    const hashMatch = hash.match(/^#\/portal\/([A-Za-z0-9_-]+)\/?$/);
    if (hashMatch) return hashMatch[1];
    return null;
  }, []);
  if (portalToken) {
    return <ClientPortalView token={portalToken} />;
  }

  useEffect(() => {
    if (!supabaseConfigured) {
      // Local-only mode (no Supabase env vars set yet)
      setAuthChecking(false);
      return;
    }
    (async () => {
      const u = await getCurrentUser();
      setUser(u);
      setAuthChecking(false);
    })();
    const unsub = onAuthChange((session) => {
      setUser(session?.user || null);
    });
    return unsub;
  }, []);

  if (authChecking) {
    return (
      <div style={styles.app}><Style />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "var(--ink-soft)" }}>
            Loading…
          </div>
        </div>
      </div>
    );
  }

  // If Supabase is configured but user isn't signed in, show login.
  if (supabaseConfigured && !user) {
    return <AuthScreen onAuthed={(u) => setUser(u)} />;
  }

  return <MainApp user={user} />;
}

function MainApp({ user }) {
  const [transactions, setTransactions] = useState([]);
  const [futureListings, setFutureListings] = useState([]);
  const [futureBuyers, setFutureBuyers] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [todoLists, setTodoLists] = useState([]);
  // appSettings holds user-level config (notes, calendar events, links,
  // habits, layout, templates) — stored as one JSON blob in user_settings
  // and consulted only in cloud mode. In local mode each widget falls back
  // to its localStorage key.
  const [appSettings, setAppSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("home");
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);

  // Mobile menu state — replaces the horizontal tab bar with a hamburger
  // drawer on phone-sized screens (< 768px wide).
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth < 768
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(null);
  const [showMigration, setShowMigration] = useState(false);
  const [syncStatus, setSyncStatus] = useState("idle"); // "idle" | "syncing" | "error"

  const isCloud = supabaseConfigured && !!user;

  // Cmd+K / Ctrl+K opens global search
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowGlobalSearch(true);
      }
      if (e.key === "Escape") {
        setShowGlobalSearch(false);
        setShowQuickAdd(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Load data — from Supabase if signed in, otherwise from localStorage
  useEffect(() => {
    (async () => {
      try {
        if (isCloud) {
          // ── Cloud mode: load everything from Supabase in parallel
          const [txns, fl, fb, vds, tl, st] = await Promise.all([
            loadAll("transactions"),
            loadAll("future_listings"),
            loadAll("future_buyers"),
            loadAll("vendors"),
            loadAll("todo_lists"),
            loadSettings(),
          ]);
          const ensured = txns.map(t => ensureTxnSchema(t));
          setTransactions(ensured);
          setFutureListings(fl);
          setFutureBuyers(fb);
          setVendors(vds);
          setTodoLists(tl);
          setAppSettings(st || {});
        } else {
          // ── Local mode: original localStorage path
          let raw = null;
          try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) raw = JSON.parse(stored);
          } catch (e) { /* no v2 data */ }

          if (!raw) {
            try {
              const old = localStorage.getItem(LEGACY_KEY);
              if (old) {
                const oldData = JSON.parse(old);
                raw = oldData.map(migrateV1);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
              }
            } catch (e) { /* no v1 data either */ }
          }

          if (raw) {
            const ensured = raw.map(t => ensureTxnSchema(t));
            setTransactions(ensured);
          }
        }
      } catch (e) {
        console.error("Load failed:", e);
        alert("Couldn't load your data. " + (e.message || ""));
      } finally {
        setLoading(false);
      }
    })();
  }, [isCloud]);

  // Realtime subscriptions — keep state in sync if data changes from another device
  useEffect(() => {
    if (!isCloud) return;
    const handlers = [
      subscribeToTable("transactions", () => reloadTable("transactions", setTransactions, true)),
      subscribeToTable("future_listings", () => reloadTable("future_listings", setFutureListings, false)),
      subscribeToTable("future_buyers", () => reloadTable("future_buyers", setFutureBuyers, false)),
      subscribeToTable("vendors", () => reloadTable("vendors", setVendors, false)),
      subscribeToTable("todo_lists", () => reloadTable("todo_lists", setTodoLists, false)),
      // user_settings is a single-row table per user — just reload on any change
      subscribeToTable("user_settings", async () => {
        try { const fresh = await loadSettings(); setAppSettings(fresh || {}); }
        catch (e) { console.error("Reload settings failed:", e); }
      }),
    ];
    return () => handlers.forEach(unsub => unsub && unsub());
  }, [isCloud]);

  // Persist — cloud upsert or localStorage write
  const persist = async (next) => {
    setTransactions(next);
    if (!isCloud) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
      catch (e) { console.error("Save failed:", e); }
    }
  };

  // Update a single setting key in cloud mode. Optimistically updates local
  // state, then writes the full merged settings blob to Supabase. In local
  // mode this is a no-op — widgets manage their own localStorage.
  const updateSetting = async (key, value) => {
    const next = { ...appSettings, [key]: value };
    setAppSettings(next);
    if (isCloud) {
      try { await saveSettings(next); }
      catch (e) { console.error(`Save setting ${key} failed:`, e); }
    }
  };

  // Mirror cloud settings to localStorage so synchronous loaders elsewhere
  // (loadPrelistTemplates, loadClosingTemplate, etc.) still work without
  // having to be refactored to async.
  useEffect(() => {
    if (!isCloud || !appSettings) return;
    try {
      if (appSettings.prelist_templates) {
        localStorage.setItem(PRELIST_TEMPLATES_KEY, JSON.stringify(appSettings.prelist_templates));
      }
      if (appSettings.closing_template) {
        localStorage.setItem(CLOSING_TEMPLATE_KEY, JSON.stringify(appSettings.closing_template));
      }
    } catch (e) {}
  }, [isCloud, appSettings]);

  const handleSave = async (txn) => {
    // Auto-apply closing template when status changes to closed and checklist is empty
    let finalTxn = txn;
    if (txn.status === "closed" && (!txn.closingChecklist || txn.closingChecklist.length === 0)) {
      const template = loadClosingTemplate();
      finalTxn = {
        ...txn,
        closingChecklist: template.items.map(text => ({ id: newId(), text, done: false })),
      };
    }

    if (isCloud) {
      try {
        setSyncStatus("syncing");
        const saved = await upsert("transactions", finalTxn);
        const exists = transactions.find(t => t.id === finalTxn.id);
        const next = exists
          ? transactions.map(t => t.id === finalTxn.id ? saved : t)
          : [...transactions, saved];
        setTransactions(next);
        setSyncStatus("idle");
        setEditing(null);
        if (detail && detail.id === finalTxn.id) setDetail(saved);
      } catch (e) {
        setSyncStatus("error");
        alert("Save failed: " + e.message);
      }
    } else {
      const exists = transactions.find(t => t.id === finalTxn.id);
      const next = exists
        ? transactions.map(t => t.id === finalTxn.id ? finalTxn : t)
        : [...transactions, finalTxn];
      persist(next);
      setEditing(null);
      if (detail && detail.id === finalTxn.id) setDetail(finalTxn);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this transaction? This cannot be undone.")) return;
    if (isCloud) {
      try {
        setSyncStatus("syncing");
        await remove("transactions", id);
        setTransactions(transactions.filter(t => t.id !== id));
        setSyncStatus("idle");
      } catch (e) {
        setSyncStatus("error");
        alert("Delete failed: " + e.message);
        return;
      }
    } else {
      persist(transactions.filter(t => t.id !== id));
    }
    setDetail(null); setEditing(null);
  };

  const filtered = useMemo(() => {
    let list = transactions;
    if (view === "listings") list = list.filter(t => isActiveStage(t));
    if (view === "buyers")   list = list.filter(t => isPendingStage(t));
    if (view === "closed")   list = list.filter(t => isClosedStage(t));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        (t.address || "").toLowerCase().includes(q) ||
        (t.sellerName || "").toLowerCase().includes(q) ||
        (t.buyerName  || "").toLowerCase().includes(q) ||
        (t.city || "").toLowerCase().includes(q)
      );
    }
    // Sort alphabetically by address for the transaction tabs
    if (view === "listings" || view === "buyers" || view === "closed") {
      list = list.slice().sort((a, b) => (a.address || "").localeCompare(b.address || ""));
    }
    return list;
  }, [transactions, view, search]);

  const stats = useMemo(() => {
    const active = transactions.filter(t => t.status !== "closed" && t.status !== "fellThrough");
    const listings = active.filter(t => t.type === "listing");
    const buyers   = active.filter(t => t.type === "buyer");
    const totalVolume = active.reduce((s, t) => s + (parseFloat(t.price) || 0), 0);
    const estCommission = active.reduce((s, t) => {
      const price = parseFloat(t.price) || 0;
      // Use the appropriate side based on which side this agent is on.
      // Falls back to legacy single `commission` field for older data.
      const sideField = t.type === "listing" ? t.listingCommission : t.buyingCommission;
      const pct = parseFloat(sideField || t.commission) || 0;
      return s + (price * pct / 100);
    }, 0);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const upcoming = [];
    active.forEach(t => {
      t.milestones.forEach(m => {
        if (m.date && !m.complete) {
          const days = daysUntil(m.date);
          if (days !== null && days >= -3 && days <= 30) {
            upcoming.push({ txn: t, milestone: m, days });
          }
        }
      });
    });
    upcoming.sort((a, b) => a.days - b.days);
    return { active: active.length, listings: listings.length, buyers: buyers.length, totalVolume, estCommission, upcoming };
  }, [transactions]);

  if (loading) {
    return (
      <div style={styles.app}><Style />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "var(--ink-soft)" }}>
            Loading your transactions…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <Style />
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div>
            <div style={styles.eyebrow}>The Jesse Cope Team</div>
            <h1 style={styles.title}>Home Base</h1>
          </div>
          <div style={styles.headerActions}>
            {isCloud && (
              <>
                <div style={{ fontSize: 11, color: "var(--ink-soft)", display: "flex", alignItems: "center", gap: 6, marginRight: 6 }} title={user.email}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: syncStatus === "error" ? "#c0392b" : syncStatus === "syncing" ? "#e67e22" : "#7b9a5a" }} />
                  {syncStatus === "syncing" ? "Syncing…" : syncStatus === "error" ? "Sync error" : "Synced"}
                </div>
                <button onClick={() => setShowMigration(true)} style={{ ...styles.btn, ...styles.btnGhost, padding: "8px 12px", fontSize: 12 }} title="Migrate local data to cloud">
                  <Upload size={12} /> Migrate
                </button>
                <button onClick={async () => { if (confirm("Sign out?")) { await signOut(); window.location.reload(); } }}
                  style={{ ...styles.btn, ...styles.btnGhost, padding: "8px 12px", fontSize: 12 }} title="Sign out">
                  <LogOut size={12} />
                </button>
              </>
            )}
            <button onClick={() => setShowTemplateEditor("prelist")} style={{ ...styles.btn, ...styles.btnGhost, padding: "8px 12px", fontSize: 12 }} title="Edit pre-listing checklist templates">
              📋 Templates
            </button>
            <button onClick={() => setEditing(newTransaction("listing"))} style={{ ...styles.btn, ...styles.btnGhost }}>
              <Plus size={14} /> New Listing
            </button>
            <button onClick={() => setEditing(newTransaction("buyer"))} style={{ ...styles.btn, ...styles.btnPrimary }}>
              <Plus size={14} /> New Buyer
            </button>
          </div>
        </div>
        {(() => {
          // Tab definitions shared between desktop nav and mobile drawer
          const tabs = [
            { id: "home",           label: "Home",                 icon: Sparkles },
            { id: "todos",          label: "To-Dos",               icon: CheckCircle2 },
            { id: "dashboard",      label: "Pipeline",             icon: TrendingUp },
            { id: "futureListings", label: "Future Listings",      icon: Home },
            { id: "listings",       label: "Active Transactions",  icon: Briefcase },
            { id: "buyers",         label: "Pending Transactions", icon: Users },
            { id: "closed",         label: "Closed Transactions",  icon: CheckCircle2 },
            { id: "futureBuyers",   label: "Future Buyers",        icon: UserCircle2 },
            { id: "vendors",        label: "Vendors",              icon: Package },
            { id: "social",         label: "Social Media",         icon: Send },
          ];

          // Count badge for a given tab (returns null if no badge)
          const countBadge = (tabId) => {
            if (tabId === "listings") return <span style={styles.tabCount}>{transactions.filter(t => isActiveStage(t)).length}</span>;
            if (tabId === "buyers")   return <span style={styles.tabCount}>{transactions.filter(t => isPendingStage(t)).length}</span>;
            if (tabId === "closed")   return <span style={styles.tabCount}>{transactions.filter(t => isClosedStage(t)).length}</span>;
            if (tabId === "futureListings") return isCloud ? (futureListings.length > 0 ? <span style={styles.tabCount}>{futureListings.length}</span> : null) : <FutureListingCountBadge />;
            if (tabId === "futureBuyers")   return isCloud ? (futureBuyers.length > 0 ? <span style={styles.tabCount}>{futureBuyers.length}</span> : null) : <FutureBuyerCountBadge />;
            if (tabId === "vendors") return isCloud ? (vendors.length > 0 ? <span style={styles.tabCount}>{vendors.length}</span> : null) : <VendorCountBadge />;
            return null;
          };

          const currentTab = tabs.find(t => t.id === view) || tabs[0];

          if (isMobile) {
            // Mobile: hamburger button that toggles a vertical drawer
            return (
              <>
                <button
                  onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "12px 16px",
                    background: "var(--paper-soft)",
                    border: "none",
                    borderTop: "1px solid var(--ink-line)",
                    borderBottom: "1px solid var(--ink-line)",
                    color: "var(--ink)",
                    cursor: "pointer",
                    fontSize: 14,
                    fontWeight: 600,
                    fontFamily: "var(--font-body)",
                  }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <currentTab.icon size={16} />
                    {currentTab.label}
                    {countBadge(currentTab.id)}
                  </span>
                  <Menu size={18} />
                </button>
                {mobileMenuOpen && (
                  <div style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.5)",
                    zIndex: 100,
                  }} onClick={() => setMobileMenuOpen(false)}>
                    <div style={{
                      position: "absolute",
                      top: 0, right: 0, bottom: 0,
                      width: "min(280px, 80vw)",
                      background: "var(--paper)",
                      borderLeft: "1px solid var(--ink-line)",
                      overflowY: "auto",
                      boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
                    }} onClick={(e) => e.stopPropagation()}>
                      <div style={{
                        padding: "16px 18px",
                        borderBottom: "1px solid var(--ink-line)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}>
                        <div style={{ fontSize: 12, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Menu</div>
                        <button onClick={() => setMobileMenuOpen(false)} style={styles.iconBtn}><X size={18} /></button>
                      </div>
                      {tabs.map(tab => {
                        const Icon = tab.icon;
                        const active = view === tab.id;
                        return (
                          <button
                            key={tab.id}
                            onClick={() => { setView(tab.id); setMobileMenuOpen(false); }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              width: "100%",
                              padding: "14px 18px",
                              background: active ? "var(--paper-soft)" : "transparent",
                              border: "none",
                              borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent",
                              color: active ? "var(--ink)" : "var(--ink-soft)",
                              cursor: "pointer",
                              fontSize: 14,
                              fontWeight: active ? 600 : 400,
                              fontFamily: "var(--font-body)",
                              textAlign: "left",
                            }}>
                            <Icon size={16} />
                            <span style={{ flex: 1 }}>{tab.label}</span>
                            {countBadge(tab.id)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            );
          }

          // Desktop: original horizontal tab bar
          return (
            <nav style={styles.nav}>
              {tabs.map(tab => {
                const Icon = tab.icon;
                const active = view === tab.id;
                return (
                  <button key={tab.id} onClick={() => setView(tab.id)} style={{ ...styles.navTab, ...(active ? styles.navTabActive : {}) }}>
                    <Icon size={14} />
                    {tab.label}
                    {countBadge(tab.id)}
                  </button>
                );
              })}
            </nav>
          );
        })()}
      </header>

      <main style={styles.main}>
        {view === "home" ? (
          <HomeBase
            transactions={transactions}
            stats={stats}
            futureListings={futureListings}
            futureBuyers={futureBuyers}
            todoLists={todoLists}
            onTodoListsCloudSave={async (list) => { await upsert("todo_lists", list); }}
            appSettings={appSettings}
            updateSetting={updateSetting}
            isCloud={isCloud}
            onOpen={setDetail}
            onNewListing={() => setEditing(newTransaction("listing"))}
            onNewBuyer={() => setEditing(newTransaction("buyer"))}
            onGoToPipeline={() => setView("dashboard")}
            onGoToView={setView}
          />
        ) : view === "todos" ? (
          <TodosTab
            isCloud={isCloud}
            cloudItems={todoLists}
            onCloudSave={async (list) => { await upsert("todo_lists", list); }}
            onCloudRemove={async (id) => { await remove("todo_lists", id); }}
          />
        ) : view === "dashboard" ? (
          <Dashboard stats={stats} transactions={transactions.filter(t => !isClosedStage(t))} onOpen={setDetail} />
        ) : view === "futureListings" ? (
          <FutureListings
            onConvertToListing={(prefill) => setEditing({ ...newTransaction("listing"), ...prefill })}
            isCloud={isCloud}
            cloudItems={futureListings}
            onCloudSave={async (item) => {
              try {
                const saved = await upsert("future_listings", item);
                const exists = futureListings.find(i => i.id === item.id);
                setFutureListings(exists ? futureListings.map(i => i.id === item.id ? saved : i) : [...futureListings, saved]);
              } catch (e) { alert("Save failed: " + e.message); }
            }}
            onCloudRemove={async (id) => {
              try {
                await remove("future_listings", id);
                setFutureListings(futureListings.filter(i => i.id !== id));
              } catch (e) { alert("Delete failed: " + e.message); }
            }}
          />
        ) : view === "futureBuyers" ? (
          <FutureBuyers
            onConvertToBuyer={(prefill) => setEditing({ ...newTransaction("buyer"), ...prefill })}
            isCloud={isCloud}
            cloudItems={futureBuyers}
            onCloudSave={async (item) => {
              try {
                const saved = await upsert("future_buyers", item);
                const exists = futureBuyers.find(i => i.id === item.id);
                setFutureBuyers(exists ? futureBuyers.map(i => i.id === item.id ? saved : i) : [...futureBuyers, saved]);
              } catch (e) { alert("Save failed: " + e.message); }
            }}
            onCloudRemove={async (id) => {
              try {
                await remove("future_buyers", id);
                setFutureBuyers(futureBuyers.filter(i => i.id !== id));
              } catch (e) { alert("Delete failed: " + e.message); }
            }}
          />
        ) : view === "vendors" ? (
          <Vendors
            isCloud={isCloud}
            cloudItems={vendors}
            onCloudSave={async (item) => {
              try {
                const saved = await upsert("vendors", item);
                const exists = vendors.find(i => i.id === item.id);
                setVendors(exists ? vendors.map(i => i.id === item.id ? saved : i) : [...vendors, saved]);
              } catch (e) { alert("Save failed: " + e.message); }
            }}
            onCloudRemove={async (id) => {
              try {
                await remove("vendors", id);
                setVendors(vendors.filter(i => i.id !== id));
              } catch (e) { alert("Delete failed: " + e.message); }
            }}
          />
        ) : view === "social" ? (
          <SocialMediaTab />
        ) : (
          <>
            <div style={styles.searchBar}>
              <Search size={16} style={{ color: "var(--ink-soft)" }} />
              <input type="text" placeholder="Search by address, party, or city…"
                value={search} onChange={(e) => setSearch(e.target.value)} style={styles.searchInput} />
            </div>
            {filtered.length === 0 ? (
              <EmptyState type={view} onCreate={() => setEditing(newTransaction(view === "buyers" ? "buyer" : "listing"))} />
            ) : (
              <div style={styles.cardGrid}>
                {filtered.map(t => <TransactionCard key={t.id} txn={t} onClick={() => setDetail(t)} />)}
              </div>
            )}
          </>
        )}
      </main>

      {editing && <FormModal txn={editing} onClose={() => setEditing(null)} onSave={handleSave} contactDirectory={getContactDirectory(transactions)} />}
      {detail && !editing && (
        <DetailModal txn={detail} onClose={() => setDetail(null)}
          onEdit={() => setEditing(detail)} onDelete={() => handleDelete(detail.id)} onUpdate={handleSave} isCloud={isCloud} />
      )}

      {/* Quick Add floating button — always visible */}
      <QuickAddFAB
        open={showQuickAdd}
        setOpen={setShowQuickAdd}
        onNewListing={() => { setShowQuickAdd(false); setEditing(newTransaction("listing")); }}
        onNewBuyer={() => { setShowQuickAdd(false); setEditing(newTransaction("buyer")); }}
        onFutureListing={() => { setShowQuickAdd(false); setView("futureListings"); }}
        onFutureBuyer={() => { setShowQuickAdd(false); setView("futureBuyers"); }}
        onVendor={() => { setShowQuickAdd(false); setView("vendors"); }}
        onSearch={() => { setShowQuickAdd(false); setShowGlobalSearch(true); }}
      />

      {/* Global Search modal — Cmd+K or click the FAB option */}
      {showGlobalSearch && (
        <GlobalSearch
          transactions={transactions}
          onClose={() => setShowGlobalSearch(false)}
          onOpenTxn={(txn) => { setShowGlobalSearch(false); setDetail(txn); }}
          onGoToView={(viewId) => { setShowGlobalSearch(false); setView(viewId); }}
        />
      )}

      {/* Template editor — for managing prelist & closing checklists */}
      {showTemplateEditor && (
        <TemplateEditorModal
          kind={showTemplateEditor}
          onClose={() => setShowTemplateEditor(null)}
          isCloud={isCloud}
          updateSetting={updateSetting}
        />
      )}

      {/* Migration modal — one-click upload local data to cloud */}
      {showMigration && (
        <MigrationModal
          onClose={() => setShowMigration(false)}
          onComplete={async () => {
            // Reload everything from cloud after migration
            try {
              const [txns, fl, fb, vds] = await Promise.all([
                loadAll("transactions"), loadAll("future_listings"),
                loadAll("future_buyers"), loadAll("vendors"),
              ]);
              setTransactions(txns.map(ensureTxnSchema));
              setFutureListings(fl); setFutureBuyers(fb); setVendors(vds);
            } catch (e) { console.error(e); }
          }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// HOME BASE — daily landing page: links, pipeline at-a-glance, notes, todos
// ════════════════════════════════════════════════════════════════════════════
const DEFAULT_LINKS = [
  { id: "nwmls",   label: "NWMLS",             url: "https://www.nwmls.com",                    icon: "🏠", color: "#1d4e89", iconMode: "favicon" },
  { id: "pl",      label: "Paperless Pipeline",url: "https://app.paperlesspipeline.com",        icon: "📋", color: "#2d8c5c", iconMode: "favicon" },
  { id: "cowlitz", label: "Cowlitz Assessor",  url: "https://www.cowlitzwa.gov/178/Assessor",   icon: "🗺️", color: "#7b4e2b", iconMode: "favicon" },
  { id: "gmail",   label: "Gmail",             url: "https://mail.google.com",                  icon: "✉️", color: "#c5221f", iconMode: "favicon" },
  { id: "cal",     label: "Calendar",          url: "https://calendar.google.com",              icon: "📅", color: "#1a73e8", iconMode: "favicon" },
  { id: "zillow",  label: "Zillow",            url: "https://www.zillow.com",                   icon: "🏡", color: "#006aff", iconMode: "favicon" },
  { id: "redfin",  label: "Redfin",            url: "https://www.redfin.com",                   icon: "🔍", color: "#a02021", iconMode: "favicon" },
  { id: "docusign",label: "DocuSign",          url: "https://www.docusign.com",                 icon: "✍️", color: "#ffcc22", iconMode: "favicon" },
  { id: "chatgpt", label: "ChatGPT",           url: "https://chat.openai.com",                  icon: "🤖", color: "#10a37f", iconMode: "favicon" },
];

// Returns the Google favicon service URL for a given site URL.
// Returns null if we can't parse a hostname.
function faviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
  } catch (e) { return null; }
}

const LINKS_STORAGE_KEY = "jct_home_links";
const NOTES_STORAGE_KEY = "jct_quick_notes";
const TODOS_TODAY_KEY = "jct_todos_today";
const TODOS_GENERAL_KEY = "jct_todos_general";
const LAYOUT_STORAGE_KEY = "jct_home_layout_v1";
const CUSTOM_LISTS_KEY = "jct_custom_lists";
const HABITS_KEY = "jct_habits";
const CALENDAR_EVENTS_KEY = "jct_calendar_events";

// Widget definitions — every available widget on the home page
const WIDGET_TYPES = {
  todoReminders: { label: "To-Do Reminders",      size: "small", description: "Items from your To-Dos tab with active reminders" },
  notes:         { label: "Quick Notes",          size: "small", description: "Scratchpad — auto-saves" },
  next7:         { label: "Next 7 Days",          size: "small", description: "Upcoming milestone deadlines" },
  checkIns:      { label: "Lead Check-Ins",       size: "small", description: "Future Listings & Buyers due for follow-up" },
  calendar:      { label: "Calendar",             size: "large", description: "Month view with milestones + your own events" },
  quickLaunch:   { label: "Quick Launch",         size: "large", description: "Website tiles (Gmail, NWMLS, etc.)" },
  recent:        { label: "Recent Transactions",  size: "small", description: "Last 4 deals you touched" },
  calculator:    { label: "Mortgage Calculator",  size: "small", description: "Payment + commission split" },
  contactLookup: { label: "Quick Contact Lookup", size: "small", description: "Search any contact from any transaction" },
  habits:        { label: "Habit Tracker",        size: "small", description: "Track daily habits + streaks" },
};

// Default layout — what shows up on first load
const DEFAULT_LAYOUT = [
  { id: "w_todo_reminders", type: "todoReminders", col: "left" },
  { id: "w_check_ins", type: "checkIns", col: "right" },
  { id: "w_quick_launch", type: "quickLaunch", col: "full" },
  { id: "w_next7", type: "next7", col: "left" },
  { id: "w_calendar", type: "calendar", col: "right" },
  { id: "w_notes", type: "notes", col: "left" },
  { id: "w_recent", type: "recent", col: "right" },
];

// Kalama, WA coords for the weather widget (Open-Meteo — no API key needed)
const HOME_LAT = 46.0093;
const HOME_LON = -122.8443;
const HOME_LABEL = "Kalama, WA";

// ════════════════════════════════════════════════════════════════════════════
// HOME BASE — fully customizable widget dashboard
// Edit mode lets you add/remove/reorder widgets across two columns.
// All widget data and layout auto-saves per device.
// ════════════════════════════════════════════════════════════════════════════
function HomeBase({ transactions, stats, futureListings, futureBuyers, todoLists, onTodoListsCloudSave, appSettings, updateSetting, isCloud, onOpen, onNewListing, onNewBuyer, onGoToPipeline, onGoToView }) {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [editMode, setEditMode] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [weather, setWeather] = useState(null);
  const [draggedId, setDraggedId] = useState(null);

  // Load layout. Cloud → from appSettings; local → from localStorage.
  // Either way migrate deprecated to-do widgets and ensure todoReminders exists.
  useEffect(() => {
    const migrate = (parsed) => {
      const deprecatedTypes = new Set(["todosToday", "todosGeneral", "customList"]);
      const cleaned = parsed.filter(w => !deprecatedTypes.has(w.type));
      const hasTodoReminders = cleaned.some(w => w.type === "todoReminders");
      if (!hasTodoReminders) {
        cleaned.unshift({ id: "w_todo_reminders", type: "todoReminders", col: "left" });
      }
      return cleaned;
    };

    if (isCloud) {
      const cloudLayout = appSettings?.home_layout;
      if (cloudLayout && Array.isArray(cloudLayout) && cloudLayout.length > 0) {
        setLayout(migrate(cloudLayout));
      }
      return;
    }

    try {
      const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (saved) setLayout(migrate(JSON.parse(saved)));
    } catch (e) {}
  }, [isCloud, appSettings?.home_layout]);

  // Save layout: cloud → user_settings, local → localStorage
  useEffect(() => {
    if (isCloud) {
      // Skip the very first auto-save (when layout is still DEFAULT_LAYOUT)
      // so we don't overwrite a synced layout that's still being loaded.
      if (layout !== DEFAULT_LAYOUT && updateSetting) {
        updateSetting("home_layout", layout);
      }
    } else {
      try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch (e) {}
    }
  }, [layout, isCloud]);

  // Weather
  useEffect(() => {
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${HOME_LAT}&longitude=${HOME_LON}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FLos_Angeles&forecast_days=1`)
      .then(r => r.json()).then(setWeather).catch(() => setWeather({ error: true }));
  }, []);

  const urgent = stats.upcoming.filter(u => {
    const lead = u.milestone.reminderDays ?? DEFAULT_REMINDER_DAYS;
    return u.days <= Math.max(lead, 0);
  });

  // Widget operations
  const addWidget = (type) => {
    const newWidget = {
      id: `w_${newId()}`,
      type,
      col: WIDGET_TYPES[type].size === "large" ? "full" : "left",
    };
    setLayout([...layout, newWidget]);
    setShowAddPanel(false);
  };
  const removeWidget = (id) => setLayout(layout.filter(w => w.id !== id));
  const moveWidget = (id, newCol) => setLayout(layout.map(w => w.id === id ? { ...w, col: newCol } : w));
  const resetLayout = () => {
    if (!confirm("Reset to default layout? Your widget data won't be lost — just the arrangement.")) return;
    setLayout(DEFAULT_LAYOUT);
  };

  // Drag-and-drop reorder
  const onDragStart = (id) => setDraggedId(id);
  const onDragEnd = () => setDraggedId(null);
  const onDropOn = (targetId, targetCol) => {
    if (!draggedId || draggedId === targetId) return;
    const dragged = layout.find(w => w.id === draggedId);
    if (!dragged) return;
    const without = layout.filter(w => w.id !== draggedId);
    const targetIdx = without.findIndex(w => w.id === targetId);
    const updated = { ...dragged, col: targetCol };
    const next = [...without.slice(0, targetIdx + 1), updated, ...without.slice(targetIdx + 1)];
    setLayout(next);
    setDraggedId(null);
  };
  const onDropOnEmptyCol = (col) => {
    if (!draggedId) return;
    const dragged = layout.find(w => w.id === draggedId);
    if (!dragged) return;
    const without = layout.filter(w => w.id !== draggedId);
    setLayout([...without, { ...dragged, col }]);
    setDraggedId(null);
  };

  // Sort widgets into the three column buckets while preserving order
  const fullWidgets = layout.filter(w => w.col === "full");
  const leftWidgets = layout.filter(w => w.col === "left");
  const rightWidgets = layout.filter(w => w.col === "right");

  // Which widget types are available to add (filters out single-instance ones already present)
  const availableToAdd = Object.entries(WIDGET_TYPES).filter(([type, def]) => {
    if (def.multiple) return true;
    return !layout.some(w => w.type === type);
  });

  const widgetProps = {
    transactions, stats, onOpen, urgent, weather, editMode,
    futureListings: futureListings || [],
    futureBuyers: futureBuyers || [],
    todoLists: todoLists || [],
    onTodoListsCloudSave,
    appSettings: appSettings || {},
    updateSetting,
    isCloud,
    onGoToView,
  };

  return (
    <>
      {/* Greeting + weather + edit controls */}
      <div style={styles.greetingRow}>
        <div>
          <div style={styles.greeting}>{greetingFor(new Date())}, Jesse.</div>
          <div style={styles.greetingSub}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!editMode && <WeatherWidget data={weather} />}
          <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
            <button
              onClick={() => setEditMode(!editMode)}
              style={{ ...styles.btn, ...(editMode ? styles.btnPrimary : styles.btnGhost), padding: "8px 12px", fontSize: 12 }}
            >
              {editMode ? <><CheckCircle2 size={12} /> Done</> : <><Edit3 size={12} /> Customize</>}
            </button>
            {editMode && (
              <button
                onClick={resetLayout}
                style={{ ...styles.btn, ...styles.btnGhost, padding: "6px 10px", fontSize: 11 }}
              >
                Reset layout
              </button>
            )}
          </div>
        </div>
      </div>

      {urgent.length > 0 && !editMode && (
        <button onClick={onGoToPipeline} style={styles.urgentPill}>
          <AlertTriangle size={14} /> {urgent.length} milestone{urgent.length === 1 ? "" : "s"} need{urgent.length === 1 ? "s" : ""} attention — open Pipeline
          <ChevronRight size={14} />
        </button>
      )}

      {editMode && (
        <div style={styles.editModeBanner}>
          <Edit3 size={14} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Customize mode</div>
            <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
              Drag any widget to a new position. Click × to remove. Click "Add widget" to add more.
            </div>
          </div>
          <button onClick={() => setShowAddPanel(true)} style={{ ...styles.btn, ...styles.btnPrimary, padding: "8px 14px", fontSize: 13 }}>
            <Plus size={13} /> Add widget
          </button>
        </div>
      )}

      {/* FULL-WIDTH widgets */}
      {fullWidgets.map(w => (
        <WidgetSlot key={w.id} widget={w} editMode={editMode}
          onRemove={removeWidget} onDragStart={onDragStart} onDragEnd={onDragEnd}
          onDropOn={onDropOn} draggedId={draggedId}
          onMove={moveWidget}>
          {renderWidget(w, widgetProps)}
        </WidgetSlot>
      ))}

      {/* TWO COLUMNS */}
      <div style={styles.widgetGrid} className="widget-grid">
        <ColumnDropZone col="left" editMode={editMode} draggedId={draggedId}
          onDropOnEmptyCol={onDropOnEmptyCol} empty={leftWidgets.length === 0}>
          {leftWidgets.map(w => (
            <WidgetSlot key={w.id} widget={w} editMode={editMode}
              onRemove={removeWidget} onDragStart={onDragStart} onDragEnd={onDragEnd}
              onDropOn={onDropOn} draggedId={draggedId}
              onMove={moveWidget}>
              {renderWidget(w, widgetProps)}
            </WidgetSlot>
          ))}
        </ColumnDropZone>
        <ColumnDropZone col="right" editMode={editMode} draggedId={draggedId}
          onDropOnEmptyCol={onDropOnEmptyCol} empty={rightWidgets.length === 0}>
          {rightWidgets.map(w => (
            <WidgetSlot key={w.id} widget={w} editMode={editMode}
              onRemove={removeWidget} onDragStart={onDragStart} onDragEnd={onDragEnd}
              onDropOn={onDropOn} draggedId={draggedId}
              onMove={moveWidget}>
              {renderWidget(w, widgetProps)}
            </WidgetSlot>
          ))}
        </ColumnDropZone>
      </div>

      {showAddPanel && (
        <AddWidgetPanel
          available={availableToAdd}
          onAdd={addWidget}
          onClose={() => setShowAddPanel(false)}
        />
      )}
    </>
  );
}

// ─── Widget Slot (wrapper with drag handles + remove button) ─────────────────
function WidgetSlot({ widget, editMode, children, onRemove, onDragStart, onDragEnd, onDropOn, draggedId, onMove }) {
  const isDragging = draggedId === widget.id;
  const def = WIDGET_TYPES[widget.type] || { label: widget.type };
  return (
    <div
      draggable={editMode}
      onDragStart={() => onDragStart(widget.id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { if (editMode && draggedId) e.preventDefault(); }}
      onDrop={() => onDropOn(widget.id, widget.col)}
      style={{
        ...styles.widgetSlot,
        ...(editMode ? styles.widgetSlotEdit : {}),
        ...(isDragging ? styles.widgetSlotDragging : {}),
        marginBottom: 16,
      }}
    >
      {editMode && (
        <div style={styles.widgetEditBar}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", color: "var(--ink-soft)" }}>
            <Grip /> <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>{def.label}</span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {widget.col !== "full" && (
              <button onClick={() => onMove(widget.id, "full")} style={styles.widgetEditBtn} title="Make full-width">
                ↔
              </button>
            )}
            {widget.col === "full" && (
              <button onClick={() => onMove(widget.id, "left")} style={styles.widgetEditBtn} title="Make column-width">
                ↕
              </button>
            )}
            {widget.col === "right" && (
              <button onClick={() => onMove(widget.id, "left")} style={styles.widgetEditBtn} title="Move to left column">
                ←
              </button>
            )}
            {widget.col === "left" && (
              <button onClick={() => onMove(widget.id, "right")} style={styles.widgetEditBtn} title="Move to right column">
                →
              </button>
            )}
            <button onClick={() => onRemove(widget.id)} style={{ ...styles.widgetEditBtn, color: "#a94d4d" }} title="Remove">
              <X size={12} />
            </button>
          </div>
        </div>
      )}
      <div style={editMode ? { pointerEvents: "none", opacity: 0.85 } : {}}>
        {children}
      </div>
    </div>
  );
}

function Grip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
      <circle cx="2" cy="2" r="1.2" /><circle cx="8" cy="2" r="1.2" />
      <circle cx="2" cy="7" r="1.2" /><circle cx="8" cy="7" r="1.2" />
      <circle cx="2" cy="12" r="1.2" /><circle cx="8" cy="12" r="1.2" />
    </svg>
  );
}

function ColumnDropZone({ col, editMode, draggedId, onDropOnEmptyCol, empty, children }) {
  return (
    <div
      onDragOver={(e) => { if (editMode && draggedId) e.preventDefault(); }}
      onDrop={() => empty && onDropOnEmptyCol(col)}
      style={{
        ...(editMode && empty ? styles.columnEmptyDrop : {}),
      }}
    >
      {children}
      {editMode && empty && (
        <div style={{ textAlign: "center", color: "var(--ink-soft)", fontSize: 12, padding: 24 }}>
          Drop a widget here
        </div>
      )}
    </div>
  );
}

// ─── Widget Renderer (dispatch by type) ─────────────────────────────────────
function renderWidget(widget, props) {
  const { transactions, stats, onOpen, urgent, weather, futureListings, futureBuyers, isCloud, onGoToView } = props;
  switch (widget.type) {
    case "todoReminders":return <TodoRemindersWidget onGoToView={onGoToView} isCloud={props.isCloud} cloudItems={props.todoLists} onCloudSave={props.onTodoListsCloudSave} />;
    case "notes":        return <NotesWidget isCloud={props.isCloud} appSettings={props.appSettings} updateSetting={props.updateSetting} />;
    case "next7":        return <Next7Widget transactions={transactions} onOpen={onOpen} isCloud={props.isCloud} appSettings={props.appSettings} />;
    case "checkIns":     return <CheckInsWidget futureListings={futureListings} futureBuyers={futureBuyers} isCloud={isCloud} onGoToView={onGoToView} />;
    case "calendar":     return <CalendarWidget transactions={transactions} onOpen={onOpen} isCloud={props.isCloud} appSettings={props.appSettings} updateSetting={props.updateSetting} />;
    case "quickLaunch":  return <QuickLaunchWidget homeEditMode={props.editMode} isCloud={props.isCloud} appSettings={props.appSettings} updateSetting={props.updateSetting} />;
    case "recent":       return <RecentWidget transactions={transactions} onOpen={onOpen} />;
    case "calculator":   return <CalculatorWidget />;
    case "contactLookup":return <ContactLookupWidget transactions={transactions} onOpen={onOpen} />;
    case "habits":       return <HabitsWidget isCloud={props.isCloud} appSettings={props.appSettings} updateSetting={props.updateSetting} />;
    // Legacy widget types — kept so existing saved layouts don't crash on load.
    // They render nothing; user is expected to remove them in Customize mode.
    case "todosToday":   return null;
    case "todosGeneral": return null;
    case "customList":   return null;
    default: return <div style={{ padding: 20, color: "var(--ink-soft)" }}>Unknown widget: {widget.type}</div>;
  }
}

// ─── Add Widget Panel ─────────────────────────────────────────────────────────
function AddWidgetPanel({ available, onAdd, onClose }) {
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Customize Home</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--ink)" }}>Add a widget</div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          {available.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--ink-soft)" }}>
              All available widgets are already on your home page. Custom Lists can be added multiple times.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {available.map(([type, def]) => (
                <button key={type} onClick={() => onAdd(type)} style={styles.addWidgetCard} data-add-widget="true">
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 500, color: "var(--ink)" }}>
                    {def.label}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>
                    {def.description}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL WIDGETS
// ════════════════════════════════════════════════════════════════════════════

// ─── Todo List Widget (Today's / General — uses storage key prop) ───────────
function TodoListWidget({ storageKey, title, placeholder }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try { const v = localStorage.getItem(storageKey); if (v) setItems(JSON.parse(v)); } catch (e) {}
    setLoaded(true);
  }, [storageKey]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(storageKey, JSON.stringify(items)); } catch (e) {}
  }, [items, storageKey, loaded]);
  return <TodoList title={title} items={items} onChange={setItems} placeholder={placeholder} />;
}

// ─── Custom List Widget — user-named, like a todo list ──────────────────────
function CustomListWidget({ widgetId }) {
  const key = `jct_custom_list_${widgetId}`;
  const titleKey = `jct_custom_list_title_${widgetId}`;
  const [items, setItems] = useState([]);
  const [title, setTitle] = useState("New List");
  const [editingTitle, setEditingTitle] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try { const v = localStorage.getItem(key); if (v) setItems(JSON.parse(v)); } catch (e) {}
    try { const t = localStorage.getItem(titleKey); if (t) setTitle(t); } catch (e) {}
    setLoaded(true);
  }, [key, titleKey]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(key, JSON.stringify(items)); } catch (e) {}
  }, [items, key, loaded]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(titleKey, title); } catch (e) {}
  }, [title, titleKey, loaded]);

  return (
    <TodoList
      title={editingTitle ? (
        <input type="text" value={title} autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => setEditingTitle(false)}
          onKeyDown={(e) => { if (e.key === "Enter") setEditingTitle(false); }}
          style={{ ...styles.input, padding: "2px 6px", fontSize: 17, fontFamily: "var(--font-display)", fontWeight: 500, width: "100%" }} />
      ) : (
        <span onClick={() => setEditingTitle(true)} style={{ cursor: "text" }} title="Click to rename">
          {title} <Edit3 size={11} style={{ color: "var(--ink-soft)", opacity: 0.5, verticalAlign: 0 }} />
        </span>
      )}
      items={items}
      onChange={setItems}
      placeholder="Add an item…"
    />
  );
}

// ─── Notes Widget ────────────────────────────────────────────────────────────
function NotesWidget({ isCloud, appSettings, updateSetting }) {
  // We use localValue as the immediately-displayed text so typing is responsive,
  // and debounce writes to the cloud. In local mode, localValue IS the source.
  const [localValue, setLocalValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef(null);

  // Initial load
  useEffect(() => {
    if (isCloud) {
      setLocalValue(appSettings?.quick_notes || "");
      setLoaded(true);
      return;
    }
    try { const v = localStorage.getItem(NOTES_STORAGE_KEY); if (v) setLocalValue(v); } catch (e) {}
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCloud]);

  // Track external changes from cloud realtime (only in cloud mode)
  useEffect(() => {
    if (!isCloud) return;
    const cloudVal = appSettings?.quick_notes || "";
    // Only adopt the cloud value if we're not in the middle of editing
    if (debounceRef.current === null && cloudVal !== localValue) {
      setLocalValue(cloudVal);
    }
  }, [isCloud, appSettings?.quick_notes]);

  // Save: cloud (debounced) or localStorage (immediate)
  const handleChange = (e) => {
    const v = e.target.value;
    setLocalValue(v);
    if (!loaded) return;
    if (isCloud) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateSetting && updateSetting("quick_notes", v);
        debounceRef.current = null;
      }, 800);
    } else {
      try { localStorage.setItem(NOTES_STORAGE_KEY, v); } catch (e2) {}
    }
  };

  return (
    <div>
      <h2 style={styles.sectionTitle}>Quick Notes</h2>
      <textarea value={localValue} onChange={handleChange}
        placeholder="Scratchpad — call notes, lead reminders, anything. Auto-saves."
        style={styles.notesPad} />
    </div>
  );
}

// ─── Next 7 Days Widget ──────────────────────────────────────────────────────
function Next7Widget({ transactions, onOpen, isCloud, appSettings }) {
  // Calendar events: cloud → appSettings.calendar_events; local → poll localStorage
  const [localCalendarEvents, setLocalCalendarEvents] = useState([]);
  const calendarEvents = isCloud ? (appSettings?.calendar_events || []) : localCalendarEvents;

  useEffect(() => {
    if (isCloud) return;
    const reload = () => {
      try {
        const stored = localStorage.getItem(CALENDAR_EVENTS_KEY);
        setLocalCalendarEvents(stored ? JSON.parse(stored) : []);
      } catch (e) { setLocalCalendarEvents([]); }
    };
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [isCloud]);

  const next7 = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      const iso = formatLocalDate(d);
      const events = [];
      // Transaction milestones
      transactions
        .filter(t => t.status !== "closed" && t.status !== "fellThrough")
        .forEach(t => t.milestones.forEach(m => {
          if (m.date === iso && !m.complete) events.push({ kind: "milestone", txn: t, milestone: m });
        }));
      // Personal calendar events
      calendarEvents
        .filter(ev => ev.date === iso)
        .forEach(ev => events.push({ kind: "personal", event: ev }));
      days.push({ date: d, iso, events });
    }
    return days;
  }, [transactions, calendarEvents]);

  return (
    <div>
      <h2 style={styles.sectionTitle}>Next 7 Days</h2>
      <div style={styles.next7Box}>
        {next7.map((d) => {
          const isToday = d.iso === formatLocalDate(new Date());
          return (
            <div key={d.iso} style={{ ...styles.next7Row, ...(isToday ? styles.next7Today : {}) }}>
              <div style={styles.next7Date}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.7 }}>
                  {d.date.toLocaleDateString("en-US", { weekday: "short" })}
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 500 }}>
                  {d.date.getDate()}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {d.events.length === 0 ? (
                  <div style={{ color: "var(--ink-soft)", fontSize: 12, fontStyle: "italic" }}>—</div>
                ) : d.events.map((ev, i) => {
                  if (ev.kind === "milestone") {
                    return (
                      <button key={i} onClick={() => onOpen(ev.txn)} style={styles.next7Event}>
                        <span style={{ fontWeight: 500 }}>{ev.milestone.label}</span>
                        <span style={{ color: "var(--ink-soft)" }}> · {ev.txn.address?.split(",")[0]}</span>
                      </button>
                    );
                  }
                  // Personal calendar event — non-clickable but styled with accent dot
                  return (
                    <div key={i} style={{ ...styles.next7Event, cursor: "default", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                      <span style={{ fontWeight: 500 }}>{ev.event.title}</span>
                      {ev.event.time && <span style={{ color: "var(--ink-soft)" }}> · {ev.event.time}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Calendar Widget ─────────────────────────────────────────────────────────
function CalendarWidget({ transactions, onOpen, isCloud, appSettings, updateSetting }) {
  const [viewDate, setViewDate] = useState(new Date());
  const [selectedISO, setSelectedISO] = useState(formatLocalDate(new Date()));
  const [localEvents, setLocalEvents] = useState([]);
  const [newEventText, setNewEventText] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Cloud uses settings; local uses localStorage
  const events = isCloud ? (appSettings?.calendar_events || []) : localEvents;

  useEffect(() => {
    if (isCloud) { setLoaded(true); return; }
    try { const v = localStorage.getItem(CALENDAR_EVENTS_KEY); if (v) setLocalEvents(JSON.parse(v)); } catch (e) {}
    setLoaded(true);
  }, [isCloud]);

  // Universal save — cloud or local
  const saveEvents = async (next) => {
    if (isCloud) {
      updateSetting && updateSetting("calendar_events", next);
    } else {
      setLocalEvents(next);
      try { localStorage.setItem(CALENDAR_EVENTS_KEY, JSON.stringify(next)); } catch (e) {}
    }
  };

  // Build month grid
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const monthName = viewDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // Collect milestones + events into a date-keyed map
  const dateMap = useMemo(() => {
    const m = {};
    transactions
      .filter(t => t.status !== "closed" && t.status !== "fellThrough")
      .forEach(t => t.milestones.forEach(ms => {
        if (!ms.date) return;
        if (!m[ms.date]) m[ms.date] = [];
        m[ms.date].push({ kind: "milestone", txn: t, milestone: ms });
      }));
    events.forEach(ev => {
      if (!m[ev.date]) m[ev.date] = [];
      m[ev.date].push({ kind: "event", event: ev });
    });
    return m;
  }, [transactions, events]);

  const todayISO = formatLocalDate(new Date());

  const goPrev = () => setViewDate(new Date(year, month - 1, 1));
  const goNext = () => setViewDate(new Date(year, month + 1, 1));
  const goToday = () => { setViewDate(new Date()); setSelectedISO(todayISO); };

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = formatLocalDate(new Date(year, month, d));
    cells.push({ day: d, iso });
  }

  const selectedItems = dateMap[selectedISO] || [];

  const addEvent = () => {
    if (!newEventText.trim()) return;
    saveEvents([...events, { id: newId(), date: selectedISO, text: newEventText.trim(), created: Date.now() }]);
    setNewEventText("");
  };
  const removeEvent = (id) => saveEvents(events.filter(e => e.id !== id));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Calendar</h2>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button onClick={goPrev} style={styles.iconBtn} title="Previous month">‹</button>
          <button onClick={goToday} style={{ ...styles.btn, ...styles.btnGhost, padding: "5px 10px", fontSize: 11 }}>Today</button>
          <button onClick={goNext} style={styles.iconBtn} title="Next month">›</button>
        </div>
      </div>
      <div style={styles.calBox}>
        <div style={styles.calMonth}>{monthName}</div>
        <div style={styles.calGrid}>
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i} style={styles.calDow}>{d}</div>
          ))}
          {cells.map((c, i) => {
            if (!c) return <div key={i} />;
            const dayItems = dateMap[c.iso] || [];
            const isToday = c.iso === todayISO;
            const isSelected = c.iso === selectedISO;
            return (
              <button key={i} onClick={() => setSelectedISO(c.iso)}
                style={{
                  ...styles.calCell,
                  ...(isToday ? styles.calCellToday : {}),
                  ...(isSelected ? styles.calCellSelected : {}),
                }}>
                <div style={{ fontWeight: isToday ? 700 : 500 }}>{c.day}</div>
                {dayItems.length > 0 && (
                  <div style={{ display: "flex", gap: 2, justifyContent: "center", marginTop: 2 }}>
                    {dayItems.slice(0, 3).map((it, j) => (
                      <div key={j} style={{
                        width: 4, height: 4, borderRadius: "50%",
                        background: it.kind === "milestone" ? "var(--accent)" : "var(--ink-soft)",
                      }} />
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <div style={styles.calDetail}>
          <div style={{ fontSize: 11, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
            {new Date(selectedISO + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </div>
          {selectedItems.length === 0 && (
            <div style={{ color: "var(--ink-soft)", fontSize: 12, fontStyle: "italic" }}>Nothing scheduled.</div>
          )}
          {selectedItems.map((it, i) => {
            if (it.kind === "milestone") {
              return (
                <button key={i} onClick={() => onOpen(it.txn)} style={styles.calItem}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <strong>{it.milestone.label}</strong>
                    <span style={{ color: "var(--ink-soft)" }}> · {it.txn.address?.split(",")[0]}</span>
                  </div>
                </button>
              );
            }
            return (
              <div key={i} style={styles.calItem}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ink-soft)" }} />
                <div style={{ flex: 1, fontSize: 13 }}>{it.event.text}</div>
                <button onClick={() => removeEvent(it.event.id)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", cursor: "pointer", padding: 2 }}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--ink-line)" }}>
            <input type="text" placeholder="Add personal event…"
              value={newEventText} onChange={(e) => setNewEventText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEvent(); } }}
              style={{ ...styles.input, padding: "6px 10px", fontSize: 12 }} />
            <button onClick={addEvent} disabled={!newEventText.trim()}
              style={{ ...styles.btn, ...styles.btnPrimary, padding: "6px 10px", opacity: newEventText.trim() ? 1 : 0.5 }}>
              <Plus size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Quick Launch Widget ─────────────────────────────────────────────────────
// `homeEditMode` is whether the WHOLE home page is in customize mode (drag widgets).
// `editingLinks` is whether THIS widget specifically is in tile-edit mode.
// We enable tile editing in both situations so the user doesn't have to learn
// the difference. (Note: the parent wraps widget content in pointer-events:none
// when homeEditMode is on, so this widget overrides that for its tile controls.)
function QuickLaunchWidget({ homeEditMode, isCloud, appSettings, updateSetting }) {
  const [localLinks, setLocalLinks] = useState(DEFAULT_LINKS);
  const [editingLinks, setEditingLinks] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Cloud → appSettings.home_links; local → localStorage
  const links = isCloud ? (appSettings?.home_links || DEFAULT_LINKS) : localLinks;

  useEffect(() => {
    if (isCloud) { setLoaded(true); return; }
    try { const v = localStorage.getItem(LINKS_STORAGE_KEY); if (v) setLocalLinks(JSON.parse(v)); } catch (e) {}
    setLoaded(true);
  }, [isCloud]);

  // Universal save
  const saveLinks = (next) => {
    if (isCloud) {
      updateSetting && updateSetting("home_links", next);
    } else {
      setLocalLinks(next);
      try { localStorage.setItem(LINKS_STORAGE_KEY, JSON.stringify(next)); } catch (e) {}
    }
  };

  const editing = editingLinks || homeEditMode;

  return (
    <div>
      <div style={styles.sectionTitleRow}>
        <h2 style={styles.sectionTitle}>Quick Launch</h2>
        {!homeEditMode && (
          <button onClick={() => setEditingLinks(!editingLinks)}
            style={{ ...styles.btn, ...styles.btnGhost, padding: "4px 10px", fontSize: 12 }}>
            {editingLinks ? <><CheckCircle2 size={12} /> Done</> : <><Edit3 size={12} /> Edit</>}
          </button>
        )}
      </div>
      <QuickLaunch links={links} onChange={saveLinks} editing={editing} />
    </div>
  );
}

// ─── Recent Transactions Widget ──────────────────────────────────────────────
function RecentWidget({ transactions, onOpen }) {
  const recent = transactions.slice().reverse().slice(0, 4);
  return (
    <div>
      <h2 style={styles.sectionTitle}>Recent Transactions</h2>
      {recent.length === 0 ? (
        <div style={{ ...styles.next7Box, padding: 18, color: "var(--ink-soft)", fontSize: 13, fontStyle: "italic", textAlign: "center" }}>
          No transactions yet.
        </div>
      ) : (
        <div style={styles.recentList}>
          {recent.map(t => (
            <button key={t.id} onClick={() => onOpen(t)} style={styles.recentRow} data-urgent="true">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.address || "(no address)"}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                  {t.type === "listing" ? "Listing" : "Buyer"} · {lastName(t.sellerName) || "—"} → {lastName(t.buyerName) || "—"}
                </div>
              </div>
              <ChevronRight size={14} style={{ color: "var(--ink-soft)" }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Mortgage / Commission Calculator Widget ─────────────────────────────────
function CalculatorWidget() {
  const [price, setPrice] = useState("500000");
  const [downPct, setDownPct] = useState("20");
  const [rate, setRate] = useState("7.0");
  const [years, setYears] = useState("30");
  const [commissionPct, setCommissionPct] = useState("3");

  const p = parseFloat(price) || 0;
  const dp = parseFloat(downPct) || 0;
  const r = parseFloat(rate) || 0;
  const n = parseFloat(years) || 30;
  const cp = parseFloat(commissionPct) || 0;

  const downAmount = p * (dp / 100);
  const loanAmount = p - downAmount;
  const monthlyRate = (r / 100) / 12;
  const totalMonths = n * 12;
  const monthlyPayment = monthlyRate > 0 && loanAmount > 0
    ? (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, totalMonths)) / (Math.pow(1 + monthlyRate, totalMonths) - 1)
    : 0;
  const commission = p * (cp / 100);

  return (
    <div>
      <h2 style={styles.sectionTitle}>Calculator</h2>
      <div style={{ ...styles.todoBoxCard, padding: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <Field label="Price">
            <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} style={{ ...styles.input, padding: "6px 10px", fontSize: 13 }} />
          </Field>
          <Field label="Down %">
            <input type="number" value={downPct} onChange={(e) => setDownPct(e.target.value)} style={{ ...styles.input, padding: "6px 10px", fontSize: 13 }} />
          </Field>
          <Field label="Rate %">
            <input type="number" step="0.125" value={rate} onChange={(e) => setRate(e.target.value)} style={{ ...styles.input, padding: "6px 10px", fontSize: 13 }} />
          </Field>
          <Field label="Years">
            <input type="number" value={years} onChange={(e) => setYears(e.target.value)} style={{ ...styles.input, padding: "6px 10px", fontSize: 13 }} />
          </Field>
          <Field label="Commission %">
            <input type="number" step="0.25" value={commissionPct} onChange={(e) => setCommissionPct(e.target.value)} style={{ ...styles.input, padding: "6px 10px", fontSize: 13 }} />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, borderTop: "1px solid var(--ink-line)", paddingTop: 12 }}>
          <CalcResult label="Down Payment" value={fmtMoney(downAmount)} />
          <CalcResult label="Loan Amount" value={fmtMoney(loanAmount)} />
          <CalcResult label="Monthly P&I" value={fmtMoney(monthlyPayment)} highlight />
          <CalcResult label="Commission" value={fmtMoney(commission)} highlight />
        </div>
      </div>
    </div>
  );
}
function CalcResult({ label, value, highlight }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, color: highlight ? "var(--accent)" : "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

// ─── Quick Contact Lookup Widget ─────────────────────────────────────────────
function ContactLookupWidget({ transactions, onOpen }) {
  const [query, setQuery] = useState("");
  // Flatten all contacts across all transactions
  const allContacts = useMemo(() => {
    const list = [];
    transactions.forEach(t => {
      const addr = t.address || "(no address)";
      if (t.sellerName) list.push({ name: t.sellerName, role: "Seller", phone: t.sellerPhone, email: t.sellerEmail, txn: t, context: addr });
      if (t.buyerName)  list.push({ name: t.buyerName,  role: "Buyer",  phone: t.buyerPhone,  email: t.buyerEmail,  txn: t, context: addr });
      CONTACT_ROLES.forEach(role => {
        const c = t.contacts?.[role.key];
        if (c && c.name) list.push({ name: c.name, role: role.label, company: c.company, phone: c.phone, email: c.email, txn: t, context: addr });
      });
    });
    return list;
  }, [transactions]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? allContacts.filter(c =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.company || "").toLowerCase().includes(q) ||
        (c.phone || "").toLowerCase().includes(q) ||
        (c.email || "").toLowerCase().includes(q)
      ).slice(0, 8)
    : [];

  return (
    <div>
      <h2 style={styles.sectionTitle}>Quick Contact Lookup</h2>
      <div style={{ ...styles.todoBoxCard, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 8 }}>
          <Search size={14} style={{ color: "var(--ink-soft)" }} />
          <input type="text" placeholder="Search name, company, phone, email…"
            value={query} onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, border: "none", background: "transparent", fontSize: 13, color: "var(--ink)", outline: "none" }} />
        </div>
        {q && (
          <div style={{ marginTop: 10, maxHeight: 240, overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{ color: "var(--ink-soft)", fontSize: 13, fontStyle: "italic", padding: "8px 4px" }}>No matches.</div>
            ) : filtered.map((c, i) => (
              <div key={i} style={{ padding: "8px 4px", borderBottom: "1px solid var(--ink-line)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{c.name}</div>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)" }}>{c.role}</div>
                </div>
                {c.company && <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{c.company}</div>}
                <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
                  {c.phone && <a href={`tel:${c.phone}`} style={{ fontSize: 12, color: "var(--ink)", textDecoration: "none" }}>📞 {c.phone}</a>}
                  {c.email && <a href={`mailto:${c.email}`} style={{ fontSize: 12, color: "var(--ink)", textDecoration: "none" }}>✉ {c.email}</a>}
                </div>
                <button onClick={() => onOpen(c.txn)} style={{ background: "transparent", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", padding: "2px 0", marginTop: 4 }}>
                  → {c.context}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Habit / Streak Tracker Widget ───────────────────────────────────────────
// ─── Lead Check-Ins Widget ───────────────────────────────────────────────────
// Shows Future Listings + Future Buyers due for check-in within the next 7 days.
// When isCloud, reads from props (live). When local, reads from localStorage.
function CheckInsWidget({ futureListings, futureBuyers, isCloud, onGoToView }) {
  const [localFL, setLocalFL] = useState([]);
  const [localFB, setLocalFB] = useState([]);

  useEffect(() => {
    if (isCloud) return;
    const reload = () => {
      try { const v = localStorage.getItem(FUTURE_LISTINGS_KEY); setLocalFL(v ? JSON.parse(v) : []); } catch (e) { setLocalFL([]); }
      try { const v = localStorage.getItem(FUTURE_BUYERS_KEY); setLocalFB(v ? JSON.parse(v) : []); } catch (e) { setLocalFB([]); }
    };
    reload();
    // Poll occasionally so the widget reflects edits made in other tabs
    const interval = setInterval(reload, 3000);
    return () => clearInterval(interval);
  }, [isCloud]);

  const fl = isCloud ? (futureListings || []) : localFL;
  const fb = isCloud ? (futureBuyers || []) : localFB;
  const leads = getLeadsNeedingCheckIn(fl, fb, 7);

  return (
    <div>
      <div style={styles.sectionTitleRow}>
        <h2 style={styles.sectionTitle}>Check-Ins This Week</h2>
        {leads.length > 0 && (
          <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>{leads.length} due</div>
        )}
      </div>
      <div style={{ background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, overflow: "hidden" }}>
        {leads.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--ink-soft)", fontSize: 13 }}>
            <CheckCircle2 size={18} style={{ color: "var(--ink-soft)", marginBottom: 6, opacity: 0.4 }} /><br/>
            All caught up — no check-ins due this week.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {leads.map(lead => {
              const isListing = lead._leadType === "futureListing";
              const title = isListing ? (lead.address || "(no address)") : (lead.name || "(no name)");
              const subtitle = isListing
                ? (lead.ownerName || "—")
                : (lead.lookingFor || "—");
              return (
                <button
                  key={lead.id}
                  onClick={() => onGoToView(isListing ? "futureListings" : "futureBuyers")}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 14px", border: "none",
                    borderBottom: "1px solid var(--ink-line)",
                    background: "transparent", textAlign: "left", cursor: "pointer",
                    width: "100%",
                  }}
                  data-urgent="true"
                >
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: lead._status.kind === "overdue" || lead._status.kind === "today" ? "var(--accent)"
                              : lead._status.kind === "upcoming" ? "#a86b1f"
                              : "var(--ink-soft)",
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {title}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {isListing ? "Future Listing" : "Future Buyer"} · {subtitle}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: lead._status.color, whiteSpace: "nowrap" }}>
                    {lead._status.label}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HabitsWidget({ isCloud, appSettings, updateSetting }) {
  const [localHabits, setLocalHabits] = useState([]);
  const [newHabitText, setNewHabitText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const todayISO = formatLocalDate(new Date());

  const habits = isCloud ? (appSettings?.habits || []) : localHabits;

  useEffect(() => {
    if (isCloud) { setLoaded(true); return; }
    try { const v = localStorage.getItem(HABITS_KEY); if (v) setLocalHabits(JSON.parse(v)); } catch (e) {}
    setLoaded(true);
  }, [isCloud]);

  const saveHabits = (next) => {
    if (isCloud) {
      updateSetting && updateSetting("habits", next);
    } else {
      setLocalHabits(next);
      try { localStorage.setItem(HABITS_KEY, JSON.stringify(next)); } catch (e) {}
    }
  };

  const addHabit = () => {
    if (!newHabitText.trim()) return;
    saveHabits([...habits, { id: newId(), name: newHabitText.trim(), completedDates: [] }]);
    setNewHabitText("");
  };
  const removeHabit = (id) => saveHabits(habits.filter(h => h.id !== id));
  const toggleToday = (id) => saveHabits(habits.map(h => {
    if (h.id !== id) return h;
    const done = h.completedDates.includes(todayISO);
    return { ...h, completedDates: done ? h.completedDates.filter(d => d !== todayISO) : [...h.completedDates, todayISO] };
  }));

  const calcStreak = (dates) => {
    if (!dates || dates.length === 0) return 0;
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let streak = 0;
    let cursor = new Date(today);
    for (const d of sorted) {
      const dDate = new Date(d + "T00:00:00");
      const diff = Math.round((cursor - dDate) / (1000 * 60 * 60 * 24));
      if (diff === 0) { streak++; cursor.setDate(cursor.getDate() - 1); }
      else if (diff === 1 && streak === 0) { /* yesterday but not today */ break; }
      else if (diff > 0) break;
    }
    return streak;
  };

  return (
    <div>
      <h2 style={styles.sectionTitle}>Habits</h2>
      <div style={styles.todoBoxCard}>
        <div style={styles.todoBoxBody}>
          {habits.length === 0 && (
            <div style={{ color: "var(--ink-soft)", fontSize: 13, fontStyle: "italic", padding: "8px 4px" }}>
              Add a habit to track your streak.
            </div>
          )}
          {habits.map(h => {
            const doneToday = h.completedDates.includes(todayISO);
            const streak = calcStreak(h.completedDates);
            return (
              <div key={h.id} style={styles.todoRow}>
                <button onClick={() => toggleToday(h.id)} style={styles.checkBtn}>
                  {doneToday
                    ? <CheckCircle2 size={16} style={{ color: "var(--accent)" }} />
                    : <Circle size={16} style={{ color: "var(--ink-soft)" }} />}
                </button>
                <div style={{ flex: 1, fontSize: 14, color: doneToday ? "var(--ink-soft)" : "var(--ink)" }}>
                  {h.name}
                </div>
                {streak > 0 && (
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600, color: streak >= 7 ? "var(--accent)" : "var(--ink-soft)" }}>
                    🔥 {streak}
                  </div>
                )}
                <button onClick={() => removeHabit(h.id)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }}>
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div style={styles.todoAddRow}>
          <input type="text" value={newHabitText} onChange={(e) => setNewHabitText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHabit(); } }}
            placeholder="Add a habit (e.g. 5 cold calls)…"
            style={{ ...styles.input, padding: "7px 10px", fontSize: 13 }} />
          <button onClick={addHabit} disabled={!newHabitText.trim()}
            style={{ ...styles.btn, ...styles.btnPrimary, padding: "7px 12px", opacity: newHabitText.trim() ? 1 : 0.5 }}>
            <Plus size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function greetingFor(d) {
  const h = d.getHours();
  if (h < 5)  return "Late night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good evening";
}

function MiniStat({ label, value, highlight }) {
  return (
    <div style={{ ...styles.miniStat, ...(highlight ? styles.miniStatHighlight : {}) }}>
      <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.7 }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function TodoList({ title, items, onChange, placeholder }) {
  const [newText, setNewText] = useState("");
  const add = () => {
    if (!newText.trim()) return;
    onChange([...items, { id: newId(), text: newText.trim(), done: false, created: Date.now() }]);
    setNewText("");
  };
  const toggle = (id) => onChange(items.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const remove = (id) => onChange(items.filter(t => t.id !== id));
  const clearDone = () => onChange(items.filter(t => !t.done));
  const doneCount = items.filter(t => t.done).length;

  return (
    <div style={styles.todoBoxCard}>
      <div style={styles.todoBoxHeader}>
        <h3 style={styles.todoBoxTitle}>{title}</h3>
        {doneCount > 0 && (
          <button onClick={clearDone} style={styles.todoClearBtn}>
            Clear {doneCount} done
          </button>
        )}
      </div>
      <div style={styles.todoBoxBody}>
        {items.length === 0 && (
          <div style={{ color: "var(--ink-soft)", fontSize: 13, fontStyle: "italic", padding: "8px 4px" }}>
            Nothing here yet.
          </div>
        )}
        {items.map(t => (
          <div key={t.id} style={styles.todoRow}>
            <button onClick={() => toggle(t.id)} style={styles.checkBtn}>
              {t.done
                ? <CheckCircle2 size={16} style={{ color: "var(--accent)" }} />
                : <Circle size={16} style={{ color: "var(--ink-soft)" }} />}
            </button>
            <div style={{ flex: 1, fontSize: 14, color: t.done ? "var(--ink-soft)" : "var(--ink)" }}>
              {t.text}
            </div>
            <button onClick={() => remove(t.id)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <div style={styles.todoAddRow}>
        <input
          type="text"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder || "Add a to-do…"}
          style={{ ...styles.input, padding: "7px 10px", fontSize: 13 }}
        />
        <button onClick={add} disabled={!newText.trim()}
          style={{ ...styles.btn, ...styles.btnPrimary, padding: "7px 12px", opacity: newText.trim() ? 1 : 0.5 }}>
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

function WeatherWidget({ data }) {
  if (!data) return <div style={styles.weatherBox}>—</div>;
  if (data.error) return null;
  const cur = data.current;
  const today = data.daily;
  if (!cur || !today) return null;
  const code = cur.weather_code;
  const emoji = weatherEmoji(code);
  return (
    <div style={styles.weatherBox}>
      <div style={{ fontSize: 32 }}>{emoji}</div>
      <div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 500, lineHeight: 1 }}>
          {Math.round(cur.temperature_2m)}°
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
          {Math.round(today.temperature_2m_max[0])}° / {Math.round(today.temperature_2m_min[0])}°
          {today.precipitation_probability_max[0] > 20 && ` · ${today.precipitation_probability_max[0]}% rain`}
        </div>
        <div style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 2 }}>{HOME_LABEL}</div>
      </div>
    </div>
  );
}

function weatherEmoji(code) {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code >= 45 && code <= 48) return "🌫️";
  if (code >= 51 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 95) return "⛈️";
  return "🌥️";
}

function QuickLaunch({ links, onChange, editing }) {
  const [newLink, setNewLink] = useState({ label: "", url: "", icon: "🔗" });
  const [draggedIdx, setDraggedIdx] = useState(null);
  // Tracks links whose favicon failed to load — falls back to emoji
  const [faviconFailed, setFaviconFailed] = useState({});

  const addLink = () => {
    if (!newLink.label.trim() || !newLink.url.trim()) return;
    let url = newLink.url.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    // If the user picked a custom emoji (not the default link icon),
    // start in emoji mode so their emoji actually shows. If they left the
    // default 🔗, use favicon mode so the site logo shows automatically.
    const icon = newLink.icon || "🔗";
    const iconMode = icon !== "🔗" ? "emoji" : "favicon";
    onChange([...links, { id: newId(), label: newLink.label.trim(), url, icon, iconMode, color: "#6b7585" }]);
    setNewLink({ label: "", url: "", icon: "🔗" });
  };
  const removeLink = (id) => onChange(links.filter(l => l.id !== id));
  // Cycles through: favicon → emoji (prompts for new emoji) → favicon
  const cycleIconMode = (id) => {
    const link = links.find(l => l.id === id);
    if (!link) return;
    if (link.iconMode === "favicon") {
      // Switch to emoji mode with current emoji
      onChange(links.map(l => l.id === id ? { ...l, iconMode: "emoji" } : l));
    } else {
      // Already in emoji mode — prompt for new emoji, or switch back to favicon on cancel
      const newEmoji = prompt("Enter an emoji (or leave blank to switch back to website logo):", link.icon || "🔗");
      if (newEmoji === null) return; // cancel
      if (newEmoji.trim() === "") {
        onChange(links.map(l => l.id === id ? { ...l, iconMode: "favicon" } : l));
      } else {
        onChange(links.map(l => l.id === id ? { ...l, icon: newEmoji, iconMode: "emoji" } : l));
      }
    }
  };

  const handleDragStart = (i) => setDraggedIdx(i);
  const handleDragOver = (e, i) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === i) return;
    const next = [...links];
    const [moved] = next.splice(draggedIdx, 1);
    next.splice(i, 0, moved);
    setDraggedIdx(i);
    onChange(next);
  };
  const handleDragEnd = () => setDraggedIdx(null);

  // Render a tile's icon — favicon image if iconMode is "favicon" and it hasn't failed,
  // otherwise the emoji. Both render into a same-sized 32x32 box so they line up
  // visually across tiles regardless of type.
  const renderIcon = (l) => {
    const box = {
      width: 32, height: 32,
      display: "flex", alignItems: "center", justifyContent: "center",
    };
    if (l.iconMode === "favicon" && !faviconFailed[l.id]) {
      const fav = faviconUrl(l.url);
      if (fav) {
        return (
          <div style={box}>
            <img
              src={fav}
              alt=""
              width={28} height={28}
              onError={() => setFaviconFailed(s => ({ ...s, [l.id]: true }))}
              style={{ objectFit: "contain", borderRadius: 6 }}
            />
          </div>
        );
      }
    }
    return <div style={{ ...box, fontSize: 28, lineHeight: 1 }}>{l.icon || "🔗"}</div>;
  };

  return (
    <div>
      <div style={styles.linkGrid}>
        {links.map((l, i) => (
          <div key={l.id}
            draggable={editing}
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
            style={{ position: "relative" }}>
            <a href={l.url} target="_blank" rel="noopener noreferrer"
              style={{ ...styles.linkTile, cursor: editing ? "grab" : "pointer" }}
              onClick={(e) => { if (editing) e.preventDefault(); }}>
              {renderIcon(l)}
              <div style={{ fontSize: 12, fontWeight: 500, color: "var(--ink)", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
                {l.label}
              </div>
            </a>
            {editing && (
              <>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); cycleIconMode(l.id); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  draggable={false}
                  style={styles.linkIconToggleBtn}
                  title={l.iconMode === "favicon" ? "Switch to emoji" : "Change emoji or switch to website logo"}>
                  {l.iconMode === "favicon" ? "😀" : "🌐"}
                </button>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeLink(l.id); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  draggable={false}
                  style={styles.linkRemoveBtn} title="Remove">
                  <X size={10} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <div style={styles.linkAddRow}>
          <input type="text" placeholder="🔗"
            value={newLink.icon} onChange={(e) => setNewLink({ ...newLink, icon: e.target.value })}
            style={{ ...styles.input, padding: "7px 10px", fontSize: 18, width: 54, textAlign: "center" }}
            maxLength={8} title="Tap here and use your keyboard's emoji picker" />
          <input type="text" placeholder="Label (e.g. Zillow)"
            value={newLink.label} onChange={(e) => setNewLink({ ...newLink, label: e.target.value })}
            style={{ ...styles.input, padding: "7px 10px", fontSize: 13, flex: 1, minWidth: 100 }} />
          <input type="text" placeholder="URL"
            value={newLink.url} onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
            style={{ ...styles.input, padding: "7px 10px", fontSize: 13, flex: 2, minWidth: 140 }} />
          <button onClick={addLink}
            disabled={!newLink.label.trim() || !newLink.url.trim()}
            style={{ ...styles.btn, ...styles.btnPrimary, padding: "7px 12px", opacity: (newLink.label.trim() && newLink.url.trim()) ? 1 : 0.5 }}>
            <Plus size={12} /> Add
          </button>
        </div>
      )}
      {editing && (
        <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 10, textAlign: "center" }}>
          Drag tiles to reorder · Click × to remove · "https://" added automatically
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
function Dashboard({ stats, transactions, onOpen }) {
  if (transactions.length === 0) {
    return (
      <div style={styles.welcomeCard}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 32, color: "var(--ink)", marginBottom: 8 }}>
          Welcome.
        </div>
        <p style={{ color: "var(--ink-soft)", maxWidth: 480, lineHeight: 1.6 }}>
          Start by adding a listing you're selling or a buyer you have under contract.
          Drop in a signed contract PDF and Claude pre-fills the entire timeline for you.
        </p>
      </div>
    );
  }

  const urgent = stats.upcoming.filter(u => {
    const lead = u.milestone.reminderDays ?? DEFAULT_REMINDER_DAYS;
    return u.days <= Math.max(lead, 0);
  });

  return (
    <>
      {urgent.length > 0 && (
        <div style={styles.urgentBanner}>
          <div style={styles.urgentHeader}>
            <AlertTriangle size={16} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {urgent.length} {urgent.length === 1 ? "item needs" : "items need"} attention
              </div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                Within each milestone's reminder window. Edit a milestone to change its lead time.
              </div>
            </div>
          </div>
          <div style={styles.urgentList}>
            {urgent.slice(0, 6).map((item, i) => (
              <button key={i} onClick={() => onOpen(item.txn)} style={styles.urgentItem} data-urgent="true">
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{item.milestone.label}</div>
                <div style={{ fontSize: 11, opacity: 0.9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.txn.address || "(no address)"}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                  {item.days < 0 ? `${Math.abs(item.days)}d overdue` :
                   item.days === 0 ? "Today" :
                   item.days === 1 ? "Tomorrow" : `${item.days} days`}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={styles.statsRow}>
        <StatCard label="Active Deals"      value={stats.active}                  accent={false} />
        <StatCard label="Listings"          value={stats.listings}                accent={false} />
        <StatCard label="Buyers"            value={stats.buyers}                  accent={false} />
        <StatCard label="Pipeline Value"    value={fmtMoney(stats.totalVolume)}   accent={true}  />
      </div>
      {stats.estCommission > 0 && (
        <div style={{ marginTop: 14, padding: "12px 18px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10, display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
          <Percent size={14} style={{ color: "var(--accent)" }} />
          <span style={{ color: "var(--ink-soft)" }}>Estimated commission from active pipeline:</span>
          <strong style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
            {fmtMoney(stats.estCommission)}
          </strong>
        </div>
      )}

      <section style={{ marginTop: 40 }}>
        <h2 style={styles.sectionTitle}><Clock size={16} /> Upcoming Deadlines</h2>
        {stats.upcoming.length === 0 ? (
          <div style={styles.emptyHint}>No deadlines in the next 30 days.</div>
        ) : (
          <div style={styles.deadlineList}>
            {stats.upcoming.slice(0, 14).map((item, i) => {
              const lead = item.milestone.reminderDays ?? DEFAULT_REMINDER_DAYS;
              const urgentItem = item.days <= Math.max(lead, 0);
              const overdue = item.days < 0;
              return (
                <button key={i} onClick={() => onOpen(item.txn)} style={styles.deadlineRow}>
                  <div style={{
                    ...styles.daysPill,
                    ...(overdue ? { background: "#a94d4d", color: "var(--paper)" } :
                       urgentItem ? { background: "var(--accent)", color: "var(--paper)" } :
                       { background: "var(--ink-line)", color: "var(--ink)" }),
                  }}>
                    {overdue ? `${Math.abs(item.days)}d late` :
                     item.days === 0 ? "Today" :
                     item.days === 1 ? "Tomorrow" : `${item.days}d`}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.milestone.label}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.txn.address || "(no address)"}
                      {item.txn.sellerName || item.txn.buyerName ? ` · ${lastName(item.txn.sellerName)}${item.txn.sellerName && item.txn.buyerName ? " → " : ""}${lastName(item.txn.buyerName)}` : ""}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums" }}>
                    {fmtDate(item.milestone.date)}
                  </div>
                  <ChevronRight size={16} style={{ color: "var(--ink-soft)" }} />
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section style={{ marginTop: 40 }}>
        <h2 style={styles.sectionTitle}>All Transactions</h2>
        <div style={styles.cardGrid}>
          {(() => {
            // Sort: pending stage first, then active. Within each group, alphabetical by address.
            const sorted = transactions.slice().sort((a, b) => {
              const aPending = isPendingStage(a) ? 0 : 1;
              const bPending = isPendingStage(b) ? 0 : 1;
              if (aPending !== bPending) return aPending - bPending;
              return (a.address || "").localeCompare(b.address || "");
            });
            return sorted.map(t => <TransactionCard key={t.id} txn={t} onClick={() => onOpen(t)} />);
          })()}
        </div>
      </section>
    </>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div style={{ ...styles.statCard, ...(accent ? styles.statCardAccent : {}) }}>
      <div style={{ ...styles.statLabel, color: accent ? "rgba(250,248,243,0.7)" : "var(--ink-soft)" }}>{label}</div>
      <div style={{ ...styles.statValue, color: accent ? "var(--paper)" : "var(--ink)" }}>{value}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TRANSACTION CARD
// ════════════════════════════════════════════════════════════════════════════
function TransactionCard({ txn, onClick }) {
  const status = STATUS_OPTIONS.find(s => s.value === txn.status) || STATUS_OPTIONS[0];
  // Only count real tasks (not informational date references) for progress
  const taskMilestones = txn.milestones.filter(m => !m.informational);
  const completedCount = taskMilestones.filter(m => m.complete).length;
  const totalCount = taskMilestones.length;
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  const nextMilestone = txn.milestones
    .filter(m => m.date && !m.complete && !m.informational)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const partyLabel = txn.sellerName || txn.buyerName
    ? `${lastName(txn.sellerName) || "—"} → ${lastName(txn.buyerName) || "—"}`
    : "No parties yet";

  return (
    <button onClick={onClick} style={styles.card} data-card="true">
      <div style={styles.cardHeader}>
        <div style={{
          ...styles.typePill,
          ...(txn.type === "listing"
            ? { background: "var(--ink)", color: "var(--paper)" }
            : { background: "transparent", color: "var(--ink)", border: "1px solid var(--ink)" }),
        }}>
          {txn.type === "listing" ? "LISTING" : "BUYER"}
        </div>
        <div style={{ ...styles.statusDot, background: status.color }} title={status.label} />
      </div>

      <div style={styles.cardAddress}>
        {txn.address || <span style={{ color: "var(--ink-soft)" }}>No address</span>}
      </div>
      <div style={styles.cardCity}>{[txn.city, txn.state].filter(Boolean).join(", ") || "—"}</div>

      <div style={styles.cardRow}>
        <span style={{ color: "var(--ink-soft)" }}>Parties</span>
        <span style={{ fontWeight: 500 }}>{partyLabel}</span>
      </div>
      <div style={styles.cardRow}>
        <span style={{ color: "var(--ink-soft)" }}>Price</span>
        <span style={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(txn.price)}</span>
      </div>
      {txn.closingDate && (
        <div style={styles.cardRow}>
          <span style={{ color: "var(--ink-soft)" }}>Closes</span>
          <span style={{ fontWeight: 500 }}>{fmtDateShort(txn.closingDate)}</span>
        </div>
      )}
      {txn.type === "listing" && (() => {
        // Show listing expiration date from the informational milestone
        const expMs = (txn.milestones || []).find(m => m.id === "expirationDate");
        if (!expMs || !expMs.date) return null;
        return (
          <div style={styles.cardRow}>
            <span style={{ color: "var(--ink-soft)" }}>Expires</span>
            <span style={{ fontWeight: 500 }}>{fmtDateShort(expMs.date)}</span>
          </div>
        );
      })()}

      <div style={{ marginTop: 14 }}>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressBar, width: `${progressPct}%` }} />
        </div>
        <div style={styles.progressLabel}>
          <span>{completedCount} of {totalCount} milestones</span>
          {nextMilestone && (() => {
            const days = daysUntil(nextMilestone.date);
            const lead = nextMilestone.reminderDays ?? DEFAULT_REMINDER_DAYS;
            return (
              <span style={{ color: days !== null && days <= Math.max(lead, 0) ? "var(--accent)" : "var(--ink-soft)" }}>
                Next: {nextMilestone.label}{days !== null && days >= 0 ? ` · ${days}d` : ""}
              </span>
            );
          })()}
        </div>
      </div>
    </button>
  );
}

function EmptyState({ type, onCreate }) {
  if (type === "closed") {
    return (
      <div style={styles.welcomeCard}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)", marginBottom: 8 }}>
          No closed transactions yet.
        </div>
        <p style={{ color: "var(--ink-soft)", marginBottom: 20 }}>
          Deals marked sold or completed will appear here as a permanent archive.
        </p>
      </div>
    );
  }
  if (type === "buyers") {
    return (
      <div style={styles.welcomeCard}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)", marginBottom: 8 }}>
          No pending transactions.
        </div>
        <p style={{ color: "var(--ink-soft)", marginBottom: 20 }}>
          Transactions under contract appear here. Click "Transfer to Pending" on an active transaction to move it here.
        </p>
      </div>
    );
  }
  // Default — Active Transactions
  return (
    <div style={styles.welcomeCard}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)", marginBottom: 8 }}>
        Nothing here yet.
      </div>
      <p style={{ color: "var(--ink-soft)", marginBottom: 20 }}>Add your first listing to start tracking it.</p>
      <button onClick={onCreate} style={{ ...styles.btn, ...styles.btnPrimary }}>
        <Plus size={14} /> New Listing
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LEAD CHECK-IN — shared logic for Future Listings + Future Buyers
// Cadence-based reminders with auto-rolling next-check-in date.
// ════════════════════════════════════════════════════════════════════════════

const CHECK_IN_CADENCE_OPTIONS = [
  { value: 0, label: "No reminder" },
  { value: 7, label: "Every week" },
  { value: 14, label: "Every 2 weeks" },
  { value: 30, label: "Every month" },
  { value: 60, label: "Every 2 months" },
  { value: 90, label: "Every 3 months" },
  { value: 180, label: "Every 6 months" },
];

// Days between two YYYY-MM-DD strings (positive if a is before b)
function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso + "T00:00:00");
  const b = new Date(bIso + "T00:00:00");
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// Add N days to an ISO date string — uses the addDays() helper defined above
function recalcNextCheckIn(lead) {
  if (!lead.checkInCadenceDays || lead.checkInCadenceDays <= 0) {
    return { ...lead, nextCheckIn: "" };
  }
  const base = lead.lastCheckIn || formatLocalDate(new Date(lead.createdAt || Date.now()));
  return { ...lead, nextCheckIn: addDays(base, lead.checkInCadenceDays) };
}

// Status of a check-in: returns { kind, daysOff, label, color }.
// kind: 'none' | 'upcoming' | 'today' | 'overdue'
function checkInStatus(lead) {
  if (!lead.checkInCadenceDays || !lead.nextCheckIn) {
    return { kind: "none", daysOff: null, label: "", color: "" };
  }
  const today = formatLocalDate(new Date());
  const days = daysBetween(today, lead.nextCheckIn);
  if (days === null) return { kind: "none", daysOff: null, label: "", color: "" };
  if (days < 0) {
    const abs = Math.abs(days);
    return { kind: "overdue", daysOff: days, label: `${abs} day${abs === 1 ? "" : "s"} overdue`, color: "var(--accent)" };
  }
  if (days === 0) {
    return { kind: "today", daysOff: 0, label: "Check in today", color: "var(--accent)" };
  }
  if (days <= 3) {
    return { kind: "upcoming", daysOff: days, label: `Check in ${days} day${days === 1 ? "" : "s"}`, color: "#a86b1f" };
  }
  return { kind: "scheduled", daysOff: days, label: `Check in ${fmtDateShort(lead.nextCheckIn)}`, color: "var(--ink-soft)" };
}

// Small status pill shown on lead cards + the home widget
function CheckInPill({ lead, compact }) {
  const status = checkInStatus(lead);
  if (status.kind === "none") return null;
  const bgByKind = {
    overdue: "rgba(196, 96, 47, 0.12)",
    today: "rgba(196, 96, 47, 0.08)",
    upcoming: "rgba(168, 107, 31, 0.08)",
    scheduled: "var(--paper-soft)",
  };
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: compact ? "2px 6px" : "3px 8px",
      borderRadius: 4,
      background: bgByKind[status.kind] || "var(--paper-soft)",
      color: status.color,
      fontSize: compact ? 10 : 11,
      fontWeight: 600,
      letterSpacing: "0.02em",
    }}>
      {status.kind === "overdue" || status.kind === "today" ? "🔴" : status.kind === "upcoming" ? "🟡" : "🟢"}
      <span>{status.label}</span>
    </div>
  );
}

// Returns all leads (from Future Listings + Future Buyers, local OR cloud)
// that have a check-in due within the next N days OR are overdue.
function getLeadsNeedingCheckIn(futureListings, futureBuyers, windowDays = 7) {
  const all = [];
  futureListings.forEach(l => {
    const status = checkInStatus(l);
    if (status.kind === "overdue" || status.kind === "today" || (status.kind === "upcoming" && status.daysOff <= windowDays) ||
        (status.kind === "scheduled" && status.daysOff <= windowDays)) {
      all.push({ ...l, _leadType: "futureListing", _status: status });
    }
  });
  futureBuyers.forEach(b => {
    const status = checkInStatus(b);
    if (status.kind === "overdue" || status.kind === "today" || (status.kind === "upcoming" && status.daysOff <= windowDays) ||
        (status.kind === "scheduled" && status.daysOff <= windowDays)) {
      all.push({ ...b, _leadType: "futureBuyer", _status: status });
    }
  });
  // Sort: overdue first (most overdue at top), then today, then upcoming by date
  return all.sort((a, b) => {
    const aDays = a._status.daysOff;
    const bDays = b._status.daysOff;
    if (aDays === null) return 1;
    if (bDays === null) return -1;
    return aDays - bDays;
  });
}

// The "Check in" panel rendered inside the lead's edit modal. Includes the
// cadence picker, "I checked in today" button, and history.
function CheckInPanel({ lead, onChange }) {
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");

  const updateCadence = (cadenceDays) => {
    const next = recalcNextCheckIn({ ...lead, checkInCadenceDays: cadenceDays });
    onChange(next);
  };

  const recordCheckIn = (withNote) => {
    const today = formatLocalDate(new Date());
    const entry = { id: newId(), date: today, note: withNote || "" };
    const history = [entry, ...(lead.checkInHistory || [])];
    const updated = recalcNextCheckIn({ ...lead, lastCheckIn: today, checkInHistory: history });
    onChange(updated);
    setShowNote(false);
    setNote("");
  };

  const removeHistoryEntry = (id) => {
    if (!confirm("Remove this check-in entry?")) return;
    onChange({ ...lead, checkInHistory: (lead.checkInHistory || []).filter(h => h.id !== id) });
  };

  const status = checkInStatus(lead);

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
            Check-in cadence
          </div>
          {status.kind !== "none" && <CheckInPill lead={lead} />}
        </div>

        <select
          value={lead.checkInCadenceDays || 0}
          onChange={(e) => updateCadence(parseInt(e.target.value, 10))}
          style={{ ...styles.input, padding: "7px 10px", fontSize: 13 }}
        >
          {CHECK_IN_CADENCE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        {lead.checkInCadenceDays > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={() => recordCheckIn("")}
                style={{ ...styles.btn, ...styles.btnPrimary, padding: "8px 14px", fontSize: 13 }}
                title="Mark check-in done; auto-rolls next-check-in date forward"
              >
                <CheckCircle2 size={13} /> Checked in today
              </button>
              <button
                onClick={() => setShowNote(!showNote)}
                style={{ ...styles.btn, ...styles.btnGhost, padding: "8px 12px", fontSize: 12 }}
              >
                + with note
              </button>
              {lead.lastCheckIn && (
                <span style={{ fontSize: 11, color: "var(--ink-soft)", marginLeft: "auto" }}>
                  Last: {fmtDate(lead.lastCheckIn)}
                </span>
              )}
            </div>
            {showNote && (
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); recordCheckIn(note); } }}
                  placeholder="What was discussed?"
                  style={{ ...styles.input, padding: "7px 10px", fontSize: 13 }}
                  autoFocus
                />
                <button
                  onClick={() => recordCheckIn(note)}
                  style={{ ...styles.btn, ...styles.btnPrimary, padding: "7px 14px", fontSize: 12 }}
                >
                  Save
                </button>
              </div>
            )}
          </div>
        )}

        {(lead.checkInHistory || []).length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--ink-line)" }}>
            <div style={{ fontSize: 11, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 6 }}>
              Check-in history
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
              {(lead.checkInHistory || []).map(h => (
                <div key={h.id} style={{ display: "flex", gap: 10, padding: "6px 8px", background: "var(--paper)", borderRadius: 6, alignItems: "flex-start" }}>
                  <div style={{ fontSize: 11, color: "var(--ink-soft)", whiteSpace: "nowrap", paddingTop: 2, minWidth: 70 }}>
                    {fmtDateShort(h.date)}
                  </div>
                  <div style={{ flex: 1, fontSize: 13, color: "var(--ink)" }}>
                    {h.note || <span style={{ color: "var(--ink-soft)", fontStyle: "italic" }}>(no note)</span>}
                  </div>
                  <button onClick={() => removeHistoryEntry(h.id)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 2, cursor: "pointer" }}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FUTURE LISTINGS — properties you might list (lead pipeline before contract)
// ════════════════════════════════════════════════════════════════════════════
const FUTURE_LISTINGS_KEY = "jct_future_listings";

function FutureListingCountBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const update = () => {
      try {
        const v = localStorage.getItem(FUTURE_LISTINGS_KEY);
        setCount(v ? JSON.parse(v).length : 0);
      } catch (e) { setCount(0); }
    };
    update();
    window.addEventListener("storage", update);
    const interval = setInterval(update, 2000);
    return () => { window.removeEventListener("storage", update); clearInterval(interval); };
  }, []);
  return count > 0 ? <span style={styles.tabCount}>{count}</span> : null;
}

const PROPERTY_TYPE_OPTIONS = [
  "Single Family",
  "Condo",
  "Townhome",
  "Manufactured",
  "Land",
  "Multi-family",
  "Other",
];

function newFutureListing() {
  return {
    id: `fl_${newId()}`,
    address: "", city: "", state: "WA", zip: "",
    ownerName: "", ownerPhone: "", ownerEmail: "",
    referredBy: "",
    estimatedPrice: "",
    targetListDate: "",
    // Property details — all optional. Strings to allow blank vs 0.
    parcelNumber: "",
    propertyType: "",      // Single Family, Condo, Townhome, Manufactured, Land, Multi-family
    yearBuilt: "",
    beds: "",
    baths: "",             // allow decimals like "2.5"
    sqft: "",              // living area
    lotSize: "",           // raw number
    lotUnit: "sqft",       // "sqft" or "acres"
    notes: "",
    checkInCadenceDays: 0,   // 0 = no auto-reminders
    lastCheckIn: "",          // ISO date of most recent check-in
    nextCheckIn: "",          // ISO date (calculated from lastCheckIn + cadence, or manual override)
    checkInHistory: [],       // [{ id, date, note }]
    createdAt: new Date().toISOString(),
  };
}

function FutureListings({ onConvertToListing, cloudItems, onCloudSave, onCloudRemove, isCloud }) {
  const [localItems, setLocalItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const items = isCloud ? cloudItems : localItems;
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (isCloud) { setLoaded(true); return; }
    try { const v = localStorage.getItem(FUTURE_LISTINGS_KEY); if (v) setLocalItems(JSON.parse(v)); } catch (e) {}
    setLoaded(true);
  }, [isCloud]);
  useEffect(() => {
    if (isCloud || !loaded) return;
    try { localStorage.setItem(FUTURE_LISTINGS_KEY, JSON.stringify(localItems)); } catch (e) {}
  }, [localItems, isCloud, loaded]);

  const saveItem = async (item) => {
    if (isCloud) {
      await onCloudSave(item);
    } else {
      const exists = localItems.find(i => i.id === item.id);
      setLocalItems(exists ? localItems.map(i => i.id === item.id ? item : i) : [...localItems, item]);
    }
    setEditing(null);
  };
  const removeItem = async (id) => {
    if (!confirm("Remove this future listing?")) return;
    if (isCloud) {
      await onCloudRemove(id);
    } else {
      setLocalItems(localItems.filter(i => i.id !== id));
    }
    setEditing(null);
  };
  const convertToListing = async (item) => {
    if (!confirm("Convert this to an Active Transaction? The card will be removed from Future Listings and moved to Active Transactions.")) return;

    // Pack any property details into the converted listing's notes so the info
    // isn't lost. Property detail fields live only on Future Listings.
    const detailLines = [];
    if (item.propertyType) detailLines.push(`Type: ${item.propertyType}`);
    if (item.parcelNumber) detailLines.push(`Parcel #: ${item.parcelNumber}`);
    if (item.yearBuilt) detailLines.push(`Year built: ${item.yearBuilt}`);
    if (item.beds) detailLines.push(`Beds: ${item.beds}`);
    if (item.baths) detailLines.push(`Baths: ${item.baths}`);
    if (item.sqft) detailLines.push(`Living sqft: ${item.sqft}`);
    if (item.lotSize) detailLines.push(`Lot: ${item.lotSize} ${item.lotUnit || "sqft"}`);

    const oldNotesLine = item.notes ? `\n\nFrom Future Listings: ${item.notes}` : "";
    const detailsLine = detailLines.length ? `\n\nProperty details:\n${detailLines.join("\n")}` : "";
    const combinedNotes = (detailsLine + oldNotesLine).trim();

    // Remove the future listing entry — the info is being transferred, not copied
    try {
      if (isCloud) {
        await onCloudRemove(item.id);
      } else {
        setLocalItems(prev => {
          const next = prev.filter(i => i.id !== item.id);
          try { localStorage.setItem(FUTURE_LISTINGS_KEY, JSON.stringify(next)); } catch (e) {}
          return next;
        });
      }
    } catch (e) {
      console.error("Couldn't remove future listing:", e);
    }
    setEditing(null);

    onConvertToListing({
      address: item.address, city: item.city, state: item.state, zip: item.zip,
      sellerName: item.ownerName, sellerPhone: item.ownerPhone, sellerEmail: item.ownerEmail,
      listPrice: item.estimatedPrice,
      notes: combinedNotes,
    });
  };

  const filtered = search.trim()
    ? items.filter(i => {
        const q = search.toLowerCase();
        return (i.address || "").toLowerCase().includes(q) ||
               (i.ownerName || "").toLowerCase().includes(q) ||
               (i.city || "").toLowerCase().includes(q);
      })
    : items;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={styles.eyebrow}>Lead Pipeline</div>
          <h1 style={{ ...styles.title, fontSize: 32 }}>Future Listings</h1>
          <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
            Properties you're working on listing — keep tabs on owner conversations before they sign.
          </div>
        </div>
        <button onClick={() => setEditing(newFutureListing())} style={{ ...styles.btn, ...styles.btnPrimary }}>
          <Plus size={14} /> Add Future Listing
        </button>
      </div>

      {items.length > 0 && (
        <div style={styles.searchBar}>
          <Search size={16} style={{ color: "var(--ink-soft)" }} />
          <input type="text" placeholder="Search by address, owner, or city…"
            value={search} onChange={(e) => setSearch(e.target.value)} style={styles.searchInput} />
        </div>
      )}

      {items.length === 0 ? (
        <div style={styles.welcomeCard}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)", marginBottom: 8 }}>
            No future listings yet.
          </div>
          <p style={{ color: "var(--ink-soft)", marginBottom: 20, maxWidth: 420, lineHeight: 1.6 }}>
            Track properties before they're under contract — leads from door-knocking, expired listings, referrals, FSBOs you're courting.
          </p>
          <button onClick={() => setEditing(newFutureListing())} style={{ ...styles.btn, ...styles.btnPrimary }}>
            <Plus size={14} /> Add Future Listing
          </button>
        </div>
      ) : (
        <div style={styles.cardGrid}>
          {filtered.map(item => (
            <button key={item.id} onClick={() => setEditing(item)} style={styles.card} data-card="true">
              <div style={styles.cardHeader}>
                <div style={{ ...styles.typePill, background: "transparent", color: "var(--ink-soft)", border: "1px dashed var(--ink-line)" }}>
                  FUTURE
                </div>
                <CheckInPill lead={item} compact />
              </div>
              <div style={styles.cardAddress}>
                {item.address || <span style={{ color: "var(--ink-soft)" }}>No address</span>}
              </div>
              <div style={styles.cardCity}>{[item.city, item.state].filter(Boolean).join(", ") || "—"}</div>
              {(item.beds || item.baths || item.sqft || item.propertyType) && (
                <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 8, marginTop: -4 }}>
                  {[
                    item.beds && `${item.beds} bd`,
                    item.baths && `${item.baths} ba`,
                    item.sqft && `${Number(item.sqft).toLocaleString()} sqft`,
                    item.propertyType,
                  ].filter(Boolean).join(" · ")}
                </div>
              )}
              <div style={styles.cardRow}>
                <span style={{ color: "var(--ink-soft)" }}>Owner</span>
                <span style={{ fontWeight: 500 }}>{item.ownerName || "—"}</span>
              </div>
              {item.estimatedPrice && (
                <div style={styles.cardRow}>
                  <span style={{ color: "var(--ink-soft)" }}>Est. Price</span>
                  <span style={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(item.estimatedPrice)}</span>
                </div>
              )}
              {item.targetListDate && (
                <div style={styles.cardRow}>
                  <span style={{ color: "var(--ink-soft)" }}>Target</span>
                  <span style={{ fontWeight: 500 }}>{fmtDateShort(item.targetListDate)}</span>
                </div>
              )}
              {item.notes && (
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {item.notes}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <FutureListingModal
          item={editing}
          onClose={() => setEditing(null)}
          onSave={saveItem}
          onRemove={() => removeItem(editing.id)}
          onConvert={() => convertToListing(editing)}
          isNew={!items.find(i => i.id === editing.id)}
        />
      )}
    </>
  );
}

function FutureListingModal({ item, onClose, onSave, onRemove, onConvert, isNew }) {
  const [form, setForm] = useState(item);
  const update = (field, value) => setForm({ ...form, [field]: value });
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Future Listing</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "var(--ink)" }}>
              {isNew ? "New Future Listing" : "Edit Future Listing"}
            </div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          <FormSection title="Property" icon={Home}>
            <Field label="Street Address" full>
              <input type="text" value={form.address} onChange={(e) => update("address", e.target.value)} style={styles.input} />
            </Field>
            <Field label="City"><input type="text" value={form.city} onChange={(e) => update("city", e.target.value)} style={styles.input} /></Field>
            <Field label="State"><input type="text" value={form.state} onChange={(e) => update("state", e.target.value)} style={styles.input} maxLength={2} /></Field>
            <Field label="ZIP"><input type="text" value={form.zip} onChange={(e) => update("zip", e.target.value)} style={styles.input} /></Field>
            <Field label="Estimated List Price">
              <input type="number" value={form.estimatedPrice} onChange={(e) => update("estimatedPrice", e.target.value)} style={styles.input} placeholder="500000" />
            </Field>
            <Field label="Target List Date">
              <input type="date" value={form.targetListDate} onChange={(e) => update("targetListDate", e.target.value)} style={styles.input} />
            </Field>
          </FormSection>

          <FormSection title="Owner / Contact" icon={UserCircle2}>
            <Field label="Owner Name" full>
              <input type="text" value={form.ownerName} onChange={(e) => update("ownerName", e.target.value)} style={styles.input} />
            </Field>
            <Field label="Phone"><input type="tel" value={form.ownerPhone} onChange={(e) => update("ownerPhone", e.target.value)} style={styles.input} /></Field>
            <Field label="Email"><input type="email" value={form.ownerEmail} onChange={(e) => update("ownerEmail", e.target.value)} style={styles.input} /></Field>
            <Field label="Referred By" full>
              <input type="text" value={form.referredBy} onChange={(e) => update("referredBy", e.target.value)} style={styles.input} placeholder="Past client, door-knock, expired listing, referral source…" />
            </Field>
          </FormSection>

          <FormSection title="Property Details" icon={Home}>
            <Field label="Property Type">
              <select value={form.propertyType} onChange={(e) => update("propertyType", e.target.value)} style={styles.input}>
                <option value="">—</option>
                {PROPERTY_TYPE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </Field>
            <Field label="Parcel #">
              <input type="text" value={form.parcelNumber} onChange={(e) => update("parcelNumber", e.target.value)} style={styles.input} placeholder="e.g. 12345-678-901" />
            </Field>
            <Field label="Year Built">
              <input type="number" value={form.yearBuilt} onChange={(e) => update("yearBuilt", e.target.value)} style={styles.input} placeholder="1998" min="1700" max="2100" />
            </Field>
            <Field label="Living Sqft">
              <input type="number" value={form.sqft} onChange={(e) => update("sqft", e.target.value)} style={styles.input} placeholder="1850" min="0" />
            </Field>
            <Field label="Beds">
              <input type="number" value={form.beds} onChange={(e) => update("beds", e.target.value)} style={styles.input} placeholder="3" min="0" max="20" />
            </Field>
            <Field label="Baths">
              <input type="number" value={form.baths} onChange={(e) => update("baths", e.target.value)} style={styles.input} placeholder="2.5" min="0" max="20" step="0.5" />
            </Field>
            <Field label="Lot Size" full>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="number" value={form.lotSize} onChange={(e) => update("lotSize", e.target.value)} style={{ ...styles.input, flex: 1 }} placeholder="7500" min="0" step="0.01" />
                <select value={form.lotUnit || "sqft"} onChange={(e) => update("lotUnit", e.target.value)} style={{ ...styles.input, width: 100 }}>
                  <option value="sqft">sqft</option>
                  <option value="acres">acres</option>
                </select>
              </div>
            </Field>
          </FormSection>

          <FormSection title="Notes" icon={FileText}>
            <Field full>
              <textarea value={form.notes} onChange={(e) => update("notes", e.target.value)}
                style={{ ...styles.input, minHeight: 100, resize: "vertical", fontFamily: "var(--font-body)" }}
                placeholder="Conversation notes, follow-up needs, hesitations, what they want, comp info, anything…" />
            </Field>
          </FormSection>

          <FormSection title="Check-In Reminders" icon={Bell}>
            <Field full>
              <CheckInPanel lead={form} onChange={setForm} />
            </Field>
          </FormSection>
        </div>
        <div style={styles.modalFooter}>
          {!isNew && (
            <button onClick={onRemove} style={{ ...styles.btn, ...styles.btnDanger }}>
              <Trash2 size={14} /> Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          {!isNew && (
            <button onClick={onConvert} style={{ ...styles.btn, ...styles.btnGhost }}>
              <ChevronRight size={14} /> Convert to Listing
            </button>
          )}
          <button onClick={() => onSave(form)} style={{ ...styles.btn, ...styles.btnPrimary }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FUTURE BUYERS — prospective buyers with criteria, lender, financing
// ════════════════════════════════════════════════════════════════════════════
const FUTURE_BUYERS_KEY = "jct_future_buyers";

function FutureBuyerCountBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const update = () => {
      try {
        const v = localStorage.getItem(FUTURE_BUYERS_KEY);
        setCount(v ? JSON.parse(v).length : 0);
      } catch (e) { setCount(0); }
    };
    update();
    window.addEventListener("storage", update);
    const interval = setInterval(update, 2000);
    return () => { window.removeEventListener("storage", update); clearInterval(interval); };
  }, []);
  return count > 0 ? <span style={styles.tabCount}>{count}</span> : null;
}

function newFutureBuyer() {
  return {
    id: `fb_${newId()}`,
    name: "",
    phone: "",
    email: "",
    referredBy: "",
    preApproved: false,
    preApprovalAmount: "",
    downPaymentReady: "",
    financingType: "",
    lender: { name: "", company: "", phone: "", email: "" },
    lookingFor: "",
    notes: "",
    checkInCadenceDays: 0,
    lastCheckIn: "",
    nextCheckIn: "",
    checkInHistory: [],
    createdAt: new Date().toISOString(),
  };
}

function FutureBuyers({ onConvertToBuyer, cloudItems, onCloudSave, onCloudRemove, isCloud }) {
  const [localItems, setLocalItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const items = isCloud ? cloudItems : localItems;
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (isCloud) { setLoaded(true); return; }
    try { const v = localStorage.getItem(FUTURE_BUYERS_KEY); if (v) setLocalItems(JSON.parse(v)); } catch (e) {}
    setLoaded(true);
  }, [isCloud]);
  useEffect(() => {
    if (isCloud || !loaded) return;
    try { localStorage.setItem(FUTURE_BUYERS_KEY, JSON.stringify(localItems)); } catch (e) {}
  }, [localItems, isCloud, loaded]);

  const saveItem = async (item) => {
    if (isCloud) {
      await onCloudSave(item);
    } else {
      const exists = localItems.find(i => i.id === item.id);
      setLocalItems(exists ? localItems.map(i => i.id === item.id ? item : i) : [...localItems, item]);
    }
    setEditing(null);
  };
  const removeItem = async (id) => {
    if (!confirm("Remove this future buyer?")) return;
    if (isCloud) {
      await onCloudRemove(id);
    } else {
      setLocalItems(localItems.filter(i => i.id !== id));
    }
    setEditing(null);
  };
  const convertToBuyer = async (item) => {
    if (!confirm("Convert this to an Active Transaction? The card will be removed from Future Buyers and moved to Active Transactions.")) return;

    // Remove the future buyer entry — the info is being transferred, not copied
    try {
      if (isCloud) {
        await onCloudRemove(item.id);
      } else {
        setLocalItems(prev => {
          const next = prev.filter(i => i.id !== item.id);
          try { localStorage.setItem(FUTURE_BUYERS_KEY, JSON.stringify(next)); } catch (e) {}
          return next;
        });
      }
    } catch (e) {
      console.error("Couldn't remove future buyer:", e);
    }
    setEditing(null);

    onConvertToBuyer({
      buyerName: item.name,
      buyerPhone: item.phone,
      buyerEmail: item.email,
      financing: item.financingType,
      downPayment: item.downPaymentReady,
      contacts: {
        listingBroker: { name: "", company: "", phone: "", email: "" },
        sellingBroker: { name: "", company: "", phone: "", email: "" },
        escrow:        { name: "", company: "", phone: "", email: "" },
        lender:        { ...item.lender },
      },
      notes: item.notes ? `From Future Buyers: ${item.notes}` : "",
    });
  };

  const filtered = search.trim()
    ? items.filter(i => {
        const q = search.toLowerCase();
        return (i.name || "").toLowerCase().includes(q) ||
               (i.email || "").toLowerCase().includes(q) ||
               (i.lookingFor || "").toLowerCase().includes(q);
      })
    : items;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={styles.eyebrow}>Lead Pipeline</div>
          <h1 style={{ ...styles.title, fontSize: 32 }}>Future Buyers</h1>
          <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
            Prospective buyers — track criteria, financing, and lender info while they're shopping.
          </div>
        </div>
        <button onClick={() => setEditing(newFutureBuyer())} style={{ ...styles.btn, ...styles.btnPrimary }}>
          <Plus size={14} /> Add Future Buyer
        </button>
      </div>

      {items.length > 0 && (
        <div style={styles.searchBar}>
          <Search size={16} style={{ color: "var(--ink-soft)" }} />
          <input type="text" placeholder="Search by name, email, or what they're looking for…"
            value={search} onChange={(e) => setSearch(e.target.value)} style={styles.searchInput} />
        </div>
      )}

      {items.length === 0 ? (
        <div style={styles.welcomeCard}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)", marginBottom: 8 }}>
            No future buyers yet.
          </div>
          <p style={{ color: "var(--ink-soft)", marginBottom: 20, maxWidth: 420, lineHeight: 1.6 }}>
            Track buyers from first contact through pre-approval — open houses, referrals, online leads, anyone you're working with.
          </p>
          <button onClick={() => setEditing(newFutureBuyer())} style={{ ...styles.btn, ...styles.btnPrimary }}>
            <Plus size={14} /> Add Future Buyer
          </button>
        </div>
      ) : (
        <div style={styles.cardGrid}>
          {filtered.map(item => (
            <button key={item.id} onClick={() => setEditing(item)} style={styles.card} data-card="true">
              <div style={styles.cardHeader}>
                <div style={{ ...styles.typePill, background: "transparent", color: "var(--ink-soft)", border: "1px dashed var(--ink-line)" }}>
                  FUTURE BUYER
                </div>
                {item.preApproved && (
                  <div style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "rgba(123, 154, 90, 0.15)", color: "#5a7a3a", letterSpacing: "0.05em" }}>
                    PRE-APPROVED
                  </div>
                )}
                <CheckInPill lead={item} compact />
              </div>
              <div style={styles.cardAddress}>
                {item.name || <span style={{ color: "var(--ink-soft)" }}>No name</span>}
              </div>
              {item.preApprovalAmount && (
                <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 10 }}>
                  Pre-approved for <strong style={{ color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{fmtMoney(item.preApprovalAmount)}</strong>
                </div>
              )}
              {item.financingType && (
                <div style={styles.cardRow}>
                  <span style={{ color: "var(--ink-soft)" }}>Financing</span>
                  <span style={{ fontWeight: 500 }}>{item.financingType}</span>
                </div>
              )}
              {item.downPaymentReady && (
                <div style={styles.cardRow}>
                  <span style={{ color: "var(--ink-soft)" }}>Down Ready</span>
                  <span style={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(item.downPaymentReady)}</span>
                </div>
              )}
              {item.lender?.name && (
                <div style={styles.cardRow}>
                  <span style={{ color: "var(--ink-soft)" }}>Lender</span>
                  <span style={{ fontWeight: 500 }}>{item.lender.name}</span>
                </div>
              )}
              {item.lookingFor && (
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  <strong style={{ color: "var(--ink)" }}>Wants:</strong> {item.lookingFor}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <FutureBuyerModal
          item={editing}
          onClose={() => setEditing(null)}
          onSave={saveItem}
          onRemove={() => removeItem(editing.id)}
          onConvert={() => convertToBuyer(editing)}
          isNew={!items.find(i => i.id === editing.id)}
        />
      )}
    </>
  );
}

function FutureBuyerModal({ item, onClose, onSave, onRemove, onConvert, isNew }) {
  const [form, setForm] = useState(item);
  const update = (field, value) => setForm({ ...form, [field]: value });
  const updateLender = (field, value) => setForm({ ...form, lender: { ...form.lender, [field]: value } });
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Future Buyer</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "var(--ink)" }}>
              {isNew ? "New Future Buyer" : "Edit Future Buyer"}
            </div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          <FormSection title="Contact" icon={UserCircle2}>
            <Field label="Name" full>
              <input type="text" value={form.name} onChange={(e) => update("name", e.target.value)} style={styles.input} placeholder="e.g. Jaci and Jared Watson" />
            </Field>
            <Field label="Phone"><input type="tel" value={form.phone} onChange={(e) => update("phone", e.target.value)} style={styles.input} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} style={styles.input} /></Field>
            <Field label="Referred By" full>
              <input type="text" value={form.referredBy} onChange={(e) => update("referredBy", e.target.value)} style={styles.input} placeholder="Past client, open house, online lead, referral source…" />
            </Field>
          </FormSection>

          <FormSection title="Financing" icon={Landmark}>
            <Field label="Status" full>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "8px 12px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 8 }}>
                <input type="checkbox" checked={form.preApproved} onChange={(e) => update("preApproved", e.target.checked)} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>Pre-approved</span>
              </label>
            </Field>
            <Field label="Pre-Approval Amount">
              <input type="number" value={form.preApprovalAmount} onChange={(e) => update("preApprovalAmount", e.target.value)} style={styles.input} placeholder="500000" />
            </Field>
            <Field label="Down Payment Ready">
              <input type="number" value={form.downPaymentReady} onChange={(e) => update("downPaymentReady", e.target.value)} style={styles.input} placeholder="50000" />
            </Field>
            <Field label="Financing Type" full>
              <select value={form.financingType} onChange={(e) => update("financingType", e.target.value)} style={styles.input}>
                <option value="">—</option>
                {FINANCING_TYPES.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
          </FormSection>

          <FormSection title="Lender" icon={Landmark}>
            <Field label="Lender Name">
              <input type="text" value={form.lender.name} onChange={(e) => updateLender("name", e.target.value)} style={styles.input} />
            </Field>
            <Field label="Company">
              <input type="text" value={form.lender.company} onChange={(e) => updateLender("company", e.target.value)} style={styles.input} placeholder="e.g. Fibre Federal" />
            </Field>
            <Field label="Phone">
              <input type="tel" value={form.lender.phone} onChange={(e) => updateLender("phone", e.target.value)} style={styles.input} />
            </Field>
            <Field label="Email">
              <input type="email" value={form.lender.email} onChange={(e) => updateLender("email", e.target.value)} style={styles.input} />
            </Field>
          </FormSection>

          <FormSection title="What They're Looking For" icon={Search}>
            <Field full>
              <textarea value={form.lookingFor} onChange={(e) => update("lookingFor", e.target.value)}
                style={{ ...styles.input, minHeight: 90, resize: "vertical", fontFamily: "var(--font-body)" }}
                placeholder="e.g. 3+ bed, 2 bath, under $500k, Kalama or Longview, fenced yard, no HOA, ready to move in 30 days…" />
            </Field>
          </FormSection>

          <FormSection title="Notes" icon={FileText}>
            <Field full>
              <textarea value={form.notes} onChange={(e) => update("notes", e.target.value)}
                style={{ ...styles.input, minHeight: 90, resize: "vertical", fontFamily: "var(--font-body)" }}
                placeholder="Conversation history, showing notes, hesitations, follow-up needs…" />
            </Field>
          </FormSection>

          <FormSection title="Check-In Reminders" icon={Bell}>
            <Field full>
              <CheckInPanel lead={form} onChange={setForm} />
            </Field>
          </FormSection>
        </div>
        <div style={styles.modalFooter}>
          {!isNew && (
            <button onClick={onRemove} style={{ ...styles.btn, ...styles.btnDanger }}>
              <Trash2 size={14} /> Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          {!isNew && (
            <button onClick={onConvert} style={{ ...styles.btn, ...styles.btnGhost }}>
              <ChevronRight size={14} /> Convert to Buyer Transaction
            </button>
          )}
          <button onClick={() => onSave(form)} style={{ ...styles.btn, ...styles.btnPrimary }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════════════════════
// QUICK ADD FLOATING ACTION BUTTON
// ════════════════════════════════════════════════════════════════════════════
function QuickAddFAB({ open, setOpen, onNewListing, onNewBuyer, onFutureListing, onFutureBuyer, onVendor, onSearch }) {
  return (
    <>
      {open && (
        <div onClick={() => setOpen(false)} style={styles.fabBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={styles.fabMenu}>
            <button onClick={onNewListing} style={styles.fabMenuItem}>
              <Briefcase size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>New Listing Transaction</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Active deal you're listing</div>
              </div>
            </button>
            <button onClick={onNewBuyer} style={styles.fabMenuItem}>
              <Users size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>New Selling Transaction</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Active deal with your buyer</div>
              </div>
            </button>
            <div style={styles.fabDivider} />
            <button onClick={onFutureListing} style={styles.fabMenuItem}>
              <Home size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Future Listing</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Lead — not yet signed</div>
              </div>
            </button>
            <button onClick={onFutureBuyer} style={styles.fabMenuItem}>
              <UserCircle2 size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Future Buyer</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Prospect — not yet under contract</div>
              </div>
            </button>
            <button onClick={onVendor} style={styles.fabMenuItem}>
              <Package size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Vendor</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Inspector, contractor, lender, etc.</div>
              </div>
            </button>
            <div style={styles.fabDivider} />
            <button onClick={onSearch} style={styles.fabMenuItem}>
              <Search size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Search Everything</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Or press ⌘K / Ctrl+K</div>
              </div>
            </button>
          </div>
        </div>
      )}
      <button onClick={() => setOpen(!open)} style={{ ...styles.fab, ...(open ? styles.fabOpen : {}) }} title="Quick add (or ⌘K to search)">
        {open ? <X size={20} /> : <Plus size={20} />}
      </button>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// GLOBAL SEARCH — searches transactions, future listings, future buyers, vendors, contacts
// ════════════════════════════════════════════════════════════════════════════
function GlobalSearch({ transactions, onClose, onOpenTxn, onGoToView }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Load other data sources
  const [futureListings, setFutureListings] = useState([]);
  const [futureBuyers, setFutureBuyers] = useState([]);
  const [vendors, setVendors] = useState([]);
  useEffect(() => {
    try { const v = localStorage.getItem(FUTURE_LISTINGS_KEY); if (v) setFutureListings(JSON.parse(v)); } catch (e) {}
    try { const v = localStorage.getItem(FUTURE_BUYERS_KEY); if (v) setFutureBuyers(JSON.parse(v)); } catch (e) {}
    try { const v = localStorage.getItem(VENDORS_KEY); if (v) setVendors(JSON.parse(v)); } catch (e) {}
  }, []);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const out = { transactions: [], futureListings: [], futureBuyers: [], vendors: [], contacts: [] };
    // Transactions
    transactions.forEach(t => {
      const hay = `${t.address} ${t.city} ${t.sellerName} ${t.buyerName} ${t.notes} ${t.includedItems}`.toLowerCase();
      if (hay.includes(q)) out.transactions.push(t);
    });
    // Future listings
    futureListings.forEach(f => {
      const hay = `${f.address} ${f.city} ${f.ownerName} ${f.ownerPhone} ${f.ownerEmail} ${f.notes} ${f.referredBy}`.toLowerCase();
      if (hay.includes(q)) out.futureListings.push(f);
    });
    // Future buyers
    futureBuyers.forEach(f => {
      const hay = `${f.name} ${f.phone} ${f.email} ${f.lookingFor} ${f.notes} ${f.referredBy} ${f.lender?.name || ""} ${f.lender?.company || ""}`.toLowerCase();
      if (hay.includes(q)) out.futureBuyers.push(f);
    });
    // Vendors
    vendors.forEach(v => {
      const hay = `${v.name} ${v.company} ${v.category} ${v.phone} ${v.email} ${v.notes}`.toLowerCase();
      if (hay.includes(q)) out.vendors.push(v);
    });
    // Contacts inside transactions
    transactions.forEach(t => {
      CONTACT_ROLES.forEach(role => {
        const c = t.contacts?.[role.key];
        if (!c || !c.name) return;
        const hay = `${c.name} ${c.company} ${c.phone} ${c.email}`.toLowerCase();
        if (hay.includes(q)) out.contacts.push({ ...c, role: role.label, txn: t });
      });
    });
    return out;
  }, [q, transactions, futureListings, futureBuyers, vendors]);

  const totalCount = results
    ? results.transactions.length + results.futureListings.length + results.futureBuyers.length + results.vendors.length + results.contacts.length
    : 0;

  return (
    <div style={{ ...styles.modalBackdrop, alignItems: "flex-start", paddingTop: 80 }} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 720, maxHeight: "calc(100vh - 160px)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--ink-line)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Search size={20} style={{ color: "var(--ink-soft)" }} />
            <input ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search transactions, contacts, vendors, notes…"
              style={{ flex: 1, border: "none", background: "transparent", fontSize: 18, color: "var(--ink)", outline: "none", fontFamily: "var(--font-body)" }} />
            <kbd style={styles.kbd}>ESC</kbd>
          </div>
        </div>
        <div style={{ overflowY: "auto", flex: 1, padding: "8px 0" }}>
          {!q && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--ink-soft)", fontSize: 13 }}>
              Type to search across all transactions, future leads, vendors, and contacts.
            </div>
          )}
          {q && totalCount === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--ink-soft)", fontSize: 14 }}>
              No matches for "{query}"
            </div>
          )}
          {results && results.transactions.length > 0 && (
            <SearchGroup label={`Transactions (${results.transactions.length})`}>
              {results.transactions.map(t => (
                <button key={t.id} onClick={() => onOpenTxn(t)} style={styles.searchResult}>
                  <div style={{ ...styles.typePill, background: t.type === "listing" ? "var(--ink)" : "transparent", color: t.type === "listing" ? "var(--paper)" : "var(--ink)", border: t.type === "buyer" ? "1px solid var(--ink)" : "none", flexShrink: 0 }}>
                    {t.type === "listing" ? "LISTING" : "BUYER"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.address || "(no address)"}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                      {[t.sellerName, t.buyerName].filter(Boolean).join(" → ") || "—"}
                    </div>
                  </div>
                </button>
              ))}
            </SearchGroup>
          )}
          {results && results.contacts.length > 0 && (
            <SearchGroup label={`Contacts in transactions (${results.contacts.length})`}>
              {results.contacts.map((c, i) => (
                <button key={i} onClick={() => onOpenTxn(c.txn)} style={styles.searchResult}>
                  <div style={{ fontSize: 16 }}>👤</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{c.name} <span style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 400 }}>· {c.role}</span></div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                      {[c.company, c.phone, c.email].filter(Boolean).join(" · ")} · {c.txn.address?.split(",")[0] || "—"}
                    </div>
                  </div>
                </button>
              ))}
            </SearchGroup>
          )}
          {results && results.futureListings.length > 0 && (
            <SearchGroup label={`Future Listings (${results.futureListings.length})`}>
              {results.futureListings.map(f => (
                <button key={f.id} onClick={() => onGoToView("futureListings")} style={styles.searchResult}>
                  <Home size={16} style={{ color: "var(--ink-soft)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{f.address || f.ownerName || "(no address)"}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{f.ownerName || "—"}</div>
                  </div>
                </button>
              ))}
            </SearchGroup>
          )}
          {results && results.futureBuyers.length > 0 && (
            <SearchGroup label={`Future Buyers (${results.futureBuyers.length})`}>
              {results.futureBuyers.map(f => (
                <button key={f.id} onClick={() => onGoToView("futureBuyers")} style={styles.searchResult}>
                  <UserCircle2 size={16} style={{ color: "var(--ink-soft)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{f.name || "(no name)"}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{f.lookingFor || "—"}</div>
                  </div>
                </button>
              ))}
            </SearchGroup>
          )}
          {results && results.vendors.length > 0 && (
            <SearchGroup label={`Vendors (${results.vendors.length})`}>
              {results.vendors.map(v => (
                <button key={v.id} onClick={() => onGoToView("vendors")} style={styles.searchResult}>
                  <Package size={16} style={{ color: "var(--ink-soft)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{v.name} <span style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 400 }}>· {v.category}</span></div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{[v.company, v.phone].filter(Boolean).join(" · ")}</div>
                  </div>
                </button>
              ))}
            </SearchGroup>
          )}
        </div>
      </div>
    </div>
  );
}
function SearchGroup({ label, children }) {
  return (
    <div>
      <div style={{ padding: "10px 24px 4px", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// VENDORS — standalone phone book of inspectors, contractors, lenders, etc.
// ════════════════════════════════════════════════════════════════════════════
const VENDORS_KEY = "jct_vendors";
const VENDOR_CATEGORIES = [
  "Home Inspector", "Pest Inspector", "Septic Inspector", "Well Inspector",
  "Appraiser", "Lender", "Title / Escrow", "Insurance Agent",
  "Contractor", "Roofer", "Electrician", "Plumber", "HVAC",
  "Landscaper", "Cleaner", "Stager", "Photographer", "Sign Installer",
  "Attorney", "Surveyor", "Painter", "Handyman", "Other",
];

function VendorCountBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const update = () => {
      try { const v = localStorage.getItem(VENDORS_KEY); setCount(v ? JSON.parse(v).length : 0); }
      catch (e) { setCount(0); }
    };
    update();
    const interval = setInterval(update, 2000);
    return () => clearInterval(interval);
  }, []);
  return count > 0 ? <span style={styles.tabCount}>{count}</span> : null;
}

function newVendor() {
  return {
    id: `v_${newId()}`,
    name: "", company: "", category: "",
    phone: "", email: "", address: "",
    rating: 0, notes: "",
    createdAt: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TO-DOS — dedicated tab with multiple named lists + per-item reminders
// ════════════════════════════════════════════════════════════════════════════
const TODO_LISTS_KEY = "jct_todo_lists_v1";

const TODO_FREQUENCY_OPTIONS = [
  { value: 1, label: "Every day" },
  { value: 3, label: "Every 3 days" },
  { value: 7, label: "Every week" },
  { value: 14, label: "Every 2 weeks" },
  { value: 30, label: "Every month" },
];

// Calculate when the next reminder should fire for a to-do item.
// Returns ISO date string or "" if no active reminder.
function calcNextReminder(todo) {
  if (!todo.reminderType || todo.reminderType === "none") return "";
  if (todo.reminderType === "date") {
    return todo.reminderDate || "";
  }
  if (todo.reminderType === "frequency" && todo.reminderDays > 0) {
    const base = todo.lastReminded || todo.createdAt?.split("T")[0] || formatLocalDate(new Date());
    return addDays(base, todo.reminderDays);
  }
  return "";
}

// Status: { kind: 'none' | 'overdue' | 'today' | 'upcoming' | 'scheduled', label, color, days }
function todoReminderStatus(todo) {
  const next = calcNextReminder(todo);
  if (!next || todo.complete) return { kind: "none", label: "", color: "", days: null };
  const today = formatLocalDate(new Date());
  const days = daysBetween(today, next);
  if (days === null) return { kind: "none", label: "", color: "", days: null };
  if (days < 0) {
    const abs = Math.abs(days);
    return { kind: "overdue", days, label: `${abs}d overdue`, color: "var(--accent)" };
  }
  if (days === 0) return { kind: "today", days, label: "Today", color: "var(--accent)" };
  if (days <= 3) return { kind: "upcoming", days, label: `In ${days}d`, color: "#a86b1f" };
  return { kind: "scheduled", days, label: fmtDateShort(next), color: "var(--ink-soft)" };
}

// Aggregates due/overdue/upcoming reminders across all lists, for the home widget.
function collectDueReminders(lists, windowDays = 7) {
  const all = [];
  (lists || []).forEach(list => {
    (list.items || []).forEach(item => {
      const status = todoReminderStatus(item);
      if (status.kind === "overdue" || status.kind === "today" || (status.days !== null && status.days <= windowDays)) {
        all.push({ list, item, status });
      }
    });
  });
  return all.sort((a, b) => (a.status.days ?? 9999) - (b.status.days ?? 9999));
}

function TodosTab({ isCloud, cloudItems, onCloudSave, onCloudRemove }) {
  const [localLists, setLocalLists] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [newListName, setNewListName] = useState("");

  // In cloud mode, the source of truth is the cloudItems prop (kept in sync
  // by the parent via realtime subscription). In local mode, we manage our
  // own state and persist to localStorage.
  // Sort lists by their sortOrder (falls back to createdAt for legacy lists
  // without sortOrder, ensuring stable predictable ordering).
  const listsRaw = isCloud ? (cloudItems || []) : localLists;
  const lists = useMemo(() => {
    return listsRaw.slice().sort((a, b) => {
      const aOrder = a.sortOrder ?? new Date(a.createdAt || 0).getTime();
      const bOrder = b.sortOrder ?? new Date(b.createdAt || 0).getTime();
      return aOrder - bOrder;
    });
  }, [listsRaw]);

  useEffect(() => {
    if (isCloud) { setLoaded(true); return; }
    try {
      const stored = localStorage.getItem(TODO_LISTS_KEY);
      if (stored) setLocalLists(JSON.parse(stored));
    } catch (e) {}
    setLoaded(true);
  }, [isCloud]);

  // Auto-save local mode changes
  useEffect(() => {
    if (isCloud || !loaded) return;
    try { localStorage.setItem(TODO_LISTS_KEY, JSON.stringify(localLists)); } catch (e) {}
  }, [localLists, isCloud, loaded]);

  // Universal save handler — picks the right path based on mode
  const saveList = async (updated) => {
    if (isCloud) {
      try { await onCloudSave(updated); }
      catch (e) { console.error("Cloud save failed:", e); alert("Couldn't save to cloud: " + (e.message || "")); }
    } else {
      setLocalLists(prev => {
        const exists = prev.find(l => l.id === updated.id);
        const next = exists ? prev.map(l => l.id === updated.id ? updated : l) : [...prev, updated];
        try { localStorage.setItem(TODO_LISTS_KEY, JSON.stringify(next)); } catch (e) {}
        return next;
      });
    }
  };

  const addList = async () => {
    const name = newListName.trim();
    if (!name) return;
    // New lists get the highest sortOrder so they appear at the bottom
    const maxOrder = lists.reduce((max, l) => Math.max(max, l.sortOrder ?? 0), 0);
    const newList = {
      id: newId(), name, createdAt: new Date().toISOString(),
      items: [], sortOrder: maxOrder + 1,
    };
    await saveList(newList);
    setNewListName("");
  };

  // Move a list up or down. Reassigns sortOrder values so ordering is
  // always explicit and deterministic, even for lists that had no sortOrder
  // before (older lists created before this feature existed).
  const moveList = async (id, direction) => {
    const idx = lists.findIndex(l => l.id === id);
    if (idx === -1) return;
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= lists.length) return;

    // Build the reordered array
    const newOrder = [...lists];
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];

    // Assign explicit sortOrder to every list based on its new position.
    // Using gaps of 1000 leaves room for future insertions without renumbering.
    // Save each list whose sortOrder actually needs to change.
    for (let i = 0; i < newOrder.length; i++) {
      const list = newOrder[i];
      const desiredOrder = (i + 1) * 1000;
      if (list.sortOrder !== desiredOrder) {
        await saveList({ ...list, sortOrder: desiredOrder });
      }
    }
  };

  // Move a to-do item from one list to another
  const moveItem = async (itemId, fromListId, toListId) => {
    if (fromListId === toListId) return;
    const fromList = lists.find(l => l.id === fromListId);
    const toList = lists.find(l => l.id === toListId);
    if (!fromList || !toList) return;
    const item = (fromList.items || []).find(i => i.id === itemId);
    if (!item) return;
    // Remove from source
    const updatedFrom = { ...fromList, items: (fromList.items || []).filter(i => i.id !== itemId) };
    // Add to destination
    const updatedTo = { ...toList, items: [...(toList.items || []), item] };
    await saveList(updatedFrom);
    await saveList(updatedTo);
  };

  const removeList = async (id) => {
    if (!confirm("Delete this list and all its to-dos?")) return;
    if (isCloud) {
      try { await onCloudRemove(id); }
      catch (e) { alert("Couldn't delete from cloud: " + (e.message || "")); }
    } else {
      setLocalLists(prev => {
        const next = prev.filter(l => l.id !== id);
        try { localStorage.setItem(TODO_LISTS_KEY, JSON.stringify(next)); } catch (e) {}
        return next;
      });
    }
  };

  const renameList = async (id) => {
    const list = lists.find(l => l.id === id);
    if (!list) return;
    const name = prompt("Rename list:", list.name);
    if (!name || name.trim() === list.name) return;
    await saveList({ ...list, name: name.trim() });
  };

  const updateList = async (id, updates) => {
    const existing = lists.find(l => l.id === id);
    if (!existing) return;
    await saveList({ ...existing, ...updates });
  };

  if (!loaded) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20 }}>
        <div>
          <h1 style={{ ...styles.pageTitle, marginBottom: 4 }}>To-Dos</h1>
          <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            {lists.length === 0 ? "No lists yet. Create your first one below." : `${lists.length} list${lists.length === 1 ? "" : "s"}`}
            {isCloud && <span style={{ marginLeft: 8, color: "var(--accent)" }}> · ☁ Syncs across devices</span>}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          value={newListName}
          onChange={(e) => setNewListName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addList(); } }}
          placeholder="New list name (e.g. Follow-ups, This Week, Personal…)"
          style={{ ...styles.input, flex: 1 }}
        />
        <button onClick={addList} style={{ ...styles.btn, ...styles.btnPrimary }}>
          <Plus size={14} /> Add List
        </button>
      </div>

      {lists.map((list, idx) => (
        <TodoListBlock
          key={list.id}
          list={list}
          allLists={lists}
          isFirst={idx === 0}
          isLast={idx === lists.length - 1}
          onUpdate={(updates) => updateList(list.id, updates)}
          onRemove={() => removeList(list.id)}
          onRename={() => renameList(list.id)}
          onMoveUp={() => moveList(list.id, -1)}
          onMoveDown={() => moveList(list.id, +1)}
          onMoveItem={(itemId, toListId) => moveItem(itemId, list.id, toListId)}
        />
      ))}

      {lists.length === 0 && (
        <div style={{ padding: "60px 20px", textAlign: "center", color: "var(--ink-soft)", background: "var(--paper-soft)", border: "1px dashed var(--ink-line)", borderRadius: 12 }}>
          <CheckCircle2 size={28} style={{ opacity: 0.3, marginBottom: 10 }} /><br/>
          Create a list above to get started. Each list can hold to-dos with optional reminders.
        </div>
      )}
    </div>
  );
}

function TodoListBlock({ list, allLists, isFirst, isLast, onUpdate, onRemove, onRename, onMoveUp, onMoveDown, onMoveItem }) {
  const [newItemText, setNewItemText] = useState("");
  const [editingReminder, setEditingReminder] = useState(null); // item id or null
  const [movingItemId, setMovingItemId] = useState(null); // item id or null

  const addItem = () => {
    const text = newItemText.trim();
    if (!text) return;
    const newItem = {
      id: newId(),
      text,
      complete: false,
      reminderType: "none",
      reminderDays: 0,
      reminderDate: "",
      lastReminded: "",
      createdAt: new Date().toISOString(),
    };
    onUpdate({ items: [...(list.items || []), newItem] });
    setNewItemText("");
  };

  const updateItem = (id, updates) => {
    onUpdate({ items: list.items.map(i => i.id === id ? { ...i, ...updates } : i) });
  };

  const removeItem = (id) => {
    onUpdate({ items: list.items.filter(i => i.id !== id) });
  };

  const toggleComplete = (id) => {
    const item = list.items.find(i => i.id === id);
    updateItem(id, { complete: !item.complete });
  };

  const editItemText = (id) => {
    const item = list.items.find(i => i.id === id);
    const text = prompt("Edit to-do:", item.text);
    if (text && text.trim() !== item.text) updateItem(id, { text: text.trim() });
  };

  const activeItems = (list.items || []).filter(i => !i.complete);
  const doneItems = (list.items || []).filter(i => i.complete);
  // Other lists to move items to (excludes this list)
  const otherLists = (allLists || []).filter(l => l.id !== list.id);

  return (
    <div style={{ background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, padding: 18, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600, color: "var(--ink)", margin: 0 }}>
          {list.name}
          <span style={{ color: "var(--ink-soft)", fontSize: 13, fontWeight: 400, marginLeft: 8 }}>
            {activeItems.length} active{doneItems.length > 0 ? ` · ${doneItems.length} done` : ""}
          </span>
        </h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={onMoveUp} disabled={isFirst}
            style={{ background: "transparent", border: "none", color: isFirst ? "var(--ink-line)" : "var(--ink-soft)", padding: 6, cursor: isFirst ? "not-allowed" : "pointer" }}
            title="Move list up">
            ▲
          </button>
          <button onClick={onMoveDown} disabled={isLast}
            style={{ background: "transparent", border: "none", color: isLast ? "var(--ink-line)" : "var(--ink-soft)", padding: 6, cursor: isLast ? "not-allowed" : "pointer" }}
            title="Move list down">
            ▼
          </button>
          <button onClick={onRename} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 6, cursor: "pointer" }} title="Rename list">
            <Edit3 size={14} />
          </button>
          <button onClick={onRemove} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 6, cursor: "pointer" }} title="Delete list">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
        {activeItems.map(item => (
          <div key={item.id}>
            <TodoItem
              item={item}
              onToggle={() => toggleComplete(item.id)}
              onEdit={() => editItemText(item.id)}
              onRemove={() => removeItem(item.id)}
              onSetReminder={(updates) => updateItem(item.id, updates)}
              reminderOpen={editingReminder === item.id}
              onToggleReminder={() => setEditingReminder(editingReminder === item.id ? null : item.id)}
              canMove={otherLists.length > 0}
              onMoveClick={() => setMovingItemId(movingItemId === item.id ? null : item.id)}
            />
            {movingItemId === item.id && otherLists.length > 0 && (
              <div style={{
                marginLeft: 40, marginTop: 4, marginBottom: 4, padding: 8,
                background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 8
              }}>
                <div style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Move to list
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {otherLists.map(l => (
                    <button
                      key={l.id}
                      onClick={() => { onMoveItem(item.id, l.id); setMovingItemId(null); }}
                      style={{
                        fontSize: 12, padding: "4px 10px", borderRadius: 4,
                        border: "1px solid var(--ink-line)", background: "var(--paper)",
                        color: "var(--ink)", cursor: "pointer",
                      }}>
                      {l.name}
                    </button>
                  ))}
                  <button
                    onClick={() => setMovingItemId(null)}
                    style={{
                      fontSize: 12, padding: "4px 10px", borderRadius: 4,
                      border: "none", background: "transparent",
                      color: "var(--ink-soft)", cursor: "pointer",
                    }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={newItemText}
          onChange={(e) => setNewItemText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
          placeholder="Add a to-do…"
          style={{ ...styles.input, flex: 1, fontSize: 13 }}
        />
        <button onClick={addItem} style={{ ...styles.btn, ...styles.btnGhost, padding: "6px 10px" }}>
          <Plus size={14} />
        </button>
      </div>

      {doneItems.length > 0 && (
        <details style={{ marginTop: 14, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--ink-soft)", padding: "6px 0" }}>
            Show completed ({doneItems.length})
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {doneItems.map(item => (
              <TodoItem
                key={item.id}
                item={item}
                onToggle={() => toggleComplete(item.id)}
                onEdit={() => editItemText(item.id)}
                onRemove={() => removeItem(item.id)}
                onSetReminder={(updates) => updateItem(item.id, updates)}
                reminderOpen={false}
                onToggleReminder={() => {}}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function TodoItem({ item, onToggle, onEdit, onRemove, onSetReminder, reminderOpen, onToggleReminder, canMove, onMoveClick }) {
  const status = todoReminderStatus(item);

  return (
    <div style={{ background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="checkbox"
          checked={item.complete}
          onChange={onToggle}
          style={{ cursor: "pointer", width: 16, height: 16, flexShrink: 0 }}
        />
        <span
          onClick={onEdit}
          style={{ flex: 1, fontSize: 14, color: "var(--ink)", cursor: "pointer", opacity: item.complete ? 0.55 : 1 }}
          title="Click to edit"
        >
          {item.text}
        </span>
        {status.kind !== "none" && (
          <span style={{ fontSize: 11, fontWeight: 600, color: status.color, padding: "2px 7px", borderRadius: 4, background: status.kind === "overdue" || status.kind === "today" ? "rgba(196, 96, 47, 0.1)" : "var(--paper-soft)", whiteSpace: "nowrap" }}>
            🔔 {status.label}
          </span>
        )}
        <button onClick={onToggleReminder} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }} title="Set reminder">
          <Bell size={13} />
        </button>
        {canMove && (
          <button onClick={onMoveClick} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer", fontSize: 13 }} title="Move to another list">
            ↔
          </button>
        )}
        <button onClick={onRemove} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }} title="Delete">
          <X size={13} />
        </button>
      </div>

      {reminderOpen && (
        <div style={{ marginTop: 10, padding: 10, background: "var(--paper-soft)", borderRadius: 6, fontSize: 12 }}>
          <div style={{ marginBottom: 8, fontWeight: 600, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10 }}>Reminder</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => onSetReminder({ reminderType: "none", reminderDays: 0, reminderDate: "" })}
              style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid var(--ink-line)", background: item.reminderType === "none" ? "var(--ink)" : "var(--paper)", color: item.reminderType === "none" ? "var(--paper)" : "var(--ink)", cursor: "pointer", fontSize: 12 }}
            >
              None
            </button>
            <button
              onClick={() => onSetReminder({ reminderType: "date", reminderDays: 0 })}
              style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid var(--ink-line)", background: item.reminderType === "date" ? "var(--ink)" : "var(--paper)", color: item.reminderType === "date" ? "var(--paper)" : "var(--ink)", cursor: "pointer", fontSize: 12 }}
            >
              Specific date
            </button>
            <button
              onClick={() => onSetReminder({ reminderType: "frequency", reminderDate: "" })}
              style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid var(--ink-line)", background: item.reminderType === "frequency" ? "var(--ink)" : "var(--paper)", color: item.reminderType === "frequency" ? "var(--paper)" : "var(--ink)", cursor: "pointer", fontSize: 12 }}
            >
              Recurring
            </button>
          </div>

          {item.reminderType === "date" && (
            <input
              type="date"
              value={item.reminderDate || ""}
              onChange={(e) => onSetReminder({ reminderDate: e.target.value })}
              style={{ ...styles.input, fontSize: 13, padding: "6px 8px" }}
            />
          )}

          {item.reminderType === "frequency" && (
            <select
              value={item.reminderDays || 7}
              onChange={(e) => onSetReminder({ reminderDays: parseInt(e.target.value, 10) })}
              style={{ ...styles.input, fontSize: 13, padding: "6px 8px" }}
            >
              {TODO_FREQUENCY_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Home widget: To-Do Reminders ────────────────────────────────────────────
function TodoRemindersWidget({ onGoToView, isCloud, cloudItems, onCloudSave }) {
  const [localLists, setLocalLists] = useState([]);

  // In cloud mode, use the cloudItems prop (kept fresh by realtime sub).
  // In local mode, poll localStorage so changes from the To-Dos tab show up.
  const lists = isCloud ? (cloudItems || []) : localLists;

  useEffect(() => {
    if (isCloud) return;
    const reload = () => {
      try {
        const stored = localStorage.getItem(TODO_LISTS_KEY);
        setLocalLists(stored ? JSON.parse(stored) : []);
      } catch (e) { setLocalLists([]); }
    };
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [isCloud]);

  const due = collectDueReminders(lists, 7);

  // Acknowledge a recurring reminder — bumps lastReminded so nextReminder rolls forward
  const acknowledge = async (listId, itemId) => {
    const today = formatLocalDate(new Date());
    const targetList = lists.find(l => l.id === listId);
    if (!targetList) return;
    const updatedItems = targetList.items.map(i => i.id !== itemId ? i : (
      i.reminderType === "frequency" ? { ...i, lastReminded: today } : { ...i, reminderType: "none" }
    ));
    const updatedList = { ...targetList, items: updatedItems };

    if (isCloud) {
      try { await onCloudSave(updatedList); }
      catch (e) { console.error("Cloud save failed:", e); alert("Couldn't update reminder: " + (e.message || "")); }
    } else {
      const next = lists.map(l => l.id === listId ? updatedList : l);
      setLocalLists(next);
      try { localStorage.setItem(TODO_LISTS_KEY, JSON.stringify(next)); } catch (e) {}
    }
  };

  return (
    <div>
      <div style={styles.sectionTitleRow}>
        <h2 style={styles.sectionTitle}>To-Do Reminders</h2>
        {due.length > 0 && <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>{due.length} due</div>}
      </div>
      <div style={{ background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, overflow: "hidden" }}>
        {due.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--ink-soft)", fontSize: 13 }}>
            <CheckCircle2 size={18} style={{ opacity: 0.4, marginBottom: 6 }} /><br/>
            No reminders due. Set reminders in the To-Dos tab.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {due.map(({ list, item, status }) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--ink-line)" }}>
                <div style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: status.kind === "overdue" || status.kind === "today" ? "var(--accent)" : status.kind === "upcoming" ? "#a86b1f" : "var(--ink-soft)",
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.text}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                    {list.name} · {status.label}
                  </div>
                </div>
                <button
                  onClick={() => acknowledge(list.id, item.id)}
                  style={{ ...styles.btn, ...styles.btnGhost, padding: "3px 9px", fontSize: 11 }}
                  title={item.reminderType === "frequency" ? "Mark done for now — reminder will roll forward" : "Dismiss reminder"}
                >
                  Done
                </button>
              </div>
            ))}
            <button
              onClick={() => onGoToView && onGoToView("todos")}
              style={{ padding: "8px 14px", border: "none", background: "transparent", color: "var(--ink-soft)", fontSize: 12, cursor: "pointer", textAlign: "center" }}
            >
              Open To-Dos tab →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Formats a vendor's contact info for copy-paste into email/text.
function formatVendorContact(v) {
  const lines = [];
  if (v.name) lines.push(v.name);
  if (v.company) lines.push(v.company);
  if (v.phone) lines.push(v.phone);
  if (v.email) lines.push(v.email);
  return lines.join("\n");
}

// Formats multiple vendors as one combined block.
function formatVendorContactList(vendors) {
  return vendors.map(formatVendorContact).join("\n\n———\n\n");
}

// Modal that pops up showing vendor contact info ready to copy.
// Shows a big textarea pre-selected, plus a Copy button.
function VendorSendModal({ vendors, onClose }) {
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef(null);
  const text = formatVendorContactList(vendors);

  // Auto-select the textarea content when the modal opens so user can
  // just hit Cmd/Ctrl+C immediately.
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch (e) {
      // Fallback: tell the user to copy manually from the textarea
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.select();
      }
      alert("Clipboard access blocked — please press Cmd+C (or Ctrl+C) to copy the highlighted text.");
    }
  };

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Vendor Contacts</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--ink)" }}>
              {vendors.length === 1 ? "Send Contact" : `Send ${vendors.length} Contacts`}
            </div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 10 }}>
            The contact info is ready below. Tap "Copy to Clipboard" or select the text and copy manually, then paste into your email or text.
          </div>
          <textarea
            ref={textareaRef}
            readOnly
            value={text}
            style={{
              ...styles.input,
              minHeight: 220,
              fontFamily: "var(--font-body)",
              fontSize: 13,
              lineHeight: 1.5,
              resize: "vertical",
            }}
            onClick={(e) => e.target.select()}
          />
        </div>
        <div style={styles.modalFooter}>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ ...styles.btn, ...styles.btnGhost }}>Close</button>
          <button
            onClick={handleCopy}
            style={{
              ...styles.btn,
              ...styles.btnPrimary,
              background: copied ? "var(--accent)" : undefined,
            }}
          >
            {copied ? <><CheckCircle2 size={14} /> Copied!</> : <><Send size={14} /> Copy to Clipboard</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline "Send" button on each vendor card. Click → opens the popup with this vendor.
function SendVendorButton({ vendor }) {
  const [showModal, setShowModal] = useState(false);

  const handleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    setShowModal(true);
  };

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleClick(e); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "4px 10px", fontSize: 11, fontWeight: 500,
          borderRadius: 6, border: "1px solid var(--ink-line)",
          background: "var(--paper)",
          color: "var(--ink)",
          cursor: "pointer", userSelect: "none",
        }}
        title="Show contact info to copy/send"
      >
        <Send size={11} /> Send
      </span>
      {showModal && <VendorSendModal vendors={[vendor]} onClose={() => setShowModal(false)} />}
    </>
  );
}

function Vendors({ cloudItems, onCloudSave, onCloudRemove, isCloud }) {
  const [localItems, setLocalItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const items = isCloud ? cloudItems : localItems;
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => {
    if (isCloud) { setLoaded(true); return; }
    try { const v = localStorage.getItem(VENDORS_KEY); if (v) setLocalItems(JSON.parse(v)); } catch (e) {}
    setLoaded(true);
  }, [isCloud]);
  useEffect(() => {
    if (isCloud || !loaded) return;
    try { localStorage.setItem(VENDORS_KEY, JSON.stringify(localItems)); } catch (e) {}
  }, [localItems, isCloud, loaded]);

  const saveItem = async (v) => {
    if (isCloud) {
      await onCloudSave(v);
    } else {
      // Functional update to avoid stale closures
      setLocalItems(prev => {
        const exists = prev.find(i => i.id === v.id);
        const next = exists ? prev.map(i => i.id === v.id ? v : i) : [...prev, v];
        // Save immediately for reliability
        try { localStorage.setItem(VENDORS_KEY, JSON.stringify(next)); } catch (e) {}
        return next;
      });
    }
    setEditing(null);
  };
  const removeItem = async (id) => {
    if (!confirm("Remove this vendor?")) return;
    if (isCloud) {
      await onCloudRemove(id);
    } else {
      // Functional update + immediate save — avoids any stale state issues
      setLocalItems(prev => {
        const next = prev.filter(i => i.id !== id);
        try { localStorage.setItem(VENDORS_KEY, JSON.stringify(next)); } catch (e) {}
        return next;
      });
    }
    // Also remove from selection if it was selected
    setSelectedIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEditing(null);
  };

  // ─── Multi-select helpers ──────────────────────────────────────────────
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const selectedVendors = items.filter(v => selectedIds.has(v.id));

  // Open the contact popup with multiple selected vendors.
  const [showBulkSendModal, setShowBulkSendModal] = useState(false);
  const sendSelected = () => {
    if (selectedVendors.length === 0) return;
    setShowBulkSendModal(true);
  };

  const filtered = items.filter(v => {
    if (filterCat && v.category !== filterCat) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (v.name + " " + v.company + " " + v.category + " " + v.phone + " " + v.email + " " + v.notes).toLowerCase().includes(q);
  });

  // Group by category
  const grouped = useMemo(() => {
    const g = {};
    filtered.forEach(v => {
      const cat = v.category || "Uncategorized";
      if (!g[cat]) g[cat] = [];
      g[cat].push(v);
    });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={styles.eyebrow}>Phone Book</div>
          <h1 style={{ ...styles.title, fontSize: 32 }}>Vendors</h1>
          <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
            Inspectors, lenders, contractors — your trusted referrals in one place.
          </div>
        </div>
        <button onClick={() => setEditing(newVendor())} style={{ ...styles.btn, ...styles.btnPrimary }}>
          <Plus size={14} /> Add Vendor
        </button>
      </div>

      {items.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
          <div style={{ ...styles.searchBar, flex: 1, minWidth: 240, marginBottom: 0 }}>
            <Search size={16} style={{ color: "var(--ink-soft)" }} />
            <input type="text" placeholder="Search vendors…" value={search}
              onChange={(e) => setSearch(e.target.value)} style={styles.searchInput} />
          </div>
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}
            style={{ ...styles.input, width: "auto", minWidth: 160 }}>
            <option value="">All categories</option>
            {VENDOR_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      {items.length === 0 ? (
        <div style={styles.welcomeCard}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)", marginBottom: 8 }}>
            No vendors yet.
          </div>
          <p style={{ color: "var(--ink-soft)", marginBottom: 20, maxWidth: 420, lineHeight: 1.6 }}>
            Build your phone book of trusted inspectors, contractors, lenders, and other vendors you refer regularly.
          </p>
          <button onClick={() => setEditing(newVendor())} style={{ ...styles.btn, ...styles.btnPrimary }}>
            <Plus size={14} /> Add Vendor
          </button>
        </div>
      ) : (
        <div>
          {grouped.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 28 }}>
              <h2 style={{ ...styles.sectionTitle, fontSize: 16, color: "var(--ink-soft)" }}>{cat}</h2>
              <div style={styles.cardGrid}>
                {list.map(v => {
                  const isSelected = selectedIds.has(v.id);
                  return (
                  <div key={v.id} style={{ position: "relative" }}>
                    <button onClick={() => setEditing(v)} style={{ ...styles.card, paddingTop: 32, ...(isSelected ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" } : {}) }} data-card="true">
                      <div style={styles.cardAddress}>{v.name || "(no name)"}</div>
                      {v.company && <div style={styles.cardCity}>{v.company}</div>}
                      {v.phone && (
                        <a href={`tel:${v.phone}`} onClick={(e) => e.stopPropagation()}
                          style={{ display: "block", marginTop: 8, fontSize: 13, color: "var(--ink)", textDecoration: "none" }}>
                          📞 {v.phone}
                        </a>
                      )}
                      {v.email && (
                        <a href={`mailto:${v.email}`} onClick={(e) => e.stopPropagation()}
                          style={{ display: "block", marginTop: 4, fontSize: 13, color: "var(--ink)", textDecoration: "none" }}>
                          ✉ {v.email}
                        </a>
                      )}
                      {v.rating > 0 && (
                        <div style={{ marginTop: 8, color: "var(--accent)", fontSize: 14 }}>
                          {"★".repeat(v.rating)}{"☆".repeat(5 - v.rating)}
                        </div>
                      )}
                      {v.notes && (
                        <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {v.notes}
                        </div>
                      )}
                      <div style={{ marginTop: 10, display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                        <SendVendorButton vendor={v} />
                      </div>
                    </button>
                    {/* Selection checkbox — overlay, positioned absolutely outside the inner button */}
                    <label
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute", top: 8, left: 8, zIndex: 2,
                        display: "flex", alignItems: "center", gap: 4,
                        cursor: "pointer", padding: "2px 6px",
                        borderRadius: 4, background: "var(--paper)",
                        border: "1px solid " + (isSelected ? "var(--accent)" : "var(--ink-line)"),
                        fontSize: 11, fontWeight: 500,
                        color: isSelected ? "var(--accent)" : "var(--ink-soft)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(v.id)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ margin: 0, cursor: "pointer" }}
                      />
                      <span>Select</span>
                    </label>
                  </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <VendorModal
          item={editing}
          onClose={() => setEditing(null)}
          onSave={saveItem}
          onRemove={() => removeItem(editing.id)}
          isNew={!items.find(i => i.id === editing.id)}
        />
      )}

      {/* Floating action bar — appears when 1+ vendors selected */}
      {selectedVendors.length > 0 && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: "var(--ink)", color: "var(--paper)",
          borderRadius: 12, padding: "10px 16px",
          boxShadow: "0 8px 32px -8px rgba(26, 44, 71, 0.4)",
          display: "flex", alignItems: "center", gap: 14,
          fontSize: 13, fontWeight: 500,
          zIndex: 100,
        }}>
          <span>{selectedVendors.length} vendor{selectedVendors.length === 1 ? "" : "s"} selected</span>
          <button
            onClick={sendSelected}
            style={{
              ...styles.btn,
              background: "var(--paper)",
              color: "var(--ink)",
              padding: "6px 14px", fontSize: 13, fontWeight: 600,
            }}
          >
            <Send size={13} /> Send Selected
          </button>
          <button
            onClick={clearSelection}
            style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.3)",
              color: "var(--paper)", padding: "6px 12px", borderRadius: 6,
              cursor: "pointer", fontSize: 13,
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Bulk send modal — opens when Send Selected clicked */}
      {showBulkSendModal && (
        <VendorSendModal
          vendors={selectedVendors}
          onClose={() => setShowBulkSendModal(false)}
        />
      )}
    </>
  );
}

function VendorModal({ item, onClose, onSave, onRemove, isNew }) {
  const [form, setForm] = useState(item);
  const update = (k, v) => setForm({ ...form, [k]: v });
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Vendor</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--ink)" }}>
              {isNew ? "New Vendor" : "Edit Vendor"}
            </div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          <FormSection title="Details" icon={Package}>
            <Field label="Name"><input type="text" value={form.name} onChange={(e) => update("name", e.target.value)} style={styles.input} /></Field>
            <Field label="Company"><input type="text" value={form.company} onChange={(e) => update("company", e.target.value)} style={styles.input} /></Field>
            <Field label="Category" full>
              <select value={form.category} onChange={(e) => update("category", e.target.value)} style={styles.input}>
                <option value="">—</option>
                {VENDOR_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Phone"><input type="tel" value={form.phone} onChange={(e) => update("phone", e.target.value)} style={styles.input} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} style={styles.input} /></Field>
            <Field label="Address" full><input type="text" value={form.address} onChange={(e) => update("address", e.target.value)} style={styles.input} /></Field>
            <Field label="Rating" full>
              <div style={{ display: "flex", gap: 4 }}>
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} type="button" onClick={() => update("rating", form.rating === n ? 0 : n)}
                    style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer", color: form.rating >= n ? "var(--accent)" : "var(--ink-line)", fontSize: 24 }}>
                    ★
                  </button>
                ))}
              </div>
            </Field>
          </FormSection>
          <FormSection title="Notes" icon={FileText}>
            <Field full>
              <textarea value={form.notes} onChange={(e) => update("notes", e.target.value)}
                style={{ ...styles.input, minHeight: 80, resize: "vertical", fontFamily: "var(--font-body)" }}
                placeholder="What you'd tell a client about them — reliability, pricing, specialties, gotchas…" />
            </Field>
          </FormSection>
        </div>
        <div style={styles.modalFooter}>
          {!isNew && <button onClick={onRemove} style={{ ...styles.btn, ...styles.btnDanger }}><Trash2 size={14} /> Remove</button>}
          <div style={{ flex: 1 }} />
          <button onClick={() => onSave(form)} style={{ ...styles.btn, ...styles.btnPrimary }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// CHECKLIST TEMPLATES + DATA — pre-listing and closing
// ════════════════════════════════════════════════════════════════════════════
const PRELIST_TEMPLATES_KEY = "jct_prelist_templates";
const CLOSING_TEMPLATE_KEY = "jct_closing_template";

const DEFAULT_PRELIST_TEMPLATES = [
  {
    id: "standard",
    name: "Standard",
    items: [
      "Listing agreement signed",
      "Owner CMA presented",
      "Pre-listing inspection scheduled",
      "Photographer booked",
      "Stager consult (if needed)",
      "MLS entered",
      "Sign installed",
      "Lockbox installed",
      "Brochures printed",
      "Showing instructions set",
      "Coming soon flyer to top buyers",
      "Open house scheduled",
    ],
  },
  {
    id: "luxury",
    name: "Luxury",
    items: [
      "Listing agreement signed",
      "Detailed CMA + market analysis presented",
      "Pre-listing inspection completed",
      "Professional staging arranged",
      "Architectural photography + drone",
      "Twilight photos scheduled",
      "Video walkthrough produced",
      "Custom property website built",
      "MLS entered (all luxury networks)",
      "Sign installed (custom luxury sign)",
      "Lockbox installed",
      "High-end brochures printed",
      "Showing instructions set (appointment only)",
      "Coming soon email to luxury buyer list",
      "Private broker preview scheduled",
      "Open house plan (by invitation)",
    ],
  },
  {
    id: "fsbo",
    name: "FSBO Conversion",
    items: [
      "Listing agreement signed (transferred from FSBO)",
      "Review FSBO marketing for incorrect info",
      "New CMA presented (vs FSBO pricing)",
      "Photographer booked (replace FSBO photos)",
      "MLS entered",
      "Replace FSBO signage with brokerage sign",
      "Lockbox installed",
      "Brochures printed",
      "Reach out to any prior FSBO inquiries",
      "Showing instructions set",
      "First-week open house",
    ],
  },
];

const DEFAULT_CLOSING_TEMPLATE = {
  id: "default",
  name: "Standard Closing",
  items: [
    "Final commission disbursement received",
    "File closed in Paperless Pipeline",
    "Sign and lockbox removed",
    "Client thank-you gift sent",
    "Closing photo (if buyer is willing)",
    "Request Google / Zillow review",
    "Ask for testimonial",
    "Send to past-client database",
    "Add to anniversary follow-up list",
    "Send post-closing utilities checklist to buyer",
    "Send referral request",
    "Update business records / track commission",
  ],
};

function loadPrelistTemplates() {
  try {
    const v = localStorage.getItem(PRELIST_TEMPLATES_KEY);
    if (v) return JSON.parse(v);
  } catch (e) {}
  return DEFAULT_PRELIST_TEMPLATES;
}
function loadClosingTemplate() {
  try {
    const v = localStorage.getItem(CLOSING_TEMPLATE_KEY);
    if (v) return JSON.parse(v);
  } catch (e) {}
  return DEFAULT_CLOSING_TEMPLATE;
}

// ════════════════════════════════════════════════════════════════════════════
// CHECKLIST COMPONENT — used inside transaction detail for prelist + closing
// ════════════════════════════════════════════════════════════════════════════
function ChecklistSection({ title, icon: Icon, items, onChange, templates, onApplyTemplate, allowTemplateEdit, onEditTemplate }) {
  const [newItemText, setNewItemText] = useState("");
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  const toggleItem = (id) => onChange(items.map(it => it.id === id ? { ...it, done: !it.done } : it));
  const removeItem = (id) => onChange(items.filter(it => it.id !== id));
  const updateItemText = (id, text) => onChange(items.map(it => it.id === id ? { ...it, text } : it));
  const addItem = () => {
    if (!newItemText.trim()) return;
    onChange([...items, { id: newId(), text: newItemText.trim(), done: false }]);
    setNewItemText("");
  };

  const done = items.filter(i => i.done).length;

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={styles.formSectionTitle}>
          {Icon && <Icon size={11} style={{ marginRight: 6, verticalAlign: -1 }} />}
          {title} {items.length > 0 && <span style={{ color: "var(--ink-soft)", fontWeight: 400, marginLeft: 6 }}>({done}/{items.length})</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {templates && templates.length > 0 && items.length === 0 && (
            <button onClick={() => setShowTemplatePicker(!showTemplatePicker)}
              style={{ ...styles.btn, ...styles.btnGhost, padding: "4px 10px", fontSize: 11 }}>
              Apply template
            </button>
          )}
          {allowTemplateEdit && (
            <button onClick={onEditTemplate}
              style={{ ...styles.btn, ...styles.btnGhost, padding: "4px 10px", fontSize: 11 }}>
              <Edit3 size={10} /> Edit template
            </button>
          )}
        </div>
      </div>

      {showTemplatePicker && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {templates.map(t => (
            <button key={t.id} onClick={() => { onApplyTemplate(t); setShowTemplatePicker(false); }}
              style={{ ...styles.btn, ...styles.btnGhost, fontSize: 12 }}>
              {t.name} ({t.items.length} items)
            </button>
          ))}
          <button onClick={() => setShowTemplatePicker(false)} style={{ ...styles.btn, padding: "6px 10px", fontSize: 11, background: "transparent", color: "var(--ink-soft)", border: "none" }}>Cancel</button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map(it => (
          <div key={it.id} style={styles.milestoneRow}>
            <button onClick={() => toggleItem(it.id)} style={styles.checkBtn}>
              {it.done
                ? <CheckCircle2 size={16} style={{ color: "var(--accent)" }} />
                : <Circle size={16} style={{ color: "var(--ink-soft)" }} />}
            </button>
            <input type="text" value={it.text} onChange={(e) => updateItemText(it.id, e.target.value)}
              style={{ flex: 1, padding: "4px 6px", border: "none", background: "transparent", fontSize: 13, color: it.done ? "var(--ink-soft)" : "var(--ink)", outline: "none" }} />
            <button onClick={() => removeItem(it.id)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }}>
              <X size={12} />
            </button>
          </div>
        ))}
        <div style={{ ...styles.addMilestoneRow, marginTop: 4 }}>
          <input type="text" placeholder="Add an item…" value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
            style={{ ...styles.input, flex: 1, padding: "6px 10px", fontSize: 13 }} />
          <button onClick={addItem} disabled={!newItemText.trim()}
            style={{ ...styles.btn, ...styles.btnGhost, padding: "6px 10px", fontSize: 12, opacity: newItemText.trim() ? 1 : 0.5 }}>
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TEMPLATE EDITOR — manage prelist and closing templates
// ════════════════════════════════════════════════════════════════════════════
function TemplateEditorModal({ kind: initialKind, onClose, isCloud, updateSetting }) {
  // Allow switching between prelist and closing templates inside the same modal
  const [kind, setKind] = useState(initialKind || "prelist");
  const [templates, setTemplates] = useState(
    kind === "prelist" ? loadPrelistTemplates() : [loadClosingTemplate()]
  );
  const [activeId, setActiveId] = useState(templates[0]?.id);
  const active = templates.find(t => t.id === activeId);
  const [newItemText, setNewItemText] = useState("");

  // When switching template kind, reload the templates and pick the first
  const switchKind = (newKind) => {
    if (newKind === kind) return;
    const fresh = newKind === "prelist" ? loadPrelistTemplates() : [loadClosingTemplate()];
    setKind(newKind);
    setTemplates(fresh);
    setActiveId(fresh[0]?.id);
    setNewItemText("");
  };

  const save = () => {
    if (kind === "prelist") {
      try { localStorage.setItem(PRELIST_TEMPLATES_KEY, JSON.stringify(templates)); } catch (e) {}
      if (isCloud && updateSetting) updateSetting("prelist_templates", templates);
    } else {
      try { localStorage.setItem(CLOSING_TEMPLATE_KEY, JSON.stringify(templates[0])); } catch (e) {}
      if (isCloud && updateSetting) updateSetting("closing_template", templates[0]);
    }
    onClose();
  };

  const updateTemplate = (id, patch) => setTemplates(templates.map(t => t.id === id ? { ...t, ...patch } : t));
  const addItem = () => {
    if (!newItemText.trim() || !active) return;
    updateTemplate(active.id, { items: [...active.items, newItemText.trim()] });
    setNewItemText("");
  };
  const removeItem = (i) => updateTemplate(active.id, { items: active.items.filter((_, idx) => idx !== i) });
  const updateItem = (i, text) => updateTemplate(active.id, { items: active.items.map((v, idx) => idx === i ? text : v) });
  const addTemplate = () => {
    const t = { id: `tpl_${newId()}`, name: "New Template", items: [] };
    setTemplates([...templates, t]);
    setActiveId(t.id);
  };
  const removeTemplate = (id) => {
    if (templates.length <= 1) { alert("You need at least one template."); return; }
    if (!confirm("Delete this template?")) return;
    const next = templates.filter(t => t.id !== id);
    setTemplates(next);
    setActiveId(next[0]?.id);
  };

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Templates</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--ink)" }}>
              Edit Checklists
            </div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>
        <div style={{ display: "flex", gap: 6, padding: "0 20px", borderBottom: "1px solid var(--ink-line)" }}>
          <button onClick={() => switchKind("prelist")}
            style={{
              padding: "10px 14px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: kind === "prelist" ? 600 : 400,
              color: kind === "prelist" ? "var(--ink)" : "var(--ink-soft)",
              borderBottom: kind === "prelist" ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: -1,
            }}>
            Pre-Listing
          </button>
          <button onClick={() => switchKind("closing")}
            style={{
              padding: "10px 14px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: kind === "closing" ? 600 : 400,
              color: kind === "closing" ? "var(--ink)" : "var(--ink-soft)",
              borderBottom: kind === "closing" ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: -1,
            }}>
            Closing
          </button>
        </div>
        <div style={styles.modalBody}>
          {kind === "prelist" && (
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {templates.map(t => (
                <button key={t.id} onClick={() => setActiveId(t.id)}
                  style={{ ...styles.btn, ...(t.id === activeId ? styles.btnPrimary : styles.btnGhost), fontSize: 12 }}>
                  {t.name}
                </button>
              ))}
              <button onClick={addTemplate} style={{ ...styles.btn, ...styles.btnGhost, fontSize: 12 }}>
                <Plus size={12} /> New template
              </button>
            </div>
          )}

          {active && (
            <>
              <Field label="Template name">
                <input type="text" value={active.name}
                  onChange={(e) => updateTemplate(active.id, { name: e.target.value })}
                  style={styles.input} />
              </Field>
              <div style={{ marginTop: 16 }}>
                <div style={styles.formSectionTitle}>Checklist items</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {active.items.map((it, i) => (
                    <div key={i} style={styles.milestoneRow}>
                      <Circle size={14} style={{ color: "var(--ink-soft)" }} />
                      <input type="text" value={it}
                        onChange={(e) => updateItem(i, e.target.value)}
                        style={{ flex: 1, padding: "4px 6px", border: "none", background: "transparent", fontSize: 13, color: "var(--ink)", outline: "none" }} />
                      <button onClick={() => removeItem(i)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <div style={{ ...styles.addMilestoneRow, marginTop: 4 }}>
                    <input type="text" placeholder="Add an item…" value={newItemText}
                      onChange={(e) => setNewItemText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
                      style={{ ...styles.input, flex: 1, padding: "6px 10px", fontSize: 13 }} />
                    <button onClick={addItem} disabled={!newItemText.trim()}
                      style={{ ...styles.btn, ...styles.btnGhost, padding: "6px 10px", fontSize: 12, opacity: newItemText.trim() ? 1 : 0.5 }}>
                      <Plus size={12} /> Add
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <div style={styles.modalFooter}>
          {kind === "prelist" && active && templates.length > 1 && (
            <button onClick={() => removeTemplate(active.id)} style={{ ...styles.btn, ...styles.btnDanger }}>
              <Trash2 size={14} /> Delete template
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={save} style={{ ...styles.btn, ...styles.btnPrimary }}>Save templates</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// EMAIL DRAFTING — opens default mail app with pre-filled email via mailto:
// ════════════════════════════════════════════════════════════════════════════

// Build a milestone list as plain text bullets, sorted by date.
function buildMilestoneLines(txn) {
  return (txn.milestones || [])
    .filter(m => m.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(m => `  • ${m.label}: ${fmtDate(m.date)}${m.notes ? ` (${m.notes})` : ""}`)
    .join("\n");
}

// Open the default mail app with a pre-filled draft.
function openMailDraft({ to, subject, body }) {
  if (!to) {
    alert("No recipient email available. Please add their email to the transaction first.");
    return;
  }
  const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  // Using an anchor click rather than window.location.href because the latter
  // is blocked in iframes (which is how the artifact runtime renders).
  // Creating + clicking a real <a> is treated as a user-initiated navigation.
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function draftEmailToOtherAgent(txn) {
  const isListing = txn.type === "listing";
  const role = isListing ? "sellingBroker" : "listingBroker";
  const agent = txn.contacts?.[role];
  const to = agent?.email || "";
  const greeting = agent?.name ? `Hi ${agent.name.split(" ")[0]},` : "Hi,";
  const address = txn.address || "the property";
  const milestoneLines = buildMilestoneLines(txn);

  const subject = `${address} — Transaction Timeline`;
  const body = `${greeting}

Looking forward to working with you on ${address}. Here are the key dates from our contract:

${milestoneLines || "(no dates set yet)"}

Please let me know if anything looks off or if you need anything from my side.

Best,
The Jesse Cope Team`;

  openMailDraft({ to, subject, body });
}

function draftEmailToEscrow(txn) {
  const escrow = txn.contacts?.escrow;
  const to = escrow?.email || "";
  const greeting = escrow?.name ? `Hi ${escrow.name.split(" ")[0]},` : "Hi,";
  const address = txn.address || "the property";
  const milestoneLines = buildMilestoneLines(txn);
  const buyerLine = txn.buyerName ? `Buyer: ${txn.buyerName}\n` : "";
  const sellerLine = txn.sellerName ? `Seller: ${txn.sellerName}\n` : "";
  const priceLine = txn.price ? `Purchase Price: ${fmtMoney(txn.price)}\n` : "";

  const subject = `${address} — Opening Escrow / Key Dates`;
  const body = `${greeting}

Here's a new transaction we'd like to open escrow on:

Property: ${address}
${sellerLine}${buyerLine}${priceLine}
Key dates:
${milestoneLines || "(no dates set yet)"}

Please confirm receipt and let me know what you need from us.

Thanks,
The Jesse Cope Team`;

  openMailDraft({ to, subject, body });
}

function draftEmailToLender(txn) {
  const lender = txn.contacts?.lender;
  const to = lender?.email || "";
  const greeting = lender?.name ? `Hi ${lender.name.split(" ")[0]},` : "Hi,";
  const address = txn.address || "the property";
  const milestoneLines = buildMilestoneLines(txn);
  const buyerLine = txn.buyerName ? `Buyer: ${txn.buyerName}\n` : "";
  const priceLine = txn.price ? `Purchase Price: ${fmtMoney(txn.price)}\n` : "";
  const financingLine = txn.financing ? `Financing: ${txn.financing}\n` : "";

  const subject = `${address} — Loan File / Timeline`;
  const body = `${greeting}

Wanted to make sure you have the contract details for this transaction:

Property: ${address}
${buyerLine}${priceLine}${financingLine}
Key dates:
${milestoneLines || "(no dates set yet)"}

Please confirm timeline and let me know if you need anything from buyer.

Thanks,
The Jesse Cope Team`;

  openMailDraft({ to, subject, body });
}

function draftEmailToClient(txn) {
  const isListing = txn.type === "listing";
  const clientName = isListing ? txn.sellerName : txn.buyerName;
  const clientEmail = isListing ? txn.sellerEmail : txn.buyerEmail;
  const greeting = clientName ? `Hi ${clientName.split(" ")[0]},` : "Hi,";
  const address = txn.address || "your property";
  const milestoneLines = buildMilestoneLines(txn);

  const subject = `Your timeline for ${address}`;
  const body = `${greeting}

Just wanted to make sure you have all the important dates for your transaction at ${address} in one place:

${milestoneLines || "(no dates set yet)"}

You don't have to remember any of these — I'll reach out as each one comes up. But here they are if you'd like to put them on your calendar.

As always, reach out anytime with questions.

Best,
The Jesse Cope Team`;

  openMailDraft({ to: clientEmail, subject, body });
}

function DraftEmailButton({ label, hint, available, onClick }) {
  return (
    <button
      onClick={available ? onClick : undefined}
      disabled={!available}
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
        padding: "10px 12px",
        background: available ? "var(--paper)" : "transparent",
        border: "1px solid var(--ink-line)", borderRadius: 8,
        cursor: available ? "pointer" : "not-allowed",
        opacity: available ? 1 : 0.5,
        textAlign: "left", color: "var(--ink)", transition: "border-color 0.15s",
      }}
      title={available ? `Open mail app with draft for ${hint}` : "Add this contact's email first"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
        <Mail size={12} /> {label}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
        {hint}
      </div>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT STORAGE
// Files stored as base64 in localStorage under separate keys (small files only).
// Will use Supabase Storage in cloud mode, localStorage in local mode.
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT STORAGE — localStorage for local mode, Supabase Storage for cloud
// ════════════════════════════════════════════════════════════════════════════
const DOC_BLOB_PREFIX = "jct_doc_blob_";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file in cloud (Supabase free tier limit)
const MAX_LOCAL_FILE_SIZE = 4 * 1024 * 1024; // 4 MB per file when not signed in (browser storage limit)
const MAX_TOTAL_DOC_SIZE = 20 * 1024 * 1024; // 20 MB total when not signed in
const STORAGE_BUCKET = "documents";

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = String(dataUrl).split(",")[1] || "";
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
}

function totalDocBytes() {
  // Only meaningful for local mode (cloud has its own quota)
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(DOC_BLOB_PREFIX)) {
      const v = localStorage.getItem(k) || "";
      total += v.length;
    }
  }
  return total;
}

// Save a document. In cloud mode, uploads the File to Supabase Storage at
// {user_id}/{docId}. In local mode, stores base64 in localStorage.
async function saveDocumentBlob(docId, file, base64, isCloud) {
  if (isCloud) {
    try {
      const user = await getCurrentUser();
      if (!user) throw new Error("Not signed in");
      const path = `${user.id}/${docId}`;
      const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, file, { upsert: true, contentType: file.type || "application/octet-stream" });
      if (error) throw error;
      return true;
    } catch (e) {
      console.error("Cloud upload failed:", e);
      return false;
    }
  }
  try {
    localStorage.setItem(DOC_BLOB_PREFIX + docId, base64);
    return true;
  } catch (e) {
    return false;
  }
}

// Load a document. Cloud → downloads from Storage and returns base64.
// Local → reads localStorage. Async in both cases.
async function loadDocumentBlob(docId, isCloud) {
  if (isCloud) {
    try {
      const user = await getCurrentUser();
      if (!user) return null;
      const path = `${user.id}/${docId}`;
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(path);
      if (error) {
        // Fall back to localStorage in case this is an older doc that wasn't migrated
        const local = localStorage.getItem(DOC_BLOB_PREFIX + docId);
        return local;
      }
      return await blobToBase64(data);
    } catch (e) {
      console.error("Cloud download failed:", e);
      return localStorage.getItem(DOC_BLOB_PREFIX + docId);
    }
  }
  return localStorage.getItem(DOC_BLOB_PREFIX + docId);
}

async function removeDocumentBlob(docId, isCloud) {
  if (isCloud) {
    try {
      const user = await getCurrentUser();
      if (user) {
        const path = `${user.id}/${docId}`;
        await supabase.storage.from(STORAGE_BUCKET).remove([path]);
      }
    } catch (e) { /* swallow */ }
  }
  try { localStorage.removeItem(DOC_BLOB_PREFIX + docId); } catch (e) {}
}

async function downloadDocument(doc, isCloud) {
  const base64 = await loadDocumentBlob(doc.id, isCloud);
  if (!base64) {
    alert("Document data not found.");
    return;
  }
  const link = document.createElement("a");
  link.href = `data:${doc.type || "application/octet-stream"};base64,${base64}`;
  link.download = doc.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function openDocument(doc, isCloud) {
  // Open the window FIRST (synchronously, while we're still in the click
  // handler's call stack) — otherwise browsers block popups for async opens.
  const win = window.open("about:blank");
  if (!win) {
    alert("Pop-up blocked. Allow pop-ups for this site, or use Download instead.");
    return;
  }
  // Show a quick loading message while we fetch
  try {
    win.document.write('<html><body style="font-family:system-ui;padding:40px;color:#666">Loading document…</body></html>');
  } catch (e) {}

  const base64 = await loadDocumentBlob(doc.id, isCloud);
  if (!base64) {
    win.close();
    alert("Document data not found.");
    return;
  }
  if (doc.type?.startsWith("image/")) {
    win.document.open();
    win.document.write(`<html><head><title>${escapeHTML(doc.name)}</title></head><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="data:${doc.type};base64,${base64}" style="max-width:100%;max-height:100vh" /></body></html>`);
    win.document.close();
  } else if (doc.type === "application/pdf") {
    win.location.href = `data:application/pdf;base64,${base64}`;
  } else {
    win.close();
    downloadDocument(doc, isCloud);
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function documentIcon(type, name) {
  if (type?.startsWith("image/")) return "🖼";
  if (type === "application/pdf" || name?.toLowerCase().endsWith(".pdf")) return "📄";
  if (name?.match(/\.(doc|docx)$/i)) return "📝";
  if (name?.match(/\.(xls|xlsx|csv)$/i)) return "📊";
  return "📎";
}

function DocumentsSection({ txn, onUpdate, isCloud }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const docs = txn.documents || [];
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);

  const handleFiles = async (files) => {
    setError("");
    if (!files || files.length === 0) return;

    const totalNow = isCloud ? 0 : totalDocBytes();
    const newDocs = [];
    setUploading(true);

    for (const file of files) {
      const sizeLimit = isCloud ? MAX_FILE_SIZE : MAX_LOCAL_FILE_SIZE;
      if (file.size > sizeLimit) {
        setError(`"${file.name}" is too large (${formatFileSize(file.size)}). Max per file is ${formatFileSize(sizeLimit)}.`);
        continue;
      }
      if (!isCloud) {
        const projectedSize = totalNow + (file.size * 1.4);
        if (projectedSize > MAX_TOTAL_DOC_SIZE) {
          setError(`Not enough browser space. Total documents would exceed ${formatFileSize(MAX_TOTAL_DOC_SIZE)}. Sign in to use cloud storage.`);
          continue;
        }
      }

      try {
        // Cloud uses the File directly; local needs base64.
        const base64 = isCloud ? null : await fileToBase64(file);
        const docId = newId();
        const saved = await saveDocumentBlob(docId, file, base64, isCloud);
        if (!saved) {
          setError(`Couldn't save "${file.name}".`);
          continue;
        }
        newDocs.push({
          id: docId,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          addedAt: new Date().toISOString(),
          cloud: !!isCloud,
        });
      } catch (e) {
        setError(`Failed to upload "${file.name}": ${e.message}`);
      }
    }

    if (newDocs.length > 0) {
      onUpdate({ ...txn, documents: [...docs, ...newDocs] });
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeDoc = async (doc) => {
    if (!confirm(`Remove "${doc.name}"? This deletes the file — it can't be undone.`)) return;
    // Use doc.cloud if present, else fall back to current cloud mode (legacy local docs need local cleanup)
    const docWasCloud = doc.cloud === true || (doc.cloud === undefined && isCloud);
    await removeDocumentBlob(doc.id, docWasCloud);
    onUpdate({ ...txn, documents: docs.filter(d => d.id !== doc.id) });
  };

  const renameDoc = (doc) => {
    const newName = prompt("Rename document:", doc.name);
    if (!newName || newName === doc.name) return;
    onUpdate({ ...txn, documents: docs.map(d => d.id === doc.id ? { ...d, name: newName } : d) });
  };

  // Wrappers for open/download that pass each doc's cloud flag
  const openDoc = (doc) => openDocument(doc, doc.cloud === true || (doc.cloud === undefined && isCloud));
  const downloadDoc = (doc) => downloadDocument(doc, doc.cloud === true || (doc.cloud === undefined && isCloud));

  return (
    <div style={{ marginTop: 28 }}>
      <div style={styles.formSectionTitle}>
        <FileText size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Documents {docs.length > 0 && <span style={{ color: "var(--ink-soft)", fontWeight: 400, marginLeft: 6 }}>({docs.length})</span>}
      </div>
      <div
        style={{
          padding: 14,
          background: "var(--paper-soft)",
          border: dragActive ? "1px dashed var(--accent)" : "1px solid var(--ink-line)",
          borderRadius: 12,
          transition: "border 0.15s",
        }}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        {docs.length === 0 && !uploading && (
          <div style={{ textAlign: "center", padding: "16px 0", color: "var(--ink-soft)", fontSize: 13 }}>
            No documents yet. Drag files here or click below to upload.
          </div>
        )}

        {docs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {docs.map(doc => (
              <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 8 }}>
                <div style={{ fontSize: 20 }}>{documentIcon(doc.type, doc.name)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                    {formatFileSize(doc.size)} · {fmtDate(doc.addedAt?.split("T")[0])}
                  </div>
                </div>
                <button onClick={() => openDoc(doc)} style={{ ...styles.btn, ...styles.btnGhost, padding: "4px 10px", fontSize: 11 }} title="Open in new tab">
                  Open
                </button>
                <button onClick={() => downloadDoc(doc)} style={{ ...styles.btn, ...styles.btnGhost, padding: "4px 10px", fontSize: 11 }} title="Download">
                  <Download size={11} />
                </button>
                <button onClick={() => renameDoc(doc)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }} title="Rename">
                  <Edit3 size={12} />
                </button>
                <button onClick={() => removeDoc(doc)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }} title="Remove">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: "none" }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{ ...styles.btn, ...styles.btnGhost, padding: "8px 14px", fontSize: 13, width: "100%", justifyContent: "center", opacity: uploading ? 0.6 : 1 }}
        >
          {uploading ? <><Loader2 size={13} className="spin" /> Uploading…</> : <><Upload size={13} /> Upload files</>}
        </button>

        {error && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(196, 96, 47, 0.1)", border: "1px solid var(--accent-soft)", borderRadius: 6, color: "var(--accent)", fontSize: 12 }}>
            {error}
          </div>
        )}

        <div style={{ marginTop: 10, fontSize: 11, color: "var(--ink-soft)", display: "flex", justifyContent: "space-between" }}>
          <span>PDF, images, Office docs · Max {formatFileSize(isCloud ? MAX_FILE_SIZE : MAX_LOCAL_FILE_SIZE)} per file</span>
          {!isCloud && (
            <span style={{ fontWeight: 500 }}>
              {formatFileSize(totalDocBytes())} of {formatFileSize(MAX_TOTAL_DOC_SIZE)} used
            </span>
          )}
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--ink-soft)" }}>
          {isCloud
            ? "☁ Stored in cloud — syncs across all your devices."
            : "📍 Stored on this device only. Sign in for cloud sync."}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PRINT VIEW — clean letter-sized one-pager
// ════════════════════════════════════════════════════════════════════════════
function printTransaction(txn) {
  const w = window.open("", "_blank", "width=900,height=1100");
  if (!w) { alert("Pop-up blocked — please allow pop-ups for this page."); return; }
  const safe = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const m = (k, v) => v ? `<tr><td>${safe(k)}</td><td><strong>${safe(v)}</strong></td></tr>` : "";

  const milestoneRows = txn.milestones.filter(ms => ms.date).map(ms => {
    const check = ms.complete ? "✓" : "○";
    const note = ms.notes ? ` — ${safe(ms.notes)}` : "";
    return `<tr><td style="width:24px;color:${ms.complete ? '#c4602f' : '#6b7585'}">${check}</td><td>${safe(ms.label)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${fmtDate(ms.date)}${note}</td></tr>`;
  }).join("");

  const contactRows = CONTACT_ROLES.map(role => {
    const c = txn.contacts?.[role.key];
    if (!c || !c.name) return "";
    return `<tr><td>${safe(role.label)}</td><td><strong>${safe(c.name)}</strong>${c.company ? `, ${safe(c.company)}` : ""}<br/><span style="color:#6b7585;font-size:12px">${[c.phone, c.email].filter(Boolean).map(safe).join(" · ")}</span></td></tr>`;
  }).filter(Boolean).join("");

  const html = `<!doctype html><html><head><title>${safe(txn.address || "Transaction")}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Manrope:wght@400;500;600&display=swap');
* { box-sizing: border-box; }
body { font-family: 'Manrope', system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 32px 40px; color: #1a2c47; font-size: 13px; line-height: 1.45; }
.header { border-bottom: 2px solid #1a2c47; padding-bottom: 16px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-end; }
h1 { font-family: 'Fraunces', Georgia, serif; font-size: 26px; font-weight: 500; margin: 0; letter-spacing: -0.02em; line-height: 1.1; }
.eyebrow { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #6b7585; font-weight: 600; margin-bottom: 4px; }
.subhead { color: #6b7585; font-size: 13px; margin-top: 4px; }
h2 { font-family: 'Fraunces', Georgia, serif; font-size: 14px; font-weight: 600; margin: 24px 0 8px 0; padding-bottom: 6px; border-bottom: 1px solid #d3d7df; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7585; }
table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
td { padding: 5px 8px; vertical-align: top; }
td:first-child { color: #6b7585; width: 38%; font-size: 12px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.cols h2 { margin-top: 0; }
.notes-block { padding: 12px 14px; background: #f5f6f8; border: 1px solid #d3d7df; border-radius: 6px; white-space: pre-wrap; font-size: 12px; }
.footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #d3d7df; color: #6b7585; font-size: 10px; display: flex; justify-content: space-between; }
@media print { body { padding: 12px 20px; } .no-print { display: none; } }
</style></head><body>
<div class="header">
  <div>
    <div class="eyebrow">The Jesse Cope Team · ${txn.type === "listing" ? "Listing" : "Buyer"} Transaction</div>
    <h1>${safe(txn.address || "Property")}</h1>
    <div class="subhead">${safe([txn.city, txn.state, txn.zip].filter(Boolean).join(", "))}</div>
  </div>
  <div style="text-align:right;font-size:11px;color:#6b7585">
    Status: <strong style="color:#1a2c47">${safe((STATUS_OPTIONS.find(s => s.value === txn.status) || {}).label || "—")}</strong><br/>
    Printed: ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
  </div>
</div>

<div class="cols">
  <div>
    <h2>Parties</h2>
    <table>
      ${m("Seller", txn.sellerName)}
      ${m("", [txn.sellerPhone, txn.sellerEmail].filter(Boolean).join(" · "))}
      ${m("Buyer", txn.buyerName)}
      ${m("", [txn.buyerPhone, txn.buyerEmail].filter(Boolean).join(" · "))}
    </table>
  </div>
  <div>
    <h2>Financial</h2>
    <table>
      ${txn.listPrice ? m("List Price", fmtMoney(txn.listPrice)) : ""}
      ${m("Purchase Price", fmtMoney(txn.price))}
      ${m("Earnest Money", txn.earnestMoney ? fmtMoney(txn.earnestMoney) : "")}
      ${m("Down Payment", txn.downPayment ? fmtMoney(txn.downPayment) : "")}
      ${m("Closing Costs", txn.closingCosts ? fmtMoney(txn.closingCosts) : "")}
      ${m("Financing", txn.financing)}
      ${m("Listing Side", txn.listingCommission ? txn.listingCommission + "%" : "")}
      ${m("Buying Side", txn.buyingCommission ? txn.buyingCommission + "%" : "")}
      ${m("Mutual Acceptance", txn.contractDate ? fmtDate(txn.contractDate) : "")}
      ${m("Closing", txn.closingDate ? fmtDate(txn.closingDate) : "")}
    </table>
  </div>
</div>

${milestoneRows ? `<h2>Timeline</h2><table>${milestoneRows}</table>` : ""}

${contactRows ? `<h2>Contacts</h2><table>${contactRows}</table>` : ""}

${txn.includedItems ? `<h2>Included Items</h2><div class="notes-block">${safe(txn.includedItems)}</div>` : ""}

${txn.notes ? `<h2>Notes</h2><div class="notes-block">${safe(txn.notes)}</div>` : ""}

<div class="footer">
  <div>The Jesse Cope Team</div>
  <div>Page 1 of 1</div>
</div>
<script>window.onload = function() { setTimeout(function() { window.print(); }, 400); };</script>
</body></html>`;

  w.document.write(html);
  w.document.close();
}

// ════════════════════════════════════════════════════════════════════════════
// CLIENT PORTAL MANAGER — per-transaction access (data model ready, login in Phase 2)
// ════════════════════════════════════════════════════════════════════════════
// ─── Portal token generation ─────────────────────────────────────────────
// Generates a long, unguessable random token used as a portal access key.
// Format: 8 random URL-safe segments, joined with "-", ~64 characters.
function generatePortalToken() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segment = () => Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return [segment(), segment(), segment(), segment()].join("-");
}

function PortalLinkBox({ portalToken, onGenerate, onRegenerate }) {
  const [copied, setCopied] = useState(false);
  const portalUrl = portalToken ? `${window.location.origin}/#/portal/${portalToken}` : "";

  const copy = () => {
    if (!portalUrl) return;
    navigator.clipboard.writeText(portalUrl).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      () => alert("Couldn't copy. Select the link manually and copy.")
    );
  };

  if (!portalToken) {
    return (
      <div style={{ marginBottom: 16, padding: 14, background: "var(--paper)", border: "1px dashed var(--ink-line)", borderRadius: 8 }}>
        <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>
          No portal link generated yet. Click below to create a unique link for this transaction.
        </div>
        <button onClick={onGenerate} style={{ ...styles.btn, ...styles.btnPrimary, fontSize: 12 }}>
          Generate Portal Link
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16, padding: 14, background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 8 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontWeight: 600, marginBottom: 8 }}>
        Portal Link
      </div>
      <div style={{ fontSize: 11, color: "var(--ink)", padding: "8px 10px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 6, wordBreak: "break-all", fontFamily: "monospace", marginBottom: 8 }}>
        {portalUrl}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button onClick={copy} style={{ ...styles.btn, ...styles.btnPrimary, fontSize: 12 }}>
          {copied ? "✓ Copied" : "Copy Link"}
        </button>
        <a href={portalUrl} target="_blank" rel="noopener noreferrer"
          style={{ ...styles.btn, ...styles.btnGhost, fontSize: 12, textDecoration: "none" }}>
          Preview as Client
        </a>
        <button onClick={onRegenerate} style={{ ...styles.btn, ...styles.btnGhost, fontSize: 12 }}>
          Regenerate
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 8, lineHeight: 1.5 }}>
        Email or text this link to your client. Anyone with the link can view (but not edit) this transaction. Regenerate to revoke an old link.
      </div>
    </div>
  );
}

function ClientPortalSection({ txn, onUpdate }) {
  const portal = txn.clientPortal || { enabled: false, clients: [], visibleMilestones: [], clientNotes: "", showFinancials: true };
  // Inline form for adding a new client — replaces the browser prompt() calls,
  // which were unreliable and caused the modal to feel like it was closing.
  const [showAddClient, setShowAddClient] = useState(false);
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientName, setNewClientName] = useState("");

  // clientNotes uses local state with a debounced cloud save so typing doesn't
  // trigger a save on every keystroke (which was making the textarea lag and
  // jump). This matches the pattern Quick Notes uses.
  const [notesLocal, setNotesLocal] = useState(portal.clientNotes || "");
  const notesDebounceRef = useRef(null);

  // Pull in external changes from cloud realtime — but only if we're not
  // actively editing (avoid clobbering user's in-progress typing).
  useEffect(() => {
    if (notesDebounceRef.current === null) {
      setNotesLocal(portal.clientNotes || "");
    }
  }, [portal.clientNotes]);

  const updatePortal = (patch) => onUpdate({ ...txn, clientPortal: { ...portal, ...patch } });

  const handleNotesChange = (e) => {
    const v = e.target.value;
    setNotesLocal(v);
    if (notesDebounceRef.current) clearTimeout(notesDebounceRef.current);
    notesDebounceRef.current = setTimeout(() => {
      updatePortal({ clientNotes: v });
      notesDebounceRef.current = null;
    }, 800);
  };

  const addClient = () => {
    const email = newClientEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      alert("Please enter a valid email address.");
      return;
    }
    const name = newClientName.trim() || email.split("@")[0];
    updatePortal({
      clients: [...portal.clients, { id: newId(), email, name, addedAt: new Date().toISOString() }],
    });
    setNewClientEmail("");
    setNewClientName("");
    setShowAddClient(false);
  };
  const removeClient = (id) => {
    if (!confirm("Revoke this client's access?")) return;
    updatePortal({ clients: portal.clients.filter(c => c.id !== id) });
  };
  const toggleMilestone = (msId) => {
    const visible = portal.visibleMilestones || [];
    updatePortal({
      visibleMilestones: visible.includes(msId) ? visible.filter(x => x !== msId) : [...visible, msId],
    });
  };

  return (
    <div style={{ marginTop: 28 }}>
      <div style={styles.formSectionTitle}>
        <Users size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Client Portal Access
      </div>
      <div style={{ padding: 16, background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={portal.enabled} onChange={(e) => updatePortal({ enabled: e.target.checked })} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Enable client portal for this transaction</span>
          </label>
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: portal.enabled ? "rgba(123, 154, 90, 0.15)" : "rgba(107, 117, 133, 0.1)", color: portal.enabled ? "#5d7a44" : "var(--ink-soft)", fontWeight: 600 }}>
            {portal.enabled ? "ACTIVE" : "INACTIVE"}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 16, lineHeight: 1.5 }}>
          Generates a unique view-only link your client can use to see this transaction's status, timeline, and documents. No client login required — just send them the link.
        </div>

        {portal.enabled && (
          <>
            {/* ─── Portal link section ───────────────────────────────────────
                Token is auto-generated when portal is enabled. Broker can copy the
                link, regenerate it to revoke access, or open it in a new tab to
                preview what the client sees. */}
            <PortalLinkBox
              portalToken={txn.portalToken}
              onGenerate={() => onUpdate({ ...txn, portalToken: generatePortalToken() })}
              onRegenerate={() => {
                if (confirm("Regenerate the link? The old link will stop working immediately.")) {
                  onUpdate({ ...txn, portalToken: generatePortalToken() });
                }
              }}
            />

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontWeight: 600, marginBottom: 8 }}>
                Clients with access
              </div>
              {(portal.clients || []).length === 0 && (
                <div style={{ fontSize: 12, color: "var(--ink-soft)", fontStyle: "italic", marginBottom: 8 }}>
                  No clients added yet.
                </div>
              )}
              {(portal.clients || []).map(c => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                  <UserCircle2 size={16} style={{ color: "var(--ink-soft)" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>{c.email}</div>
                  </div>
                  <button onClick={() => removeClient(c.id)} style={{ background: "transparent", border: "none", color: "var(--ink-soft)", padding: 4, cursor: "pointer" }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
              {!showAddClient ? (
                <button onClick={() => setShowAddClient(true)} style={{ ...styles.btn, ...styles.btnGhost, padding: "6px 12px", fontSize: 12, marginTop: 8 }}>
                  <Plus size={12} /> Add client
                </button>
              ) : (
                <div style={{ marginTop: 8, padding: 12, background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>New Client</div>
                  <input
                    type="email"
                    value={newClientEmail}
                    onChange={(e) => setNewClientEmail(e.target.value)}
                    placeholder="Email address"
                    style={{ ...styles.input, marginBottom: 6 }}
                    autoFocus
                  />
                  <input
                    type="text"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    placeholder="Display name (optional)"
                    style={{ ...styles.input, marginBottom: 8 }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={addClient} style={{ ...styles.btn, ...styles.btnPrimary, fontSize: 12, flex: 1 }}>
                      Add Client
                    </button>
                    <button onClick={() => { setShowAddClient(false); setNewClientEmail(""); setNewClientName(""); }}
                      style={{ ...styles.btn, ...styles.btnGhost, fontSize: 12 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontWeight: 600, marginBottom: 8 }}>
                What clients can see
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, padding: "4px 0" }}>
                <input type="checkbox" checked={portal.showFinancials !== false}
                  onChange={(e) => updatePortal({ showFinancials: e.target.checked })} />
                Show price, earnest money, down payment, closing costs
              </label>
              <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(196, 96, 47, 0.06)", border: "1px solid var(--accent-soft)", borderRadius: 6, fontSize: 12, color: "var(--ink)", display: "flex", alignItems: "center", gap: 8 }}>
                🔒 <span><strong>Commission is always hidden from clients</strong> — listing side %, buying side %, and any commission amount are never shown in the portal, even if financials are enabled above.</span>
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-soft)" }}>Milestones visible to clients:</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                {txn.milestones.map(ms => (
                  <label key={ms.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", padding: "3px 0" }}>
                    <input type="checkbox"
                      checked={(portal.visibleMilestones || []).includes(ms.id)}
                      onChange={() => toggleMilestone(ms.id)} />
                    {ms.label}
                    {ms.date && <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>· {fmtDate(ms.date)}</span>}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontWeight: 600, marginBottom: 8 }}>
                Notes to Client
              </div>
              <textarea
                value={notesLocal}
                onChange={handleNotesChange}
                placeholder="Updates, reminders, or messages the client will see. Separate from your private notes."
                style={{ ...styles.input, minHeight: 80, resize: "vertical", fontFamily: "var(--font-body)" }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FORM MODAL (full edit)
// ════════════════════════════════════════════════════════════════════════════
function FormModal({ txn, onClose, onSave, contactDirectory = [] }) {
  const [form, setForm] = useState(txn);
  const [parsing, setParsing] = useState(null); // null | "listing" | "purchase"
  const [parseError, setParseError] = useState("");
  const [parseSuccess, setParseSuccess] = useState("");
  const [newMilestoneLabel, setNewMilestoneLabel] = useState("");
  // Track whether the form has been edited so we can warn before losing changes.
  const [isDirty, setIsDirty] = useState(false);
  const listingInputRef  = useRef(null);
  const purchaseInputRef = useRef(null);

  const isNew = !(txn.address || txn.sellerName || txn.buyerName || txn.price);

  // Wrap onClose with confirmation if the form has unsaved changes.
  const safeClose = () => {
    if (isDirty) {
      if (!confirm("Discard your changes? Anything you haven't saved will be lost.")) return;
    }
    onClose();
  };

  const handleUpload = async (e, kind) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(kind); setParseError(""); setParseSuccess("");
    try {
      const extracted = kind === "listing"
        ? await parseListingAgreement(file)
        : await parsePurchaseContract(file);
      const merged = kind === "listing"
        ? applyListingAgreement(form, extracted)
        : applyPurchaseContract(form, extracted);
      setForm(merged);
      setIsDirty(true);
      setParseSuccess(kind === "listing"
        ? "Listing agreement parsed — review fields below."
        : "Purchase contract parsed — review the timeline and save.");
      setTimeout(() => setParseSuccess(""), 6000);
    } catch (err) {
      setParseError(err.message || "Could not parse document.");
    } finally {
      setParsing(null);
      if (listingInputRef.current)  listingInputRef.current.value = "";
      if (purchaseInputRef.current) purchaseInputRef.current.value = "";
    }
  };

  const update = (field, value) => { setForm({ ...form, [field]: value }); setIsDirty(true); };
  const updateContact = (role, field, value) => {
    setForm({
      ...form,
      contacts: { ...form.contacts, [role]: { ...form.contacts[role], [field]: value } },
    });
    setIsDirty(true);
  };
  const updateMilestone = (id, field, value) => {
    setForm({
      ...form,
      milestones: form.milestones.map(m => m.id === id ? { ...m, [field]: value } : m),
    });
    setIsDirty(true);
  };
  const addCustomMilestone = () => {
    if (!newMilestoneLabel.trim()) return;
    setForm({
      ...form,
      milestones: [...form.milestones, {
        id: newId(), label: newMilestoneLabel.trim(),
        date: "", complete: false, notes: "", custom: true,
        reminderDays: DEFAULT_REMINDER_DAYS,
      }],
    });
    setNewMilestoneLabel("");
    setIsDirty(true);
  };
  const removeMilestone = (id) => {
    setForm({
      ...form,
      milestones: form.milestones.filter(m => m.id !== id),
    });
    setIsDirty(true);
  };

  return (
    <div style={styles.modalBackdrop} onClick={safeClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>{form.type === "listing" ? "Listing" : "Buyer Transaction"}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "var(--ink)" }}>
              {isNew ? "New Transaction" : "Edit Transaction"}
            </div>
          </div>
          <button onClick={safeClose} style={styles.iconBtn}><X size={18} /></button>
        </div>

        <div style={styles.modalBody}>
          {/* Contract auto-fill — type-aware */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Sparkles size={16} style={{ color: "var(--accent)" }} />
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>Auto-fill from documents</div>
              <span style={styles.betaTag}>AI</span>
            </div>
            <div style={styles.uploadGrid}>
              {form.type === "listing" && (
                <UploadCard
                  title="Listing Agreement"
                  description="Property, seller, list price, listing date, expiration, commission, your broker info."
                  active={parsing === "listing"}
                  disabled={parsing !== null}
                  inputRef={listingInputRef}
                  onPick={(e) => handleUpload(e, "listing")}
                />
              )}
              <UploadCard
                title="Purchase Contract"
                description={form.type === "listing"
                  ? "Once you're pending — buyer, price, all contingency dates, escrow & lender."
                  : "Buyer, price, all contingency dates, brokers, escrow, and lender."}
                active={parsing === "purchase"}
                disabled={parsing !== null}
                inputRef={purchaseInputRef}
                onPick={(e) => handleUpload(e, "purchase")}
              />
            </div>
            {parseError && (
              <div style={styles.parseError}><AlertCircle size={14} /> {parseError}</div>
            )}
            {parseSuccess && (
              <div style={styles.parseSuccess}>
                <CheckCircle2 size={14} /> {parseSuccess}
              </div>
            )}
          </div>

          {/* Property */}
          <FormSection title="Property" icon={Home}>
            <Field label="Street Address" full>
              <input type="text" value={form.address} onChange={(e) => update("address", e.target.value)} style={styles.input} />
            </Field>
            <Field label="City"><input type="text" value={form.city} onChange={(e) => update("city", e.target.value)} style={styles.input} /></Field>
            <Field label="State"><input type="text" value={form.state} onChange={(e) => update("state", e.target.value)} style={styles.input} maxLength={2} /></Field>
            <Field label="ZIP"><input type="text" value={form.zip} onChange={(e) => update("zip", e.target.value)} style={styles.input} /></Field>
            <Field label="Status">
              <select value={form.status} onChange={(e) => update("status", e.target.value)} style={styles.input}>
                {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
          </FormSection>

          {/* Parties */}
          <FormSection title="Seller" icon={UserCircle2}>
            <Field label="Name" full>
              <input type="text" value={form.sellerName} onChange={(e) => update("sellerName", e.target.value)} style={styles.input} placeholder="e.g. Brian and Angela Nylund" />
            </Field>
            <Field label="Email"><input type="email" value={form.sellerEmail} onChange={(e) => update("sellerEmail", e.target.value)} style={styles.input} /></Field>
            <Field label="Phone"><input type="tel" value={form.sellerPhone} onChange={(e) => update("sellerPhone", e.target.value)} style={styles.input} /></Field>
          </FormSection>

          <FormSection title="Buyer" icon={UserCircle2}>
            <Field label="Name" full>
              <input type="text" value={form.buyerName} onChange={(e) => update("buyerName", e.target.value)} style={styles.input} placeholder="e.g. Jaci and Jared Watson" />
            </Field>
            <Field label="Email"><input type="email" value={form.buyerEmail} onChange={(e) => update("buyerEmail", e.target.value)} style={styles.input} /></Field>
            <Field label="Phone"><input type="tel" value={form.buyerPhone} onChange={(e) => update("buyerPhone", e.target.value)} style={styles.input} /></Field>
          </FormSection>

          {/* Financial */}
          <FormSection title="Financial" icon={DollarSign}>
            {form.type === "listing" && (
              <Field label="List Price">
                <input type="number" value={form.listPrice} onChange={(e) => update("listPrice", e.target.value)} style={styles.input} placeholder="640000" />
              </Field>
            )}
            <Field label={form.type === "listing" ? "Purchase Price (when pending)" : "Purchase Price"}>
              <input type="number" value={form.price} onChange={(e) => update("price", e.target.value)} style={styles.input} placeholder="640000" />
            </Field>
            <Field label="Earnest Money">
              <input type="number" value={form.earnestMoney} onChange={(e) => update("earnestMoney", e.target.value)} style={styles.input} placeholder="5000" />
            </Field>
            <Field label="Down Payment">
              <input type="number" value={form.downPayment} onChange={(e) => update("downPayment", e.target.value)} style={styles.input} placeholder="70000" />
            </Field>
            <Field label="Closing Costs">
              <input type="number" value={form.closingCosts} onChange={(e) => update("closingCosts", e.target.value)} style={styles.input} placeholder="8500" />
            </Field>
            <Field label="Listing Side %">
              <input type="number" step="0.25" value={form.listingCommission}
                onChange={(e) => update("listingCommission", e.target.value)} style={styles.input} placeholder="2.5" />
            </Field>
            <Field label="Buying Side %">
              <input type="number" step="0.25" value={form.buyingCommission}
                onChange={(e) => update("buyingCommission", e.target.value)} style={styles.input} placeholder="2.5" />
            </Field>
            <Field label="Financing">
              <select value={form.financing} onChange={(e) => update("financing", e.target.value)} style={styles.input}>
                <option value="">—</option>
                {FINANCING_TYPES.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
          </FormSection>

          {/* Key dates */}
          <FormSection title="Key Dates" icon={Calendar}>
            <Field label="Mutual Acceptance">
              <input type="date" value={form.contractDate} onChange={(e) => update("contractDate", e.target.value)} style={styles.input} />
            </Field>
            <Field label="Closing Date">
              <input type="date" value={form.closingDate} onChange={(e) => update("closingDate", e.target.value)} style={styles.input} />
            </Field>
          </FormSection>

          {/* Milestones */}
          <FormSection title="Milestones & Contingencies" icon={CheckCircle2}>
            <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 10 }}>
              {form.milestones.map(m => (
                <div key={m.id} style={styles.milestoneRowEdit}>
                  {m.informational ? (
                    // Informational milestones are dates only — no checkbox
                    <div style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-soft)", fontSize: 14 }}>
                      📅
                    </div>
                  ) : (
                    <button type="button" onClick={() => updateMilestone(m.id, "complete", !m.complete)} style={styles.checkBtn}>
                      {m.complete
                        ? <CheckCircle2 size={18} style={{ color: "var(--accent)" }} />
                        : <Circle size={18} style={{ color: "var(--ink-soft)" }} />}
                    </button>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {m.custom ? (
                      <input type="text" value={m.label}
                        onChange={(e) => updateMilestone(m.id, "label", e.target.value)}
                        style={{ ...styles.input, padding: "5px 8px", fontSize: 13, fontWeight: 500 }} />
                    ) : (
                      <div style={{ fontWeight: 500, fontSize: 14, color: m.complete ? "var(--ink-soft)" : "var(--ink)" }}>
                        {m.label}
                        {m.hint && (
                          <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-soft)", fontStyle: "italic", fontWeight: 400 }}>
                            {m.hint}
                          </span>
                        )}
                      </div>
                    )}
                    <input type="text" placeholder="Notes (optional)" value={m.notes || ""}
                      onChange={(e) => updateMilestone(m.id, "notes", e.target.value)}
                      style={{ ...styles.input, padding: "5px 8px", fontSize: 12, marginTop: 4, color: "var(--ink-soft)" }} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                    {!m.noDate && (
                      <input type="date" value={m.date}
                        onChange={(e) => updateMilestone(m.id, "date", e.target.value)}
                        style={{ ...styles.input, width: 150 }} />
                    )}
                    {!m.informational && !m.noDate && (
                      <div style={styles.reminderInline} title="How many days before this date to remind you">
                        <Bell size={11} style={{ color: "var(--ink-soft)" }} />
                        <input type="number" min="0" max="60"
                          value={m.reminderDays ?? DEFAULT_REMINDER_DAYS}
                          onChange={(e) => updateMilestone(m.id, "reminderDays", e.target.value === "" ? "" : parseInt(e.target.value, 10))}
                          style={styles.reminderInput} />
                        <span>d before</span>
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => removeMilestone(m.id)}
                    style={{ ...styles.iconBtn, padding: 6 }}
                    title={m.custom ? "Remove custom milestone" : "Remove (you can add it back later as a custom milestone)"}>
                    <X size={14} />
                  </button>
                </div>
              ))}
              <div style={styles.addMilestoneRow}>
                <input type="text" placeholder="Add custom milestone (e.g. Well Inspection, Survey, HOA Approval)…"
                  value={newMilestoneLabel}
                  onChange={(e) => setNewMilestoneLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomMilestone(); } }}
                  style={{ ...styles.input, flex: 1 }} />
                <button type="button" onClick={addCustomMilestone}
                  disabled={!newMilestoneLabel.trim()}
                  style={{ ...styles.btn, ...styles.btnGhost, opacity: newMilestoneLabel.trim() ? 1 : 0.5 }}>
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
          </FormSection>

          {/* Contacts */}
          {CONTACT_ROLES.map(role => {
            const Icon = role.icon;
            return (
              <FormSection key={role.key} title={role.label} icon={Icon}>
                <Field label="Name">
                  <SmartContactInput
                    value={form.contacts[role.key].name}
                    onChange={(e) => updateContact(role.key, "name", e.target.value)}
                    onPickContact={(c) => {
                      setForm({
                        ...form,
                        contacts: {
                          ...form.contacts,
                          [role.key]: { name: c.name, company: c.company, phone: c.phone, email: c.email },
                        },
                      });
                      setIsDirty(true);
                    }}
                    directory={contactDirectory}
                  />
                </Field>
                <Field label="Company">
                  <input type="text" value={form.contacts[role.key].company}
                    onChange={(e) => updateContact(role.key, "company", e.target.value)} style={styles.input}
                    placeholder={role.key === "escrow" ? "e.g. Fidelity Title" : role.key === "lender" ? "e.g. Fibre Federal" : "Brokerage"} />
                </Field>
                <Field label="Phone">
                  <input type="tel" value={form.contacts[role.key].phone}
                    onChange={(e) => updateContact(role.key, "phone", e.target.value)} style={styles.input} />
                </Field>
                <Field label="Email">
                  <input type="email" value={form.contacts[role.key].email}
                    onChange={(e) => updateContact(role.key, "email", e.target.value)} style={styles.input} />
                </Field>
              </FormSection>
            );
          })}

          {/* Included items */}
          <FormSection title="Included Items" icon={Package}>
            <Field full>
              <input type="text" value={form.includedItems}
                onChange={(e) => update("includedItems", e.target.value)} style={styles.input}
                placeholder="e.g. Stove, fridge, dishwasher, washer, dryer" />
            </Field>
          </FormSection>

          {/* Notes */}
          <FormSection title="Notes" icon={FileText}>
            <Field full>
              <textarea value={form.notes} onChange={(e) => update("notes", e.target.value)}
                style={{ ...styles.input, minHeight: 90, resize: "vertical", fontFamily: "var(--font-body)" }}
                placeholder="Anything else worth remembering…" />
            </Field>
          </FormSection>
        </div>

        <div style={styles.modalFooter}>
          <button onClick={safeClose} style={{ ...styles.btn, ...styles.btnGhost }}>Cancel</button>
          <button onClick={() => onSave(form)} style={{ ...styles.btn, ...styles.btnPrimary }}>Save Transaction</button>
        </div>
      </div>
    </div>
  );
}

// Name input with autocomplete from the contact directory. Shows matching
// contacts in a dropdown as the user types. Clicking a suggestion fires
// onPickContact with the full contact info — caller is responsible for
// filling all related fields (name/company/phone/email).
function SmartContactInput({ value, onChange, onPickContact, directory }) {
  const [open, setOpen] = useState(false);
  const blurTimerRef = useRef(null);

  const matches = useMemo(() => {
    const q = (value || "").trim().toLowerCase();
    if (!q || !directory) return [];
    return directory
      .filter(c => c.name.toLowerCase().includes(q) && c.name.toLowerCase() !== q)
      .slice(0, 5);
  }, [value, directory]);

  const showDropdown = open && matches.length > 0;

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={value}
        onChange={onChange}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so clicking a suggestion has time to fire onClick before we hide
          blurTimerRef.current = setTimeout(() => setOpen(false), 150);
        }}
        style={styles.input}
        autoComplete="off"
      />
      {showDropdown && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          marginTop: 4,
          background: "var(--paper)",
          border: "1px solid var(--ink-line)",
          borderRadius: 8,
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
          zIndex: 50,
          overflow: "hidden",
        }}>
          <div style={{
            padding: "6px 12px",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-soft)",
            background: "var(--paper-soft)",
            borderBottom: "1px solid var(--ink-line)",
          }}>
            From your contacts
          </div>
          {matches.map((m, idx) => (
            <button
              key={`${m.name}-${idx}`}
              type="button"
              onMouseDown={(e) => {
                // Use mouseDown (fires before blur) to avoid timing issues
                e.preventDefault();
                if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
                onPickContact(m);
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "10px 12px",
                background: "transparent",
                border: "none",
                borderBottom: idx < matches.length - 1 ? "1px solid var(--ink-line)" : "none",
                textAlign: "left",
                cursor: "pointer",
                color: "var(--ink)",
                fontFamily: "var(--font-body)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--paper-soft)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</div>
              <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 2 }}>
                {[m.company, m.phone, m.email].filter(Boolean).join(" · ") || "—"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FormSection({ title, icon: Icon, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={styles.formSectionTitle}>
        {Icon && <Icon size={11} style={{ marginRight: 6, verticalAlign: -1 }} />}
        {title}
      </div>
      <div style={styles.formGrid}>{children}</div>
    </div>
  );
}

function Field({ label, children, full }) {
  return (
    <label style={{ ...styles.field, ...(full ? { gridColumn: "1 / -1" } : {}) }}>
      {label && <span style={styles.fieldLabel}>{label}</span>}
      {children}
    </label>
  );
}

function UploadCard({ title, description, active, disabled, inputRef, onPick }) {
  return (
    <div style={styles.uploaderBox}>
      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)", marginBottom: 4 }}>
        {title}
      </div>
      <p style={{ fontSize: 12, color: "var(--ink-soft)", margin: "0 0 12px 0", lineHeight: 1.5, minHeight: 32 }}>
        {description}
      </p>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf"
        onChange={onPick} style={{ display: "none" }} disabled={disabled} />
      <button type="button" onClick={() => inputRef.current?.click()}
        disabled={disabled}
        style={{
          ...styles.btn,
          ...(active ? styles.btnPrimary : styles.btnGhost),
          width: "100%",
          justifyContent: "center",
          opacity: disabled && !active ? 0.5 : 1,
          cursor: disabled ? "wait" : "pointer",
        }}>
        {active
          ? <><Loader2 size={14} className="spin" /> Reading…</>
          : <><Upload size={14} /> Upload PDF</>}
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DETAIL MODAL
// ════════════════════════════════════════════════════════════════════════════
function DetailModal({ txn, onClose, onEdit, onDelete, onUpdate, isCloud }) {
  const status = STATUS_OPTIONS.find(s => s.value === txn.status) || STATUS_OPTIONS[0];
  const [showShare, setShowShare] = useState(false);

  const toggleMilestone = (id) => {
    onUpdate({
      ...txn,
      milestones: txn.milestones.map(m => m.id === id ? { ...m, complete: !m.complete } : m),
    });
  };

  const hasContacts = CONTACT_ROLES.some(r => txn.contacts[r.key].name);

  return (
    <div style={styles.modalBackdrop}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{
                ...styles.typePill,
                ...(txn.type === "listing"
                  ? { background: "var(--ink)", color: "var(--paper)" }
                  : { background: "transparent", color: "var(--ink)", border: "1px solid var(--ink)" }),
              }}>
                {txn.type === "listing" ? "LISTING" : "BUYER"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-soft)" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: status.color }} />
                {status.label}
              </div>
            </div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--ink)", lineHeight: 1.2 }}>
              {txn.address || "No address"}
            </div>
            <div style={{ fontSize: 14, color: "var(--ink-soft)", marginTop: 2 }}>
              {[txn.city, txn.state, txn.zip].filter(Boolean).join(", ") || "—"}
            </div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>

        {/* ─── Stage transfer buttons ─────────────────────────────────────
            Quick way to move this transaction between Active / Pending / Closed
            without opening the edit form. Different buttons depending on
            the transaction's current stage. */}
        <div style={{
          display: "flex",
          gap: 8,
          padding: "12px 20px",
          background: "var(--paper-soft)",
          borderBottom: "1px solid var(--ink-line)",
          flexWrap: "wrap",
        }}>
          {isActiveStage(txn) && (
            <button
              onClick={() => onUpdate({ ...txn, status: "pending" })}
              style={{ ...styles.btn, ...styles.btnPrimary, fontSize: 12 }}
              title="Move this transaction to the Pending Transactions tab">
              → Transfer to Pending
            </button>
          )}
          {isPendingStage(txn) && (
            <>
              <button
                onClick={() => onUpdate({ ...txn, status: "active" })}
                style={{ ...styles.btn, ...styles.btnGhost, fontSize: 12 }}
                title="Deal fell through — return to Active Transactions">
                ← Back to Active
              </button>
              <button
                onClick={() => {
                  if (confirm("Mark this transaction as Sold? It will move to the Closed Transactions tab.")) {
                    onUpdate({ ...txn, status: "closed" });
                  }
                }}
                style={{ ...styles.btn, ...styles.btnPrimary, fontSize: 12, background: "#7b9a5a", borderColor: "#7b9a5a" }}
                title="Mark sold and move to Closed">
                ✓ Mark Sold
              </button>
            </>
          )}
          {isClosedStage(txn) && (
            <button
              onClick={() => onUpdate({ ...txn, status: "active" })}
              style={{ ...styles.btn, ...styles.btnGhost, fontSize: 12 }}
              title="Move back to Active">
              ↺ Reopen as Active
            </button>
          )}
        </div>

        <div style={styles.modalBody}>
          {/* Financial snapshot */}
          <div style={styles.factGrid}>
            {txn.listPrice && txn.type === "listing" && <Fact icon={DollarSign} label="List Price" value={fmtMoney(txn.listPrice)} />}
            <Fact icon={DollarSign} label={txn.type === "listing" && !txn.contractDate ? "Asking" : "Price"} value={fmtMoney(txn.price)} />
            {txn.earnestMoney && <Fact icon={PiggyBank} label="Earnest Money" value={fmtMoney(txn.earnestMoney)} />}
            {txn.downPayment && <Fact icon={DollarSign} label="Down Payment" value={fmtMoney(txn.downPayment)} />}
            {txn.closingCosts && <Fact icon={DollarSign} label="Closing Costs" value={fmtMoney(txn.closingCosts)} />}
            {txn.commission && !txn.listingCommission && !txn.buyingCommission && <Fact icon={Percent} label="Commission" value={`${txn.commission}%`} />}
            {txn.listingCommission && <Fact icon={Percent} label="Listing Side" value={`${txn.listingCommission}%`} />}
            {txn.buyingCommission && <Fact icon={Percent} label="Buying Side" value={`${txn.buyingCommission}%`} />}
            {txn.financing && <Fact icon={Landmark} label="Financing" value={txn.financing} />}
            {txn.contractDate && <Fact icon={Calendar} label="Mutual Acceptance" value={fmtDate(txn.contractDate)} />}
            {txn.closingDate && <Fact icon={Calendar} label="Closing" value={fmtDate(txn.closingDate)} />}
          </div>

          {/* Parties */}
          {(txn.sellerName || txn.buyerName) && (
            <div style={{ marginTop: 28 }}>
              <div style={styles.formSectionTitle}>
                <UserCircle2 size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Parties
              </div>
              <div style={styles.partyGrid}>
                <PartyCard label="Seller" name={txn.sellerName} email={txn.sellerEmail} phone={txn.sellerPhone} />
                <PartyCard label="Buyer"  name={txn.buyerName}  email={txn.buyerEmail}  phone={txn.buyerPhone}  />
              </div>
            </div>
          )}

          {/* Milestones */}
          <div style={{ marginTop: 28 }}>
            <div style={styles.formSectionTitle}>
              <CheckCircle2 size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Timeline
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {txn.milestones.map(m => {
                const days = daysUntil(m.date);
                const upcoming = !m.complete && !m.informational && m.date && days !== null;
                return (
                  <div key={m.id} style={styles.milestoneRow}>
                    {m.informational ? (
                      <div style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-soft)", fontSize: 14 }}>
                        📅
                      </div>
                    ) : (
                      <button onClick={() => toggleMilestone(m.id)} style={styles.checkBtn}>
                        {m.complete
                          ? <CheckCircle2 size={18} style={{ color: "var(--accent)" }} />
                          : <Circle size={18} style={{ color: "var(--ink-soft)" }} />}
                      </button>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, color: m.complete ? "var(--ink-soft)" : "var(--ink)" }}>
                        {m.label}
                        {m.custom && <span style={styles.customTag}>custom</span>}
                        {m.hint && (
                          <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-soft)", fontStyle: "italic", fontWeight: 400 }}>
                            {m.hint}
                          </span>
                        )}
                      </div>
                      {m.notes && <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 2 }}>{m.notes}</div>}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums", minWidth: 130, textAlign: "right" }}>
                      {m.noDate ? "—" : fmtDate(m.date)}
                      {upcoming && (() => {
                        const lead = m.reminderDays ?? DEFAULT_REMINDER_DAYS;
                        return (
                          <span style={{ marginLeft: 8, color: days <= Math.max(lead, 0) ? "var(--accent)" : "var(--ink-soft)", fontWeight: 500 }}>
                            {days < 0 ? `${Math.abs(days)}d late` : days === 0 ? "today" : `${days}d`}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Contacts */}
          {hasContacts && (
            <div style={{ marginTop: 28 }}>
              <div style={styles.formSectionTitle}>
                <Briefcase size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Contacts
              </div>
              <div style={styles.contactGrid}>
                {CONTACT_ROLES.map(role => {
                  const c = txn.contacts[role.key];
                  if (!c.name) return null;
                  return <ContactCard key={role.key} role={role} contact={c} />;
                })}
              </div>
            </div>
          )}

          {/* Pre-listing checklist (only for listings) */}
          {txn.type === "listing" && (
            <ChecklistSection
              title="Pre-Listing Checklist"
              icon={CheckCircle2}
              items={txn.prelistChecklist || []}
              onChange={(items) => onUpdate({ ...txn, prelistChecklist: items })}
              templates={loadPrelistTemplates()}
              onApplyTemplate={(t) => onUpdate({
                ...txn,
                prelistChecklist: t.items.map(text => ({ id: newId(), text, done: false })),
              })}
            />
          )}

          {/* Closing checklist */}
          <ChecklistSection
            title="Closing Checklist"
            icon={CheckCircle2}
            items={txn.closingChecklist || []}
            onChange={(items) => onUpdate({ ...txn, closingChecklist: items })}
            templates={[loadClosingTemplate()]}
            onApplyTemplate={(t) => onUpdate({
              ...txn,
              closingChecklist: t.items.map(text => ({ id: newId(), text, done: false })),
            })}
          />

          {/* Client portal access */}
          <ClientPortalSection txn={txn} onUpdate={onUpdate} />

          {/* Documents — file uploads attached to this transaction */}
          <DocumentsSection txn={txn} onUpdate={onUpdate} isCloud={isCloud} />

          {/* Draft Emails — quick mailto: drafts for common recipients */}
          <div style={{ marginTop: 28 }}>
            <div style={styles.formSectionTitle}>
              <Mail size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Draft Emails
            </div>
            <div style={{ padding: 14, background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12 }}>
              <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 12, lineHeight: 1.5 }}>
                Each button opens your default mail app with a pre-filled email — review, edit if needed, then send from your own email.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
                <DraftEmailButton
                  label={txn.type === "listing" ? "Buyer's Agent" : "Listing Agent"}
                  hint={(txn.type === "listing" ? txn.contacts?.sellingBroker : txn.contacts?.listingBroker)?.email || "no email on file"}
                  available={!!(txn.type === "listing" ? txn.contacts?.sellingBroker?.email : txn.contacts?.listingBroker?.email)}
                  onClick={() => draftEmailToOtherAgent(txn)}
                />
                <DraftEmailButton
                  label="Escrow"
                  hint={txn.contacts?.escrow?.email || "no email on file"}
                  available={!!txn.contacts?.escrow?.email}
                  onClick={() => draftEmailToEscrow(txn)}
                />
                <DraftEmailButton
                  label="Lender"
                  hint={txn.contacts?.lender?.email || "no email on file"}
                  available={!!txn.contacts?.lender?.email}
                  onClick={() => draftEmailToLender(txn)}
                />
                <DraftEmailButton
                  label={txn.type === "listing" ? "Your Seller" : "Your Buyer"}
                  hint={(txn.type === "listing" ? txn.sellerEmail : txn.buyerEmail) || "no email on file"}
                  available={!!(txn.type === "listing" ? txn.sellerEmail : txn.buyerEmail)}
                  onClick={() => draftEmailToClient(txn)}
                />
              </div>
            </div>
          </div>

          {/* Included items */}
          {txn.includedItems && (
            <div style={{ marginTop: 28 }}>
              <div style={styles.formSectionTitle}>
                <Package size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Included
              </div>
              <div style={styles.includedBlock}>{txn.includedItems}</div>
            </div>
          )}

          {/* Notes */}
          {txn.notes && (
            <div style={{ marginTop: 28 }}>
              <div style={styles.formSectionTitle}>
                <FileText size={11} style={{ marginRight: 6, verticalAlign: -1 }} /> Notes
              </div>
              <div style={styles.notesBlock}>{txn.notes}</div>
            </div>
          )}
        </div>

        <div style={styles.modalFooter}>
          <button onClick={onDelete} style={{ ...styles.btn, ...styles.btnDanger }}>
            <Trash2 size={14} /> Delete
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={() => printTransaction(txn)} style={{ ...styles.btn, ...styles.btnGhost }}>
            🖨 Print
          </button>
          <button onClick={() => setShowShare(true)} style={{ ...styles.btn, ...styles.btnGhost }}>
            <FileText size={14} /> Share
          </button>
          <button onClick={() => downloadICS(txn)} style={{ ...styles.btn, ...styles.btnGhost }}>
            <Download size={14} /> Calendar
          </button>
          <button onClick={onEdit} style={{ ...styles.btn, ...styles.btnPrimary }}>
            <Edit3 size={14} /> Edit
          </button>
        </div>
      </div>
      {showShare && <ShareModal txn={txn} onClose={() => setShowShare(false)} />}
    </div>
  );
}

function Fact({ icon: Icon, label, value }) {
  return (
    <div style={styles.fact}>
      <div style={styles.factLabel}>{Icon && <Icon size={12} />} {label}</div>
      <div style={styles.factValue}>{value}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SHARE MODAL — formatted text + print/PDF for sending to co-broker
// ════════════════════════════════════════════════════════════════════════════
function formatSummaryText(txn) {
  const lines = [];
  const push = (s) => lines.push(s);
  const pushIf = (cond, s) => { if (cond) push(s); };

  push("PROPERTY DETAILS");
  pushIf(txn.address, `Address: ${txn.address}${txn.city ? `, ${txn.city}` : ""}${txn.state ? `, ${txn.state}` : ""}${txn.zip ? ` ${txn.zip}` : ""}`);
  pushIf(txn.sellerName, `Seller: ${txn.sellerName}`);
  pushIf(txn.buyerName,  `Buyer: ${txn.buyerName}`);
  push("");

  push("CONTRACT TERMS & TIMELINES");
  pushIf(txn.listPrice && txn.type === "listing", `List Price: ${fmtMoney(txn.listPrice)}`);
  pushIf(txn.price,        `Purchase Price: ${fmtMoney(txn.price)}`);
  pushIf(txn.contractDate, `Mutual Acceptance: ${fmtDate(txn.contractDate)}`);
  pushIf(txn.earnestMoney, `Earnest Money: ${fmtMoney(txn.earnestMoney)}`);
  pushIf(txn.closingDate,  `Closing Date: ${fmtDate(txn.closingDate)}`);
  pushIf(txn.commission && !txn.listingCommission && !txn.buyingCommission, `Commission: ${txn.commission}%`);
  pushIf(txn.listingCommission, `Listing Side Commission: ${txn.listingCommission}%`);
  pushIf(txn.buyingCommission, `Buying Side Commission: ${txn.buyingCommission}%`);
  pushIf(txn.downPayment,  `Down Payment: ${fmtMoney(txn.downPayment)}`);
  pushIf(txn.financing,    `Financing: ${txn.financing}`);
  pushIf(txn.closingCosts, `Closing Costs: ${fmtMoney(txn.closingCosts)}`);
  push("");

  // Milestones with dates
  const datedMilestones = txn.milestones.filter(m => m.date);
  if (datedMilestones.length) {
    push("TIMELINE");
    datedMilestones.forEach(m => {
      const check = m.complete ? "✓" : "○";
      const note = m.notes ? ` — ${m.notes}` : "";
      push(`${check} ${m.label}: ${fmtDate(m.date)}${note}`);
    });
    push("");
  }

  pushIf(txn.includedItems, `INCLUDED ITEMS\n${txn.includedItems}`);
  pushIf(txn.includedItems, "");

  // Contacts
  const hasContacts = CONTACT_ROLES.some(r => txn.contacts[r.key].name);
  if (hasContacts) {
    push("CONTACT INFORMATION");
    CONTACT_ROLES.forEach(role => {
      const c = txn.contacts[role.key];
      if (!c.name) return;
      const company = c.company ? `, ${c.company}` : "";
      const phone = c.phone ? ` ${c.phone}` : "";
      const email = c.email ? ` | ${c.email}` : "";
      push(`${role.label}: ${c.name}${company}${phone}${email}`);
    });
    push("");
  }

  if (txn.notes) { push("NOTES"); push(txn.notes); }

  return lines.join("\n").trim();
}

function ShareModal({ txn, onClose }) {
  const [copied, setCopied] = useState(false);
  const text = formatSummaryText(txn);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      // Fallback: select the textarea
      const ta = document.getElementById("share-summary-text");
      if (ta) { ta.select(); document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    }
  };

  const print = () => {
    const w = window.open("", "_blank", "width=720,height=900");
    if (!w) { alert("Pop-up blocked — allow pop-ups for this page to print."); return; }
    const safe = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    w.document.write(`<!doctype html><html><head><title>${safe(txn.address || "Transaction")}</title>
      <style>
        body { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; padding: 0 40px; color: #1a2c47; line-height: 1.5; }
        h1 { font-size: 22px; margin: 0 0 4px 0; }
        h2 { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7585; font-weight: 700; margin-top: 28px; margin-bottom: 10px; border-bottom: 1px solid #d3d7df; padding-bottom: 4px; }
        .meta { color: #6b7585; font-size: 13px; margin-bottom: 16px; }
        .row { padding: 4px 0; font-size: 14px; }
        .row b { display: inline-block; min-width: 160px; color: #6b7585; font-weight: 500; }
        pre { font-family: inherit; white-space: pre-wrap; font-size: 14px; }
        @media print { body { margin: 0; padding: 0 20px; } }
      </style></head><body>
      <h1>${safe(txn.address || "Transaction")}</h1>
      <div class="meta">${safe([txn.city, txn.state, txn.zip].filter(Boolean).join(", "))}
        — ${txn.type === "listing" ? "Listing" : "Buyer Transaction"}</div>
      <pre>${safe(text)}</pre>
      <script>window.onload = function() { window.print(); };</script>
      </body></html>`);
    w.document.close();
  };

  return (
    <div style={{ ...styles.modalBackdrop, zIndex: 200 }} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div>
            <div style={styles.eyebrow}>Share Summary</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--ink)" }}>Send to co-broker</div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 14px 0", lineHeight: 1.5 }}>
            Copy this clean summary into an email/text, or print it as a PDF.
            Note: this is a one-way share — your co-broker won't be able to edit it back into the app.
            For live collaboration, the app would need to be deployed with a shared database.
          </p>
          <textarea id="share-summary-text" value={text} readOnly
            style={{ ...styles.input, width: "100%", minHeight: 380, fontFamily: "var(--font-body)", fontSize: 13, lineHeight: 1.5, resize: "vertical" }} />
        </div>
        <div style={styles.modalFooter}>
          <div style={{ flex: 1, color: copied ? "var(--accent)" : "var(--ink-soft)", fontSize: 13, transition: "color 0.2s" }}>
            {copied ? "✓ Copied to clipboard" : ""}
          </div>
          <button onClick={print} style={{ ...styles.btn, ...styles.btnGhost }}>
            <FileText size={14} /> Print / PDF
          </button>
          <button onClick={copy} style={{ ...styles.btn, ...styles.btnPrimary }}>
            <Download size={14} /> Copy Text
          </button>
        </div>
      </div>
    </div>
  );
}

function PartyCard({ label, name, email, phone }) {
  if (!name && !email && !phone) return null;
  return (
    <div style={styles.partyCard}>
      <div style={styles.partyLabel}>{label}</div>
      <div style={styles.partyName}>{name || "—"}</div>
      <div style={styles.partyContacts}>
        {email && <a href={`mailto:${email}`} style={styles.partyLink}><Mail size={12} /> {email}</a>}
        {phone && <a href={`tel:${phone}`} style={styles.partyLink}><Phone size={12} /> {phone}</a>}
      </div>
    </div>
  );
}

function ContactCard({ role, contact }) {
  const Icon = role.icon;
  return (
    <div style={styles.contactCard}>
      <div style={styles.contactHeader}>
        <Icon size={14} style={{ color: "var(--accent)" }} />
        <span style={styles.contactRoleLabel}>{role.label}</span>
      </div>
      <div style={styles.contactName}>{contact.name}</div>
      {contact.company && <div style={styles.contactCompany}>{contact.company}</div>}
      <div style={styles.contactLinks}>
        {contact.phone && (
          <a href={`tel:${contact.phone}`} style={styles.contactLink}>
            <Phone size={12} /> {contact.phone}
          </a>
        )}
        {contact.email && (
          <a href={`mailto:${contact.email}`} style={styles.contactLink}>
            <Mail size={12} /> {contact.email}
          </a>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════════════════
function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Manrope:wght@300;400;500;600;700&display=swap');

      :root {
        --paper: #f5f6f8;
        --paper-soft: #eaecf0;
        --ink: #1a2c47;
        --ink-soft: #6b7585;
        --ink-line: #d3d7df;
        --accent: #c4602f;
        --accent-soft: #e0a98c;
        --font-display: 'Fraunces', Georgia, serif;
        --font-body: 'Manrope', system-ui, sans-serif;
      }

      * { box-sizing: border-box; }
      body, html { margin: 0; padding: 0; background: var(--paper); }
      button { font-family: var(--font-body); cursor: pointer; }
      input, select, textarea { font-family: var(--font-body); }
      input:focus, select:focus, textarea:focus {
        outline: none; border-color: var(--ink) !important;
      }
      a { color: var(--ink); }

      button[data-card]:hover {
        transform: translateY(-2px);
        border-color: var(--ink) !important;
        box-shadow: 0 8px 24px -8px rgba(29, 26, 22, 0.15);
      }

      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: var(--ink-line); border-radius: 10px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--ink-soft); }

      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes spin { to { transform: rotate(360deg); } }
      .spin { animation: spin 1s linear infinite; }

      button[data-urgent]:hover {
        background: rgba(255, 255, 255, 0.15) !important;
        transform: translateY(-1px);
      }

      /* Home base link tiles + recent rows */
      a[href][target="_blank"]:hover {
        transform: translateY(-2px);
        border-color: var(--ink) !important;
        box-shadow: 0 6px 18px -6px rgba(29, 26, 22, 0.18);
      }

      /* Responsive: stack home grid on smaller screens */
      @media (max-width: 900px) {
        .home-grid { grid-template-columns: 1fr !important; }
        .widget-grid { grid-template-columns: 1fr !important; }
      }
      @media (max-width: 720px) {
        .todos-row { grid-template-columns: 1fr !important; }
      }

      /* Add-widget card hover */
      button[data-add-widget]:hover {
        border-color: var(--ink) !important;
        background: var(--paper-soft) !important;
        transform: translateY(-1px);
      }

      /* FAB hover */
      .fab-button:hover { transform: scale(1.05); }

      /* FAB menu items + search results hover */
      button[style*="searchResult"]:hover,
      button[style*="fabMenuItem"]:hover {
        background: var(--paper-soft) !important;
      }
    `}</style>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// CLIENT PORTAL VIEW — public read-only page for clients
// ════════════════════════════════════════════════════════════════════════════
function ClientPortalView({ token }) {
  const [state, setState] = useState({ loading: true, error: null, txn: null });

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/portal-fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (!res.ok) {
          setState({ loading: false, error: data.error || `Couldn't load portal (${res.status})`, txn: null });
          return;
        }
        setState({ loading: false, error: null, txn: data.transaction });
      } catch (e) {
        setState({ loading: false, error: e.message || "Network error", txn: null });
      }
    })();
  }, [token]);

  const wrap = {
    minHeight: "100vh",
    background: "#f5f6f8",
    color: "#1a2c47",
    fontFamily: "var(--font-body), system-ui, sans-serif",
    padding: "40px 20px",
  };
  const card = {
    maxWidth: 760,
    margin: "0 auto",
    background: "#fff",
    border: "1px solid #d3d7df",
    borderRadius: 16,
    overflow: "hidden",
  };

  if (state.loading) {
    return (
      <div style={wrap}>
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#6b7585" }}>
          Loading your transaction…
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div style={wrap}>
        <div style={{ ...card, padding: 40, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display), Georgia, serif", fontSize: 22, marginBottom: 8 }}>
            Link not active
          </div>
          <div style={{ color: "#6b7585", fontSize: 14 }}>{state.error}</div>
          <div style={{ color: "#6b7585", fontSize: 13, marginTop: 16 }}>
            Please contact your broker for an updated link.
          </div>
        </div>
      </div>
    );
  }

  const txn = state.txn;
  const portal = txn.clientPortal || {};
  // Preserve the original milestone order from the transaction — that
  // matches the order in the broker's "visible to client" checklist, so
  // clients see them in a predictable order (not shuffled by dates).
  const sortedMs = txn.milestones || [];
  const docs = txn.documents || [];

  return (
    <div style={wrap}>
      <div style={card}>
        {/* Header */}
        <div style={{ padding: "28px 32px 20px", borderBottom: "1px solid #d3d7df", background: "#1a2c47", color: "#f5f6f8" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em", color: "#a8b4c4", marginBottom: 8 }}>
            Transaction Portal · The Jesse Cope Team
          </div>
          <div style={{ fontFamily: "var(--font-display), Georgia, serif", fontSize: 26, lineHeight: 1.2 }}>
            {txn.address || "Your Transaction"}
          </div>
          <div style={{ fontSize: 14, color: "#a8b4c4", marginTop: 4 }}>
            {[txn.city, txn.state, txn.zip].filter(Boolean).join(", ") || ""}
          </div>
        </div>

        {/* Status */}
        <div style={{ padding: "20px 32px", borderBottom: "1px solid #d3d7df", background: "#eaecf0" }}>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6b7585", marginBottom: 4 }}>Status</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {(txn.status || "active").replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase())}
              </div>
            </div>
            {txn.closingDate && (
              <div>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6b7585", marginBottom: 4 }}>Closing Date</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {new Date(txn.closingDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                </div>
              </div>
            )}
            {txn.price && portal.showFinancials !== false && (
              <div>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6b7585", marginBottom: 4 }}>Price</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  ${Number(txn.price).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Notes from broker */}
        {portal.clientNotes && (
          <div style={{ padding: "20px 32px", borderBottom: "1px solid #d3d7df" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6b7585", fontWeight: 600, marginBottom: 10 }}>
              Notes from your Broker
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {portal.clientNotes}
            </div>
          </div>
        )}

        {/* Timeline */}
        {sortedMs.length > 0 && (
          <div style={{ padding: "20px 32px", borderBottom: "1px solid #d3d7df" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6b7585", fontWeight: 600, marginBottom: 12 }}>
              Timeline
            </div>
            {sortedMs.map(m => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #eaecf0" }}>
                <div style={{
                  width: 12, height: 12, borderRadius: "50%",
                  background: m.complete ? "#7b9a5a" : "#d3d7df",
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: m.complete ? 400 : 500, color: m.complete ? "#6b7585" : "#1a2c47", textDecoration: m.complete ? "line-through" : "none" }}>
                    {m.label}
                  </div>
                </div>
                {m.date && (
                  <div style={{ fontSize: 12, color: "#6b7585" }}>
                    {new Date(m.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Documents */}
        {docs.length > 0 && (
          <div style={{ padding: "20px 32px", borderBottom: "1px solid #d3d7df" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6b7585", fontWeight: 600, marginBottom: 12 }}>
              Documents
            </div>
            {docs.map(doc => (
              <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #eaecf0" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{doc.name}</div>
                  <div style={{ fontSize: 11, color: "#6b7585" }}>
                    {doc.size ? `${(doc.size / 1024).toFixed(0)} KB` : ""}
                  </div>
                </div>
                {doc.downloadUrl ? (
                  <a href={doc.downloadUrl} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 12, color: "#c4602f", textDecoration: "none", padding: "6px 12px", border: "1px solid #c4602f", borderRadius: 6 }}>
                    Download
                  </a>
                ) : (
                  <div style={{ fontSize: 11, color: "#6b7585", fontStyle: "italic" }}>Unavailable</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ─── Contacts ─────────────────────────────────────────────────
            Show contacts relevant to the client: their broker (Jesse's team),
            the other broker, escrow officer, and lender. Only shows contacts
            that actually have a name. */}
        {(() => {
          const contacts = txn.contacts || {};
          const buildContactList = () => {
            // For a listing transaction, the client is the SELLER, so their broker
            // is the listing broker. For a buyer transaction, they're the BUYER,
            // so their broker is the selling broker.
            const isListing = txn.type === "listing";
            const yourBrokerKey = isListing ? "listingBroker" : "sellingBroker";
            const otherBrokerKey = isListing ? "sellingBroker" : "listingBroker";
            return [
              { label: "Your Broker", contact: contacts[yourBrokerKey] },
              { label: isListing ? "Buyer's Broker" : "Seller's Broker", contact: contacts[otherBrokerKey] },
              { label: "Escrow Officer", contact: contacts.escrow },
              { label: "Lender", contact: contacts.lender },
            ].filter(c => c.contact && c.contact.name && c.contact.name.trim());
          };
          const contactList = buildContactList();
          if (contactList.length === 0) return null;
          return (
            <div style={{ padding: "20px 32px", borderBottom: "1px solid #d3d7df" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6b7585", fontWeight: 600, marginBottom: 12 }}>
                Your Team
              </div>
              {contactList.map((c, i) => (
                <div key={i} style={{ padding: "10px 0", borderBottom: i < contactList.length - 1 ? "1px solid #eaecf0" : "none" }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#8b96a5", fontWeight: 600, marginBottom: 4 }}>
                    {c.label}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#1a2c47" }}>
                    {c.contact.name}
                  </div>
                  {c.contact.company && (
                    <div style={{ fontSize: 12, color: "#6b7585", marginTop: 2 }}>{c.contact.company}</div>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
                    {c.contact.phone && (
                      <a href={`tel:${c.contact.phone}`} style={{ fontSize: 12, color: "#c4602f", textDecoration: "none" }}>
                        📞 {c.contact.phone}
                      </a>
                    )}
                    {c.contact.email && (
                      <a href={`mailto:${c.contact.email}`} style={{ fontSize: 12, color: "#c4602f", textDecoration: "none" }}>
                        ✉ {c.contact.email}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Contact footer */}
        <div style={{ padding: "20px 32px", background: "#eaecf0", textAlign: "center", fontSize: 12, color: "#6b7585" }}>
          Questions? Contact The Jesse Cope Team · RE/MAX Premier Group
          <br />
          842 Washington Way, Suite 150, Longview, WA 98632
        </div>
      </div>
      <div style={{ textAlign: "center", color: "#6b7585", fontSize: 11, marginTop: 16 }}>
        This is a secure read-only view. Bookmark this page to revisit.
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SOCIAL MEDIA TAB — generate on-brand Facebook/Instagram posts
// Calls the /api/social-generate serverless function
// ════════════════════════════════════════════════════════════════════════════
const SOCIAL_POST_TYPES = [
  { value: "surprise", label: "🎲 Surprise me (best pick today)" },
  { value: "lifestyle", label: "🏔️ Local lifestyle" },
  { value: "first_time_buyer", label: "🔑 First-time buyer" },
  { value: "myth_buster", label: "💥 Myth-buster" },
  { value: "seasonal_tip", label: "🔨 Seasonal home tip" },
  { value: "engagement", label: "💬 Engagement question" },
  { value: "just_listed_teaser", label: "👀 Just-listed teaser" },
];

function socialFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

function SocialMediaTab() {
  const [mode, setMode] = useState("random");
  const [postType, setPostType] = useState("surprise");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState(null);
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);

  // Brand palette (matches the original SocialMediaTab file)
  const C = {
    cream: "#F5F1E8", card: "#FBF9F4", taupe: "#8A7E6B",
    taupeLight: "#D8CFBE", charcoal: "#2E2B26", ink: "#4A453D",
    red: "#C8102E", redDark: "#A00D25", line: "#E4DCCB",
  };
  const serif = "Cambria, Georgia, 'Times New Roman', serif";

  async function generate() {
    setError(""); setCopied(""); setLoading(true);
    try {
      let body;
      if (mode === "listing") {
        if (!file) throw new Error("Upload an MLS listing sheet (PDF) first.");
        const pdfBase64 = await socialFileToBase64(file);
        body = { mode: "listing", pdfBase64, notes };
      } else {
        body = { mode: "random", postType, notes };
      }
      const res = await fetch("/api/social-generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed.");
      setResult(data.post || "");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed — select the text and copy manually.");
    }
  }

  const s = {
    wrap: { fontFamily: serif, color: C.charcoal, background: C.cream, padding: "28px", borderRadius: 14, maxWidth: 760, margin: "0 auto" },
    h1: { fontSize: 26, margin: "0 0 4px", letterSpacing: 0.3 },
    sub: { color: C.taupe, fontSize: 14, margin: "0 0 22px" },
    toggleRow: { display: "flex", gap: 8, marginBottom: 22 },
    toggle: (active) => ({
      flex: 1, padding: "12px 14px", borderRadius: 10,
      border: `1px solid ${active ? C.charcoal : C.line}`,
      background: active ? C.charcoal : C.card, color: active ? C.cream : C.ink,
      cursor: "pointer", fontFamily: serif, fontSize: 15,
    }),
    card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 18 },
    label: { display: "block", fontSize: 13, color: C.taupe, marginBottom: 6, letterSpacing: 0.4, textTransform: "uppercase" },
    select: { width: "100%", padding: "11px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: "#fff", fontFamily: serif, fontSize: 15, color: C.ink, marginBottom: 16 },
    textarea: { width: "100%", boxSizing: "border-box", padding: "11px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: "#fff", fontFamily: serif, fontSize: 15, color: C.ink, resize: "vertical", minHeight: 60 },
    dropZone: { border: `1.5px dashed ${C.taupeLight}`, borderRadius: 10, padding: "26px 18px", textAlign: "center", background: "#fff", cursor: "pointer", marginBottom: 16, color: C.taupe },
    genBtn: {
      width: "100%", padding: "14px", borderRadius: 10, border: "none",
      background: loading ? C.taupe : C.red, color: "#fff",
      fontFamily: serif, fontSize: 17, letterSpacing: 0.4,
      cursor: loading ? "default" : "pointer",
      boxShadow: loading ? "none" : "0 2px 0 " + C.redDark,
    },
    resultCard: { background: "#fff", border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, marginTop: 8 },
    resultText: { width: "100%", boxSizing: "border-box", minHeight: 200, padding: 14, borderRadius: 8, border: `1px solid ${C.line}`, fontFamily: serif, fontSize: 16, lineHeight: 1.5, color: C.charcoal, resize: "vertical", whiteSpace: "pre-wrap" },
    actionRow: { display: "flex", gap: 10, marginTop: 12 },
    smallBtn: (primary) => ({
      padding: "10px 16px", borderRadius: 8,
      border: `1px solid ${primary ? C.charcoal : C.line}`,
      background: primary ? C.charcoal : C.card,
      color: primary ? C.cream : C.ink,
      fontFamily: serif, fontSize: 14, cursor: "pointer",
    }),
    error: { background: "#FBEAEA", border: `1px solid ${C.red}`, color: C.redDark, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginTop: 14 },
    hint: { color: C.taupe, fontSize: 12.5, marginTop: 4 },
  };

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Social Media</h1>
      <p style={s.sub}>Fresh, on-brand posts for Facebook &amp; Instagram — in seconds.</p>

      <div style={s.toggleRow}>
        <button style={s.toggle(mode === "random")} onClick={() => setMode("random")}>Random post</button>
        <button style={s.toggle(mode === "listing")} onClick={() => setMode("listing")}>From MLS sheet</button>
      </div>

      <div style={s.card}>
        {mode === "random" ? (
          <>
            <label style={s.label}>Post type</label>
            <select style={s.select} value={postType} onChange={(e) => setPostType(e.target.value)}>
              {SOCIAL_POST_TYPES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </>
        ) : (
          <>
            <label style={s.label}>MLS listing sheet (PDF)</label>
            <div style={s.dropZone} onClick={() => fileInputRef.current?.click()}>
              {file ? <span style={{ color: C.charcoal }}>📄 {file.name} — tap to change</span> : <span>Tap to upload the listing data sheet (PDF)</span>}
            </div>
            <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
              onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </>
        )}

        <label style={s.label}>Extra direction (optional)</label>
        <textarea style={s.textarea}
          placeholder={mode === "listing" ? "e.g. emphasize the shop and RV parking; keep it short" : "e.g. tie it to hunting season; keep it upbeat"}
          value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p style={s.hint}>Numbers like rates or prices are never invented — the post will use [brackets] for you to fill in unless they're on the sheet.</p>
      </div>

      <button style={s.genBtn} onClick={generate} disabled={loading}>
        {loading ? "Writing your post…" : "✍️  Generate post"}
      </button>

      {error && <div style={s.error}>{error}</div>}

      {result && (
        <div style={s.resultCard}>
          <label style={s.label}>Your post — edit freely</label>
          <textarea style={s.resultText} value={result} onChange={(e) => setResult(e.target.value)} />
          <div style={s.actionRow}>
            <button style={s.smallBtn(true)} onClick={copyResult}>{copied ? "✓ Copied!" : "Copy post"}</button>
            <button style={s.smallBtn(false)} onClick={generate} disabled={loading}>↻ Regenerate</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  app: { minHeight: "100vh", background: "var(--paper)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 14, lineHeight: 1.5 },
  header: { borderBottom: "1px solid var(--ink-line)", background: "var(--paper)", position: "sticky", top: 0, zIndex: 10, backdropFilter: "blur(8px)" },
  headerInner: { maxWidth: 1280, margin: "0 auto", padding: "28px 32px 20px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap" },
  eyebrow: { fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 500, marginBottom: 4 },
  title: { fontFamily: "var(--font-display)", fontSize: 42, fontWeight: 400, margin: 0, letterSpacing: "-0.02em", fontVariationSettings: "'opsz' 144" },
  headerActions: { display: "flex", gap: 10 },
  nav: { maxWidth: 1280, margin: "0 auto", padding: "0 32px", display: "flex", gap: 4 },
  navTab: { display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "var(--ink-soft)", fontSize: 14, fontWeight: 500, marginBottom: -1, transition: "color 0.15s, border-color 0.15s" },
  navTabActive: { color: "var(--ink)", borderBottomColor: "var(--ink)" },
  tabCount: { fontSize: 11, background: "var(--ink-line)", color: "var(--ink)", padding: "1px 7px", borderRadius: 8, fontWeight: 600 },
  main: { maxWidth: 1280, margin: "0 auto", padding: "32px" },

  searchBar: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10, marginBottom: 24 },
  searchInput: { flex: 1, border: "none", background: "transparent", fontSize: 14, color: "var(--ink)", outline: "none" },

  // Stats
  statsRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 },
  statCard: { padding: "22px 24px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 14 },
  statCardAccent: { background: "var(--ink)", border: "1px solid var(--ink)" },
  statLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 500 },
  statValue: { fontFamily: "var(--font-display)", fontSize: 36, fontWeight: 400, marginTop: 6, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },

  sectionTitle: { fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 400, margin: "0 0 16px 0", display: "flex", alignItems: "center", gap: 10, color: "var(--ink)" },

  // Deadlines
  deadlineList: { display: "flex", flexDirection: "column", gap: 1, background: "var(--ink-line)", border: "1px solid var(--ink-line)", borderRadius: 12, overflow: "hidden" },
  deadlineRow: { display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", background: "var(--paper)", border: "none", width: "100%", textAlign: "left", transition: "background 0.15s" },
  daysPill: { padding: "5px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 60, textAlign: "center" },
  emptyHint: { padding: "32px", background: "var(--paper-soft)", border: "1px dashed var(--ink-line)", borderRadius: 12, textAlign: "center", color: "var(--ink-soft)", fontSize: 14 },

  // Cards
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 },
  card: { padding: "20px 22px", background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 14, textAlign: "left", transition: "all 0.2s", cursor: "pointer" },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  typePill: { fontSize: 10, fontWeight: 600, padding: "4px 9px", borderRadius: 4, letterSpacing: "0.08em" },
  statusDot: { width: 10, height: 10, borderRadius: "50%" },
  cardAddress: { fontFamily: "var(--font-display)", fontSize: 19, fontWeight: 500, color: "var(--ink)", lineHeight: 1.25, marginBottom: 2, letterSpacing: "-0.01em" },
  cardCity: { fontSize: 13, color: "var(--ink-soft)", marginBottom: 14 },
  cardRow: { display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderTop: "1px solid var(--ink-line)" },
  progressTrack: { height: 4, background: "var(--ink-line)", borderRadius: 2, overflow: "hidden" },
  progressBar: { height: "100%", background: "var(--accent)", transition: "width 0.3s" },
  progressLabel: { display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--ink-soft)", marginTop: 6, letterSpacing: "0.02em" },

  welcomeCard: { padding: "60px 40px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 16, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" },

  // Buttons
  btn: { display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, border: "1px solid transparent", transition: "all 0.15s" },
  btnPrimary: { background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" },
  btnGhost:   { background: "transparent", color: "var(--ink)", borderColor: "var(--ink-line)" },
  btnDanger:  { background: "transparent", color: "#a94d4d", borderColor: "var(--ink-line)" },
  iconBtn: { padding: 8, background: "transparent", border: "1px solid var(--ink-line)", borderRadius: 8, color: "var(--ink)", display: "inline-flex" },

  // Modal
  modalBackdrop: { position: "fixed", inset: 0, background: "rgba(29, 26, 22, 0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", overflowY: "auto", zIndex: 100, animation: "fadeIn 0.2s ease" },
  modal: { background: "var(--paper)", borderRadius: 16, border: "1px solid var(--ink-line)", maxWidth: 820, width: "100%", boxShadow: "0 20px 60px -10px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 80px)", animation: "slideUp 0.25s ease" },
  modalHeader: { padding: "24px 28px", borderBottom: "1px solid var(--ink-line)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 },
  modalBody: { padding: "24px 28px", overflowY: "auto", flex: 1 },
  modalFooter: { padding: "16px 28px", borderTop: "1px solid var(--ink-line)", display: "flex", gap: 10, alignItems: "center" },

  // Forms
  formSectionTitle: { fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 600, marginBottom: 12 },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontSize: 12, color: "var(--ink-soft)", fontWeight: 500 },
  input: { padding: "9px 12px", border: "1px solid var(--ink-line)", borderRadius: 8, background: "var(--paper)", fontSize: 14, color: "var(--ink)", transition: "border-color 0.15s", width: "100%" },

  // Milestones — detail view
  milestoneRow: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 8 },
  // Milestones — edit form
  milestoneRowEdit: { display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 8 },
  checkBtn: { background: "transparent", border: "none", padding: 0, display: "inline-flex", marginTop: 2 },
  addMilestoneRow: { display: "flex", gap: 10, alignItems: "center", marginTop: 4, padding: "10px 12px", background: "var(--paper)", border: "1px dashed var(--ink-line)", borderRadius: 8 },
  reminderInline: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--ink-soft)" },
  reminderInput: { width: 40, padding: "2px 6px", border: "1px solid var(--ink-line)", borderRadius: 4, background: "var(--paper)", fontSize: 11, color: "var(--ink)", textAlign: "center" },
  customTag: { fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", marginLeft: 8, padding: "1px 5px", borderRadius: 3, background: "var(--accent-soft)", color: "var(--ink)", textTransform: "uppercase", verticalAlign: 1 },

  // Detail facts
  factGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 },
  fact: { padding: "12px 14px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10 },
  factLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontWeight: 500 },
  factValue: { fontFamily: "var(--font-display)", fontSize: 18, color: "var(--ink)", marginTop: 4, fontWeight: 500 },

  // Party cards
  partyGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 },
  partyCard: { padding: "14px 16px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10 },
  partyLabel: { fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 600, marginBottom: 6 },
  partyName: { fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 500, color: "var(--ink)", marginBottom: 8 },
  partyContacts: { display: "flex", flexDirection: "column", gap: 4 },
  partyLink: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-soft)", textDecoration: "none" },

  // Contact cards
  contactGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 },
  contactCard: { padding: "14px 16px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10 },
  contactHeader: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  contactRoleLabel: { fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 600 },
  contactName: { fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, color: "var(--ink)" },
  contactCompany: { fontSize: 12, color: "var(--ink-soft)", marginBottom: 8 },
  contactLinks: { display: "flex", flexDirection: "column", gap: 4, marginTop: 8 },
  contactLink: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-soft)", textDecoration: "none" },

  includedBlock: { padding: "12px 14px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10, fontSize: 14, color: "var(--ink)" },
  notesBlock: { padding: "14px 16px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10, fontSize: 14, lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-wrap" },

  // Uploader
  uploadGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 },
  uploaderBox: { padding: "16px 18px", background: "linear-gradient(135deg, rgba(196, 96, 47, 0.06), rgba(196, 96, 47, 0.02))", border: "1px dashed var(--accent-soft)", borderRadius: 12 },
  betaTag: { fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", padding: "2px 6px", borderRadius: 4, background: "var(--accent)", color: "var(--paper)" },
  parseError: { display: "flex", alignItems: "center", gap: 8, marginTop: 12, padding: "10px 12px", background: "rgba(169, 77, 77, 0.08)", border: "1px solid rgba(169, 77, 77, 0.25)", borderRadius: 8, color: "#a94d4d", fontSize: 13 },
  parseSuccess: { display: "flex", alignItems: "center", gap: 8, marginTop: 12, padding: "10px 12px", background: "rgba(123, 154, 90, 0.1)", border: "1px solid rgba(123, 154, 90, 0.3)", borderRadius: 8, color: "#5a7a3a", fontSize: 13 },

  // Urgent banner
  urgentBanner: { background: "linear-gradient(135deg, var(--ink) 0%, #283e5f 100%)", color: "var(--paper)", borderRadius: 16, padding: "20px 22px", marginBottom: 32, boxShadow: "0 4px 20px -4px rgba(196, 96, 47, 0.3)", border: "1px solid var(--accent)" },
  urgentHeader: { display: "flex", alignItems: "flex-start", gap: 12, color: "var(--accent-soft)", marginBottom: 16 },
  urgentList: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 },
  urgentItem: { background: "rgba(255, 255, 255, 0.08)", border: "1px solid rgba(255, 255, 255, 0.15)", borderRadius: 10, padding: "12px 14px", textAlign: "left", color: "var(--paper)", transition: "all 0.15s", minWidth: 0 },

  // ─── Quick Add FAB + Global Search ───────────────────────────────────────
  fab: { position: "fixed", bottom: 24, right: 24, width: 56, height: 56, borderRadius: "50%", background: "var(--accent)", color: "var(--paper)", border: "none", boxShadow: "0 8px 24px -6px rgba(196, 96, 47, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 90, transition: "transform 0.15s, box-shadow 0.15s" },
  fabOpen: { transform: "rotate(45deg)", background: "var(--ink)" },
  fabBackdrop: { position: "fixed", inset: 0, background: "rgba(29, 26, 22, 0.2)", backdropFilter: "blur(2px)", zIndex: 89, display: "flex", alignItems: "flex-end", justifyContent: "flex-end", padding: "0 24px 96px 24px" },
  fabMenu: { background: "var(--paper)", borderRadius: 14, border: "1px solid var(--ink-line)", boxShadow: "0 20px 40px -10px rgba(0, 0, 0, 0.25)", padding: 8, minWidth: 260, maxWidth: 320, display: "flex", flexDirection: "column", gap: 2 },
  fabMenuItem: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "transparent", border: "none", borderRadius: 8, cursor: "pointer", textAlign: "left", color: "var(--ink)", transition: "background 0.1s" },
  fabDivider: { height: 1, background: "var(--ink-line)", margin: "4px 8px" },

  searchResult: { display: "flex", alignItems: "center", gap: 12, padding: "10px 24px", background: "transparent", border: "none", width: "100%", textAlign: "left", cursor: "pointer", transition: "background 0.1s" },
  kbd: { padding: "3px 7px", borderRadius: 4, background: "var(--paper-soft)", border: "1px solid var(--ink-line)", fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", fontFamily: "monospace" },

  // ────────────────────────────────────────────────
  // Home Base
  // ────────────────────────────────────────────────
  greetingRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, gap: 24, flexWrap: "wrap" },
  greeting: { fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 400, color: "var(--ink)", letterSpacing: "-0.02em", lineHeight: 1.1 },
  greetingSub: { fontSize: 13, color: "var(--ink-soft)", marginTop: 4 },
  weatherBox: { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12 },

  miniStatsRow: { display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 32, alignItems: "center" },
  miniStat: { padding: "10px 16px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 10, minWidth: 110 },
  miniStatHighlight: { background: "var(--ink)", color: "var(--paper)", border: "1px solid var(--ink)" },
  miniStatAlert: { display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", background: "var(--accent)", color: "var(--paper)", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 500, cursor: "pointer", marginLeft: "auto" },

  // To-do lists on home page
  todosRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },
  todoBoxCard: { background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" },
  todoBoxHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--ink-line)", background: "var(--paper)" },
  todoBoxTitle: { fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 500, margin: 0, color: "var(--ink)" },
  todoBoxBody: { padding: "10px 14px", minHeight: 80, maxHeight: 260, overflowY: "auto" },
  todoClearBtn: { background: "transparent", border: "none", color: "var(--ink-soft)", fontSize: 11, cursor: "pointer", padding: "2px 6px", textDecoration: "underline" },

  urgentPill: { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "var(--accent)", color: "var(--paper)", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 500, cursor: "pointer", marginBottom: 28, transition: "transform 0.15s, box-shadow 0.15s" },

  // ─── Widget system ────────────────────────────────────────────────────────
  widgetGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" },
  widgetSlot: { transition: "all 0.15s" },
  widgetSlotEdit: { padding: 6, background: "rgba(196, 96, 47, 0.04)", border: "1px dashed var(--accent-soft)", borderRadius: 14 },
  widgetSlotDragging: { opacity: 0.4 },
  widgetEditBar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px 8px", marginBottom: 4 },
  widgetEditBtn: { background: "transparent", border: "1px solid var(--ink-line)", borderRadius: 6, padding: "3px 8px", fontSize: 12, color: "var(--ink)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 24, height: 22 },
  editModeBanner: { display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "linear-gradient(135deg, rgba(196, 96, 47, 0.1), rgba(196, 96, 47, 0.03))", border: "1px solid var(--accent-soft)", borderRadius: 12, marginBottom: 20 },
  addWidgetCard: { padding: "14px 16px", background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 10, textAlign: "left", cursor: "pointer", transition: "all 0.15s" },
  columnEmptyDrop: { minHeight: 120, border: "2px dashed var(--ink-line)", borderRadius: 14 },

  // Calendar widget
  calBox: { background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, padding: 12 },
  calMonth: { fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 500, color: "var(--ink)", textAlign: "center", marginBottom: 8 },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 },
  calDow: { textAlign: "center", fontSize: 10, fontWeight: 600, color: "var(--ink-soft)", textTransform: "uppercase", padding: "4px 0" },
  calCell: { background: "var(--paper)", border: "1px solid transparent", borderRadius: 6, padding: "6px 4px", textAlign: "center", fontSize: 12, color: "var(--ink)", cursor: "pointer", minHeight: 40, transition: "background 0.1s" },
  calCellToday: { background: "rgba(196, 96, 47, 0.1)", color: "var(--accent)" },
  calCellSelected: { background: "var(--ink)", color: "var(--paper)", border: "1px solid var(--ink)" },
  calDetail: { marginTop: 12, padding: "10px 12px", background: "var(--paper)", border: "1px solid var(--ink-line)", borderRadius: 8 },
  calItem: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--ink-line)", textAlign: "left", background: "transparent", border: "none", borderBottom: "1px solid var(--ink-line)", width: "100%", cursor: "pointer", color: "var(--ink)" },

  // ────────────────────────────────────────────────
  // Home Base (legacy/older styles still in use)
  // ────────────────────────────────────────────────

  homeGrid: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 32, alignItems: "start" },
  sectionTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },

  linkGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 12 },
  linkTile: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: "16px 8px", background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, textDecoration: "none", transition: "all 0.15s", minHeight: 88, overflow: "hidden" },
  linkRemoveBtn: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--ink)", color: "var(--paper)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 2, pointerEvents: "auto" },
  linkIconToggleBtn: { position: "absolute", top: -6, left: -6, width: 22, height: 22, borderRadius: "50%", background: "var(--paper)", color: "var(--ink)", border: "1px solid var(--ink-line)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 2, pointerEvents: "auto", fontSize: 12, padding: 0 },
  linkAddRow: { display: "flex", gap: 8, marginTop: 14, padding: "12px", background: "var(--paper-soft)", border: "1px dashed var(--ink-line)", borderRadius: 10, flexWrap: "wrap" },

  next7Box: { background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, overflow: "hidden" },
  next7Row: { display: "flex", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--ink-line)", alignItems: "flex-start" },
  next7Today: { background: "rgba(196, 96, 47, 0.06)" },
  next7Date: { minWidth: 36, textAlign: "center", color: "var(--ink)" },
  next7Event: { display: "block", width: "100%", background: "transparent", border: "none", padding: "2px 0", textAlign: "left", fontSize: 13, color: "var(--ink)", cursor: "pointer" },

  todoBox: { background: "var(--paper-soft)", border: "1px solid var(--ink-line)", borderRadius: 12, padding: "12px 14px" },
  todoRow: { display: "flex", alignItems: "center", gap: 10, padding: "4px 0" },
  todoAddRow: { display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--ink-line)", background: "var(--paper)" },

  notesPad: { width: "100%", minHeight: 140, padding: "14px 16px", border: "1px solid var(--ink-line)", borderRadius: 12, background: "var(--paper-soft)", fontSize: 14, lineHeight: 1.6, color: "var(--ink)", fontFamily: "var(--font-body)", resize: "vertical" },

  recentList: { display: "flex", flexDirection: "column", gap: 1, background: "var(--ink-line)", border: "1px solid var(--ink-line)", borderRadius: 10, overflow: "hidden" },
  recentRow: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "var(--paper)", border: "none", width: "100%", textAlign: "left", cursor: "pointer", transition: "background 0.15s" },
};
