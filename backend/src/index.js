import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "crypto";
import { uploadBufferToCloudinary } from "./services/cloudinary.js";
import { extractTextFromBuffer, extractTextFromPdfBufferWithGemini } from "./services/textExtraction.js";
import { runOptionBAnalysis } from "./services/analyzer.js";
import { buildResultCsv } from "./utils/csv.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const maxInputChars = Number(process.env.MAX_INPUT_CHARS || 160000);
const minAnalysisSignal = Number(process.env.MIN_ANALYSIS_SIGNAL || 40);
const maxMultimodalDocs = Number(process.env.MAX_MULTIMODAL_DOCS || 3);
const maxMultimodalBytes = Number(process.env.MAX_MULTIMODAL_BYTES || 15 * 1024 * 1024);
const enableOcrRecoveryOnAnalyze = process.env.ENABLE_OCR_RECOVERY_ON_ANALYZE === "true";

app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(",") || "*" }));
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_FILE_SIZE_BYTES || 15 * 1024 * 1024) }
});

const documents = new Map();
const analysisRuns = new Map();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "research-tool-backend" });
});

app.get("/api/documents", (_req, res) => {
  res.json({ documents: [...documents.values()].map(maskDocument) });
});

app.post("/api/upload", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No files provided" });
    }

    const uploaded = [];

    for (const file of files) {
      const text = await extractTextFromBuffer(file);
      const normalizedText = normalizeExtractedText(text || "");

      const cloudinary = await uploadBufferToCloudinary({
        buffer: file.buffer,
        filename: file.originalname,
        mimetype: file.mimetype
      });

      const id = randomUUID();
      const doc = {
        id,
        name: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        uploadedAt: new Date().toISOString(),
        text: normalizedText,
        textChars: normalizedText.length,
        textWords: normalizedText ? normalizedText.split(/\s+/).length : 0,
        cloudinary: {
          url: cloudinary.secure_url,
          publicId: cloudinary.public_id,
          resourceType: cloudinary.resource_type
        },
        sourceForAnalysis:
          (file.mimetype || "").includes("pdf") && getSignalLength(normalizedText) < minAnalysisSignal
            ? {
                mimeType: file.mimetype || "application/pdf",
                data: file.buffer.toString("base64")
              }
            : null
      };

      documents.set(id, doc);
      uploaded.push(maskDocument(doc));
    }

    res.status(201).json({ documents: uploaded });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(500).json({ error: error.message || "Upload failed" });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const ids = req.body?.documentIds;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "documentIds must be a non-empty array" });
    }

    const selected = ids.map((id) => documents.get(id)).filter(Boolean);
    if (!selected.length) {
      return res.status(404).json({ error: "No matching documents found" });
    }

    if (enableOcrRecoveryOnAnalyze) {
      await recoverWeakPdfDocuments(selected);
    }

    const extractedOnly = selected.map((doc) => doc.text || "").join("\n\n");
    const extractedSignal = getSignalLength(extractedOnly);
    const documentParts = extractedSignal < minAnalysisSignal ? await buildDocumentParts(selected) : [];

    const combined = selected
      .map((doc) => `Document: ${doc.name}\n${doc.text}`)
      .join("\n\n---\n\n")
      .slice(0, maxInputChars);
    const analysisText = extractedSignal < minAnalysisSignal ? extractedOnly : combined;

    if (extractedSignal < minAnalysisSignal && documentParts.length === 0) {
      return res.status(400).json({
        error:
          "No readable transcript content found after extraction and OCR fallback, and source files could not be attached for multimodal analysis.",
        details: selected.map((doc) => ({
          id: doc.id,
          name: doc.name,
          textChars: doc.textChars || 0,
          textPreview: (doc.text || "").slice(0, 120)
        }))
      });
    }

    const result = await runOptionBAnalysis({ combinedText: analysisText, documentParts });

    const runId = randomUUID();
    const run = {
      runId,
      createdAt: new Date().toISOString(),
      documentIds: selected.map((d) => d.id),
      documentNames: selected.map((d) => d.name),
      result
    };

    analysisRuns.set(runId, run);

    res.json({ runId, result, documents: selected.map(maskDocument) });
  } catch (error) {
    console.error("Analysis failed:", error);
    const quota = parseGeminiQuotaError(error);
    if (quota) {
      return res.status(429).json({
        error: quota.message,
        retryAfterSeconds: quota.retryAfterSeconds
      });
    }
    res.status(500).json({ error: error.message || "Analysis failed" });
  }
});

