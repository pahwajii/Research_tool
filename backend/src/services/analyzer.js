import { GoogleGenerativeAI } from "@google/generative-ai";

export async function runOptionBAnalysis({ combinedText, documentParts = [] }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const retryUnderfilled = process.env.ANALYZER_RETRY_ON_UNDERFILLED === "true";

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const cleanedText = typeof combinedText === "string" ? combinedText.trim() : "";
  const hasText = cleanedText.length >= 10;
  const hasDocs = Array.isArray(documentParts) && documentParts.length > 0;

  if (!hasText && !hasDocs) {
    throw new Error("Transcript extraction returned too little text. Upload a text-based transcript (PDF/DOCX/TXT with selectable text).");
  }

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });

  const effectiveText = hasText
    ? cleanedText
    : "No reliable extracted transcript text is available. Analyze the attached source document files directly.";
  const prompt = buildPrompt(effectiveText, {
    lowSignal: !hasText || cleanedText.length < 400,
    hasAttachedDocs: hasDocs
  });
  const parsed = await generateStructuredJson(model, prompt, documentParts);
  const result = normalizeResult(parsed);

  // If critical sections are empty, retry once with stricter instructions.
  if (retryUnderfilled && isLikelyUnderfilled(result)) {
    const retryPrompt = `${prompt}\n\nImportant: Fill all sections with transcript-grounded facts and include citations when present.`;
    const retryParsed = await generateStructuredJson(model, retryPrompt, documentParts);
    return normalizeResult(retryParsed);
  }

  return result;
}

function buildPrompt(transcriptText, { lowSignal = false, hasAttachedDocs = false } = {}) {
  return `You are a forensic financial data extractor.
  
Task:
Extract precise financial metrics, guidance numbers, and strategic details from the transcript into strict JSON.
Your goal is to find the specific numbers (percentages, currency amounts, basis points) that support the narrative.
${hasAttachedDocs ? "Use attached source files as primary evidence when transcript text is weak or incomplete." : ""}

CRITICAL RULES:
1. NO GENERIC FLUFF: Do not write "Healthy growth." Write "Volume growth up 5%".
2. FIND THE NUMBERS: If management says "margin expansion," look for the specific bps (e.g., "150-200 bps").
3. NAMED ENTITIES: Specific brand names (e.g., "4700BC", "Saffola Gold") and project names (e.g., "Project SETU") must be included.
4. DO NOT USE NULL: Unless the information is 100% absent. Dig into Q&A sections for details.
5. CITATIONS: Include source IDs in brackets like [cite: 12] when available in transcript text.
6. OUTPUT: Return strict JSON only. No markdown, no prose.

Output Schema (Strict JSON):
{
  "tone": "optimistic|cautious|neutral|pessimistic",
  "tone_summary": "Explain the tone using specific context (e.g., 'Optimistic due to rural recovery and GST cuts...')",
  "confidence": "high|medium|low",
  
  "key_positives": [
    "Fact + Number + Citation (e.g., 'International business grew double-digits in constant currency [cite: 355]')",
    "Fact + Number + Citation (e.g., 'VAHO market share reached nearly 30% [cite: 323]')",
    "Fact + Number + Citation (e.g., 'Rural distribution expanded via Project SETU [cite: 310]')"
  ],
  
  "key_concerns": [
    "Fact + Context + Citation (e.g., 'Saffola Edible Oil had a soft quarter due to elevated pricing [cite: 325]')",
    "Fact + Context + Citation (e.g., 'Foods portfolio growth paused to rectify profitability [cite: 329]')"
  ],
  
  "forward_guidance": {
    "revenue": "Extract specific growth targets (e.g., 'Foods business to resume 20-25% growth [cite: 333]').",
    "margin": "Extract EBITDA/Operating margin targets (e.g., 'Targeting 150-200 bps operating margin expansion [cite: 520]').",
    "capex": "Extract capital expenditure plans. If truly absent, write 'Not mentioned'."
  },
  
  "capacity_utilization_trends": "Extract details on supply chain, inventory, or manufacturing (e.g., 'Copra prices down 25-30% [cite: 320]').",
  
  "growth_initiatives": [
    "Strategic Move + Name (e.g., 'Acquired 4700BC to enter gourmet snacking [cite: 341]')",
    "Strategic Move + Name (e.g., 'Scaling Digital-First portfolio to INR 1,000cr ARR [cite: 351]')"
  ],
  
  "evidence_quotes": [
    {
      "quote": "Verbatim quote (40-60 words) containing a key metric or strategic intent.",
      "section": "Context (e.g., 'Acquisition Strategy' or 'Margin Guidance')"
    }
  ],
  
  "missing_sections": [
    "List specific metrics that were explicitly searched for but not found (e.g., 'Tax rate guidance', 'Exact Capex figure')."
  ]
}

${lowSignal ? "Note: The transcript text provided is short. If critical data is missing, explicitly list it in missing_sections." : ""}

Transcript Text:
${transcriptText}`;
}

