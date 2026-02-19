import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";

export default function App() {
  const [files, setFiles] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [result, setResult] = useState(null);
  const [runId, setRunId] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState("");

  const canAnalyze = useMemo(
    () => selectedIds.length > 0 && !isUploading && !isAnalyzing,
    [selectedIds, isUploading, isAnalyzing]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadDocuments() {
      try {
        const response = await fetch(`${API_BASE}/api/documents`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to load documents");
        if (cancelled) return;

        const docs = Array.isArray(payload.documents) ? payload.documents : [];
        setDocuments(docs);
        setSelectedIds(docs.map((doc) => doc.id));
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
        }
      }
    }

    loadDocuments();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUpload(event) {
    const picked = Array.from(event.target.files || []);
    setFiles(picked);
    if (!picked.length) return;

    setIsUploading(true);
    setError("");
    try {
      const formData = new FormData();
      picked.forEach((file) => formData.append("files", file));

      const response = await fetch(`${API_BASE}/api/upload`, {
        method: "POST",
        body: formData
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Upload failed");

      setDocuments((prev) => [...prev, ...payload.documents]);
      setSelectedIds((prev) => [...new Set([...prev, ...payload.documents.map((d) => d.id)])]);
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setIsUploading(false);
    }
  }

  async function runAnalysis() {
    if (!canAnalyze) return;

    setIsAnalyzing(true);
    setError("");
    setResult(null);
    setRunId("");

    try {
      const response = await fetch(`${API_BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: selectedIds })
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Analysis failed");

      setResult(payload.result);
      setRunId(payload.runId);
    } catch (analysisError) {
      setError(analysisError.message);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function toggleDocument(id) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  function renderList(items, emptyText = "Not mentioned") {
    if (!items || items.length === 0) return <p className="muted">{emptyText}</p>;
    return <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
  }

  return (
    <main className="container">
      <h1>Research Portal - Option B</h1>
      <p className="muted">Upload earnings transcripts and generate analyst-ready management commentary summaries.</p>

      <section className="card">
        <label className="label">Upload documents (PDF, DOCX, TXT)</label>
        <input type="file" multiple accept=".pdf,.docx,.txt" onChange={handleUpload} disabled={isUploading} />
        {files.length > 0 && <p className="muted">Selected: {files.map((f) => f.name).join(", ")}</p>}
        {isUploading ? <p className="muted">Uploading documents...</p> : null}
      </section>

      <section className="card">
        <div className="row between">
          <h2>Uploaded documents</h2>
          <button onClick={runAnalysis} disabled={!canAnalyze}>
            {isAnalyzing ? "Running..." : "Run Option B Tool"}
          </button>
        </div>

        {documents.length === 0 ? <p className="muted">No documents uploaded yet.</p> : null}

        {documents.map((doc) => (
          <label className="doc" key={doc.id}>
            <input
              type="checkbox"
              checked={selectedIds.includes(doc.id)}
              onChange={() => toggleDocument(doc.id)}
            />
            <span>
              <strong>{doc.name}</strong>
              <small>{doc.mimetype}</small>
            </span>
          </label>
        ))}
      </section>

      {error ? <p className="error">{error}</p> : null}

      {result ? (
        <section className="card">
          <div className="row between">
            <h2>Analysis result</h2>
            <div className="row">
              <a href={`${API_BASE}/api/result/${runId}`} target="_blank" rel="noreferrer">Download JSON</a>
              <a href={`${API_BASE}/api/result/${runId}/csv`} target="_blank" rel="noreferrer">Download CSV</a>
            </div>
          </div>

          <p><strong>Tone:</strong> {result.tone}</p>
          <p><strong>Tone summary:</strong> {result.tone_summary || "Not mentioned"}</p>
          <p><strong>Confidence:</strong> {result.confidence}</p>

          <h3>Key positives</h3>
          {renderList(result.key_positives)}

          <h3>Key concerns</h3>
          {renderList(result.key_concerns)}

          <h3>Forward guidance</h3>
          <ul>
            <li>Revenue: {result.forward_guidance.revenue || "Not mentioned"}</li>
            <li>Margin: {result.forward_guidance.margin || "Not mentioned"}</li>
            <li>Capex: {result.forward_guidance.capex || "Not mentioned"}</li>
            <li>Tax rate: {result.forward_guidance.tax_rate || "Not mentioned"}</li>
          </ul>

          <h3>Capacity utilization trend</h3>
          <p>{result.capacity_utilization_trends || "Not mentioned"}</p>

          <h3>Growth initiatives</h3>
          {renderList(result.growth_initiatives)}

          <h3>Evidence quotes</h3>
          <ul>
            {result.evidence_quotes.map((q, i) => (
              <li key={i}>
                "{q.quote}" <em>({q.section})</em>
              </li>
            ))}
          </ul>

          <h3>Missing sections</h3>
          {renderList(result.missing_sections)}
        </section>
      ) : null}
    </main>
  );
}
