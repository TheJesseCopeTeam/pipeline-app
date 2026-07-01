// SocialMediaTab.jsx
// Drop-in "Social Media" tab for Pipeline (The Jesse Cope Team).
//
// It calls your serverless function at POST /api/social-generate.
// Self-contained styling (inline) so it won't clash with your existing CSS.
//
// HOW TO ADD IT TO PIPELINE:
//   1. Save this file in your src/ folder (e.g. src/SocialMediaTab.jsx).
//   2. At the top of App.jsx:            import SocialMediaTab from "./SocialMediaTab";
//   3. Add a tab button to your nav:     "Social Media"  (matching how your other tabs work)
//   4. Render it when that tab is active: {activeTab === "social" && <SocialMediaTab />}
//   (Use whatever your existing tab-switching pattern is — this component needs no props.)

import React, { useState, useRef } from "react";

// --- brand palette -----------------------------------------------------------
const C = {
  cream: "#F5F1E8",
  card: "#FBF9F4",
  taupe: "#8A7E6B",
  taupeLight: "#D8CFBE",
  charcoal: "#2E2B26",
  ink: "#4A453D",
  red: "#C8102E", // RE/MAX red, used sparingly
  redDark: "#A00D25",
  line: "#E4DCCB",
};

const serif = "Cambria, Georgia, 'Times New Roman', serif";

const POST_TYPES = [
  { value: "surprise", label: "🎲 Surprise me (best pick today)" },
  { value: "lifestyle", label: "🏔️ Local lifestyle" },
  { value: "first_time_buyer", label: "🔑 First-time buyer" },
  { value: "myth_buster", label: "💥 Myth-buster" },
  { value: "seasonal_tip", label: "🔨 Seasonal home tip" },
  { value: "engagement", label: "💬 Engagement question" },
  { value: "just_listed_teaser", label: "👀 Just-listed teaser" },
];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