async function generateStructuredJson(model, prompt, documentParts = []) {
  const parts = [{ text: prompt }, ...(Array.isArray(documentParts) ? documentParts : [])];

  const response = await model.generateContent({
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  });

  const raw = response.response.text();
  return parseJsonSafely(raw);
}

function parseJsonSafely(raw) {
  const trimmed = (raw || "").trim();

  if (!trimmed) {
    throw new Error("Model returned empty output");
  }

  const withoutFences = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(withoutFences);
  } catch {
    const match = withoutFences.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM output was not valid JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeResult(input) {
  const toneAllowed = ["optimistic", "cautious", "defensive", "neutral", "pessimistic"];
  const confidenceAllowed = ["high", "medium", "low"];

  const result = {
    tone: toneAllowed.includes(input?.tone) ? input.tone : "neutral",
    tone_summary: normalizeNullableString(input?.tone_summary),
    confidence: confidenceAllowed.includes(input?.confidence) ? input.confidence : "low",
    key_positives: normalizeStringArray(input?.key_positives, 6),
    key_concerns: normalizeStringArray(input?.key_concerns, 6),
    forward_guidance: {
      revenue: normalizeNullableString(input?.forward_guidance?.revenue),
      margin: normalizeNullableString(input?.forward_guidance?.margin),
      capex: normalizeNullableString(input?.forward_guidance?.capex),
      tax_rate: normalizeNullableString(input?.forward_guidance?.tax_rate)
    },
    capacity_utilization_trends: normalizeNullableString(input?.capacity_utilization_trends),
    growth_initiatives: normalizeStringArray(input?.growth_initiatives, 6),
    evidence_quotes: normalizeEvidence(input?.evidence_quotes),
    missing_sections: normalizeStringArray(input?.missing_sections, 12)
  };

  return result;
}

function normalizeNullableString(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.toLowerCase() === "null" || cleaned.toLowerCase() === "not mentioned") {
    return null;
  }
  return cleaned;
}

function normalizeStringArray(value, max) {
  const arr = Array.isArray(value) ? value : [];
  return arr
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeEvidence(value) {
  const arr = Array.isArray(value) ? value : [];
  const cleaned = arr
    .map((item) => ({
      quote: typeof item?.quote === "string" ? item.quote.trim() : "",
      section: typeof item?.section === "string" ? item.section.trim() : ""
    }))
    .filter((item) => item.quote.length > 10)
    .slice(0, 8);

  if (cleaned.length) return cleaned;
  return [{ quote: "No direct quote extracted", section: "N/A" }];
}

function isLikelyUnderfilled(result) {
  const weakArrays = [
    result.key_positives,
    result.key_concerns,
    result.growth_initiatives
  ].filter((arr) => arr.length === 0).length;

  const weakGuidance = [
    result.forward_guidance.revenue,
    result.forward_guidance.margin,
    result.forward_guidance.capex,
    result.forward_guidance.tax_rate
  ].every((v) => v === null);

  return weakArrays >= 2 && weakGuidance;
}