app.get("/api/result/:runId", (req, res) => {
  const run = analysisRuns.get(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: "Run not found" });
  }
  res.json(run);
});

app.get("/api/result/:runId/csv", (req, res) => {
  const run = analysisRuns.get(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: "Run not found" });
  }

  const csv = buildResultCsv(run);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=option-b-${run.runId}.csv`);
  res.send(csv);
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});

function maskDocument(doc) {
  return {
    id: doc.id,
    name: doc.name,
    mimetype: doc.mimetype,
    size: doc.size,
    uploadedAt: doc.uploadedAt,
    cloudinary: doc.cloudinary,
    textChars: doc.textChars || 0,
    textWords: doc.textWords || 0,
    textPreview: doc.text?.slice(0, 220) || ""
  };
}

function normalizeExtractedText(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getSignalLength(value) {
  return (value || "").replace(/\s+/g, "").length;
}

async function recoverWeakPdfDocuments(selectedDocs) {
  const weakPdfDocs = selectedDocs.filter((doc) => isWeakPdfDoc(doc));

  for (const doc of weakPdfDocs) {
    try {
      const fileBuffer = await getDocumentBuffer(doc);
      if (!fileBuffer?.length) continue;

      const ocrText = await extractTextFromPdfBufferWithGemini(fileBuffer);
      const normalizedText = normalizeExtractedText(ocrText);
      if (!normalizedText) continue;

      doc.text = normalizedText;
      doc.textChars = normalizedText.length;
      doc.textWords = normalizedText.split(/\s+/).filter(Boolean).length;
      documents.set(doc.id, doc);
    } catch (error) {
      console.warn(`OCR recovery failed for ${doc.name}:`, error.message || error);
    }
  }
}

function isWeakPdfDoc(doc) {
  const name = (doc?.name || "").toLowerCase();
  const mimetype = doc?.mimetype || "";
  const isPdf = name.endsWith(".pdf") || mimetype.includes("pdf");
  return isPdf && getSignalLength(doc?.text || "") < minAnalysisSignal;
}

async function downloadBuffer(url) {
  if (!url) return null;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file. HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function buildDocumentParts(selectedDocs) {
  const parts = [];
  const pdfDocs = selectedDocs.filter((doc) => isPdfDoc(doc)).slice(0, maxMultimodalDocs);

  for (const doc of pdfDocs) {
    try {
      const fileBuffer = await getDocumentBuffer(doc);
      if (!fileBuffer?.length || fileBuffer.length > maxMultimodalBytes) continue;

      parts.push({ text: `Source Document: ${doc.name}` });
      parts.push({
        inlineData: {
          mimeType: "application/pdf",
          data: fileBuffer.toString("base64")
        }
      });
    } catch (error) {
      console.warn(`Multimodal part build failed for ${doc.name}:`, error.message || error);
    }
  }

  return parts;
}

async function getDocumentBuffer(doc) {
  if (doc?.sourceForAnalysis?.data) {
    return Buffer.from(doc.sourceForAnalysis.data, "base64");
  }
  return downloadBuffer(doc?.cloudinary?.url);
}

function isPdfDoc(doc) {
  const name = (doc?.name || "").toLowerCase();
  const mimetype = doc?.mimetype || "";
  return name.endsWith(".pdf") || mimetype.includes("pdf");
}

function parseGeminiQuotaError(error) {
  const message = String(error?.message || "");
  const lower = message.toLowerCase();
  const looksLikeQuota =
    message.includes("429") ||
    lower.includes("quota exceeded") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit");

  if (!looksLikeQuota) return null;

  const retryAfterSeconds = extractRetryAfterSeconds(message);
  return {
    message:
      "Gemini API quota/rate limit reached. Retry after the cooldown or use a billed API key/model with higher limits.",
    retryAfterSeconds
  };
}

function extractRetryAfterSeconds(message) {
  if (!message) return null;

  // Example: "Please retry in 50.417968038s"
  const retryIn = message.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (retryIn?.[1]) return Math.max(1, Math.ceil(Number(retryIn[1])));

  // Example: retryDelay":"50s"
  const retryDelay = message.match(/retryDelay\\?":\\?"(\d+)s/i);
  if (retryDelay?.[1]) return Number(retryDelay[1]);

  return null;
}
