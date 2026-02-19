import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { GoogleGenerativeAI } from "@google/generative-ai";

const minTextSignal = Number(process.env.MIN_TEXT_SIGNAL || 120);
const enableOcrOnUpload = process.env.ENABLE_OCR_ON_UPLOAD === "true";
const geminiOcrTimeoutMs = Number(process.env.GEMINI_OCR_TIMEOUT_MS || 45000);

export async function extractTextFromBuffer(file) {
  const name = (file.originalname || "").toLowerCase();
  const type = file.mimetype || "";

  if (name.endsWith(".txt") || type.includes("text/plain")) {
    return file.buffer.toString("utf-8");
  }

  if (name.endsWith(".pdf") || type.includes("pdf")) {
    let extracted = "";

    try {
      const parsed = await pdfParse(file.buffer);
      extracted = parsed.text || "";
    } catch (error) {
      console.warn(`pdf-parse failed for ${file.originalname}:`, error.message || error);
    }

    // Keep upload fast by default; OCR fallback can run later during /api/analyze.
    if (isWeakText(extracted) && enableOcrOnUpload) {
      const ocrText = await extractTextFromPdfBufferWithGemini(file.buffer);
      if (ocrText) return ocrText;
    }

    return extracted;
  }

  if (name.endsWith(".docx") || type.includes("wordprocessingml.document")) {
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    return parsed.value || "";
  }

  throw new Error(`Unsupported file type for ${file.originalname}. Use PDF, DOCX, or TXT.`);
}

export async function extractTextFromPdfBufferWithGemini(buffer) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !buffer?.length) return "";

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_OCR_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const model = client.getGenerativeModel({ model: modelName });

    const response = await withTimeout(
      model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Extract all readable text from this PDF exactly as written. Return plain text only. Keep speaker names and line breaks where possible. Do not summarize."
              },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: buffer.toString("base64")
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0
        }
      }),
      geminiOcrTimeoutMs,
      `Gemini OCR timed out after ${geminiOcrTimeoutMs}ms`
    );

    return response.response.text() || "";
  } catch (error) {
    console.warn("Gemini OCR fallback failed:", error.message || error);
    return "";
  }
}

function isWeakText(value) {
  const signal = (value || "").replace(/\s+/g, "");
  return signal.length < minTextSignal;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
