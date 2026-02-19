export function buildResultCsv(run) {
  const rows = [];
  const { result } = run;

  rows.push(["Run ID", run.runId]);
  rows.push(["Created At", run.createdAt]);
  rows.push(["Documents", run.documentNames.join(" | ")]);
  rows.push(["Tone", result.tone]);
  rows.push(["Tone Summary", valueOrNA(result.tone_summary)]);
  rows.push(["Confidence", result.confidence]);
  rows.push(["Guidance - Revenue", valueOrNA(result.forward_guidance.revenue)]);
  rows.push(["Guidance - Margin", valueOrNA(result.forward_guidance.margin)]);
  rows.push(["Guidance - Capex", valueOrNA(result.forward_guidance.capex)]);
  rows.push(["Guidance - Tax Rate", valueOrNA(result.forward_guidance.tax_rate)]);
  rows.push(["Capacity Utilization Trend", valueOrNA(result.capacity_utilization_trends)]);

  result.key_positives.forEach((v, i) => rows.push([`Key Positive ${i + 1}`, v]));
  result.key_concerns.forEach((v, i) => rows.push([`Key Concern ${i + 1}`, v]));
  result.growth_initiatives.forEach((v, i) => rows.push([`Growth Initiative ${i + 1}`, v]));
  result.missing_sections.forEach((v, i) => rows.push([`Missing Section ${i + 1}`, v]));
  result.evidence_quotes.forEach((v, i) => rows.push([`Evidence ${i + 1}`, `${v.quote} (Source: ${v.section})`]));

  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
}

function valueOrNA(value) {
  return value ?? "Not mentioned";
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}