export default function SocialMediaTab() {
  const [mode, setMode] = useState("random"); // "random" | "listing"
  const [postType, setPostType] = useState("surprise");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState(null);
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);

  async function generate() {
    setError("");
    setCopied(false);
    setLoading(true);
    try {
      let body;
      if (mode === "listing") {
        if (!file) throw new Error("Upload an MLS listing sheet (PDF) first.");
        const pdfBase64 = await fileToBase64(file);
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

  // --- styles ----------------------------------------------------------------
  const s = {
    wrap: {
      fontFamily: serif,
      color: C.charcoal,
      background: C.cream,
      padding: "28px",
      borderRadius: 14,
      maxWidth: 760,
      margin: "0 auto",
    },
    h1: { fontSize: 26, margin: "0 0 4px", letterSpacing: 0.3 },
    sub: { color: C.taupe, fontSize: 14, margin: "0 0 22px" },
    toggleRow: { display: "flex", gap: 8, marginBottom: 22 },
    toggle: (active) => ({
      flex: 1,
      padding: "12px 14px",
      borderRadius: 10,
      border: `1px solid ${active ? C.charcoal : C.line}`,
      background: active ? C.charcoal : C.card,
      color: active ? C.cream : C.ink,
      cursor: "pointer",
      fontFamily: serif,
      fontSize: 15,
      transition: "all .15s",
    }),
    card: {
      background: C.card,
      border: `1px solid ${C.line}`,
      borderRadius: 12,
      padding: 20,
      marginBottom: 18,
    },
    label: { display: "block", fontSize: 13, color: C.taupe, marginBottom: 6, letterSpacing: 0.4, textTransform: "uppercase" },
    select: {
      width: "100%",
      padding: "11px 12px",
      borderRadius: 8,
      border: `1px solid ${C.line}`,
      background: "#fff",
      fontFamily: serif,
      fontSize: 15,
      color: C.ink,
      marginBottom: 16,
    },
    textarea: {
      width: "100%",
      boxSizing: "border-box",
      padding: "11px 12px",
      borderRadius: 8,
      border: `1px solid ${C.line}`,
      background: "#fff",
      fontFamily: serif,
      fontSize: 15,
      color: C.ink,
      resize: "vertical",
      minHeight: 60,
    },
    dropZone: {
      border: `1.5px dashed ${C.taupeLight}`,
      borderRadius: 10,
      padding: "26px 18px",
      textAlign: "center",
      background: "#fff",
      cursor: "pointer",
      marginBottom: 16,
      color: C.taupe,
    },
    genBtn: {
      width: "100%",
      padding: "14px",
      borderRadius: 10,
      border: "none",
      background: loading ? C.taupe : C.red,
      color: "#fff",
      fontFamily: serif,
      fontSize: 17,
      letterSpacing: 0.4,
      cursor: loading ? "default" : "pointer",
      boxShadow: loading ? "none" : "0 2px 0 " + C.redDark,
    },
    resultCard: {
      background: "#fff",
      border: `1px solid ${C.line}`,
      borderRadius: 12,
      padding: 18,
      marginTop: 8,
    },
    resultText: {
      width: "100%",
      boxSizing: "border-box",
      minHeight: 200,
      padding: 14,
      borderRadius: 8,
      border: `1px solid ${C.line}`,
      fontFamily: serif,
      fontSize: 16,
      lineHeight: 1.5,
      color: C.charcoal,
      resize: "vertical",
      whiteSpace: "pre-wrap",
    },
    actionRow: { display: "flex", gap: 10, marginTop: 12 },
    smallBtn: (primary) => ({
      padding: "10px 16px",
      borderRadius: 8,
      border: `1px solid ${primary ? C.charcoal : C.line}`,
      background: primary ? C.charcoal : C.card,
      color: primary ? C.cream : C.ink,
      fontFamily: serif,
      fontSize: 14,
      cursor: "pointer",
    }),
    error: {
      background: "#FBEAEA",
      border: `1px solid ${C.red}`,
      color: C.redDark,
      padding: "10px 14px",
      borderRadius: 8,
      fontSize: 14,
      marginTop: 14,
    },
    hint: { color: C.taupe, fontSize: 12.5, marginTop: 4 },
  };

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Social Media</h1>
      <p style={s.sub}>Fresh, on-brand posts for Facebook & Instagram — in seconds.</p>

      <div style={s.toggleRow}>
        <button style={s.toggle(mode === "random")} onClick={() => setMode("random")}>
          Random post
        </button>
        <button style={s.toggle(mode === "listing")} onClick={() => setMode("listing")}>
          From MLS sheet
        </button>
      </div>

      <div style={s.card}>
        {mode === "random" ? (
          <>
            <label style={s.label}>Post type</label>
            <select
              style={s.select}
              value={postType}
              onChange={(e) => setPostType(e.target.value)}
            >
              {POST_TYPES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label style={s.label}>MLS listing sheet (PDF)</label>
            <div
              style={s.dropZone}
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? (
                <span style={{ color: C.charcoal }}>📄 {file.name} — tap to change</span>
              ) : (
                <span>Tap to upload the listing data sheet (PDF)</span>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              style={{ display: "none" }}
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </>
        )}

        <label style={s.label}>Extra direction (optional)</label>
        <textarea
          style={s.textarea}
          placeholder={
            mode === "listing"
              ? "e.g. emphasize the shop and RV parking; keep it short"
              : "e.g. tie it to hunting season; keep it upbeat"
          }
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <p style={s.hint}>
          Numbers like rates or prices are never invented — the post will use [brackets] for
          you to fill in unless they're on the sheet.
        </p>
      </div>

      <button style={s.genBtn} onClick={generate} disabled={loading}>
        {loading ? "Writing your post…" : "✍️  Generate post"}
      </button>

      {error && <div style={s.error}>{error}</div>}

      {result && (
        <div style={s.resultCard}>
          <label style={s.label}>Your post — edit freely</label>
          <textarea
            style={s.resultText}
            value={result}
            onChange={(e) => setResult(e.target.value)}
          />
          <div style={s.actionRow}>
            <button style={s.smallBtn(true)} onClick={copyResult}>
              {copied ? "✓ Copied!" : "Copy post"}
            </button>
            <button style={s.smallBtn(false)} onClick={generate} disabled={loading}>
              ↻ Regenerate
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

