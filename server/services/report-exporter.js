import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureDir, slugifyFileName } from "../utils.js";

const execFileAsync = promisify(execFile);

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function reportMeta(report) {
  return [
    ["报告范围", report.scope || "-"],
    ["报告类型", report.reportType || "-"],
    ["图表偏好", report.chartType || "-"],
    ["生成模型", report.model || "-"],
  ];
}

export function renderReportPlainText(report) {
  return [
    `${report.title}`,
    "=".repeat(Math.max(String(report.title || "").length, 12)),
    "",
    "报告概览",
    "-".repeat(20),
    report.summary || "暂无摘要",
    "",
    ...reportMeta(report).map(([label, value]) => `${label}: ${value}`),
    "",
    "关键指标",
    "-".repeat(20),
    ...(report.metrics || []).map((metric) => {
      const detail = metric.detail ? ` | ${metric.detail}` : "";
      return `- ${metric.label}: ${metric.value}${detail}`;
    }),
    "",
    ...(report.sections || []).flatMap((section) => [
      `## ${section.title}`,
      "",
      section.body || "",
      "",
      ...(section.bullets || []).map((bullet) => `- ${bullet}`),
      ...(section.citations || []).length
        ? ["", `引用来源: ${section.citations.join(" | ")}`]
        : [],
      "",
    ]),
  ].join("\n").trim() + "\n";
}

export function renderReportHtml(report) {
  const metrics = (report.metrics || [])
    .map((metric) => `
      <div class="metric-card">
        <div class="metric-label">${escapeHtml(metric.label)}</div>
        <div class="metric-value">${escapeHtml(metric.value)}</div>
        <div class="metric-detail">${escapeHtml(metric.detail || "")}</div>
      </div>
    `)
    .join("");

  const sections = (report.sections || [])
    .map((section) => `
      <section class="section-card">
        <h2>${escapeHtml(section.title)}</h2>
        <p>${escapeHtml(section.body || "")}</p>
        ${(section.bullets || []).length ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>` : ""}
        ${(section.citations || []).length ? `
          <div class="citation-box">
            <h3>引用来源</h3>
            <p>${escapeHtml(section.citations.join(" | "))}</p>
          </div>
        ` : ""}
      </section>
    `)
    .join("");

  return `
    <html>
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(report.title)}</title>
        <style>
          body{font-family:"PingFang SC","Helvetica Neue",Arial,sans-serif;color:#1f2937;margin:36px;line-height:1.7}
          .cover{padding:28px 32px;border:1px solid #dbe4ff;border-radius:20px;background:linear-gradient(135deg,#f8fbff,#eef4ff)}
          .eyebrow{font-size:12px;letter-spacing:1.6px;text-transform:uppercase;color:#5b6ef5;font-weight:700}
          h1{font-size:28px;margin:10px 0 14px}
          .summary{font-size:14px;color:#4b5563}
          .meta-table{width:100%;border-collapse:collapse;margin-top:22px}
          .meta-table td{padding:10px 12px;border-top:1px solid #dbe4ff;font-size:13px}
          .meta-label{width:110px;color:#6b7280}
          .section-title{margin:28px 0 14px;font-size:18px}
          .metrics{display:block}
          .metric-card{border:1px solid #e5e7eb;border-radius:16px;padding:14px 16px;margin:0 0 12px;background:#fff}
          .metric-label{font-size:12px;color:#6b7280;text-transform:uppercase}
          .metric-value{font-size:24px;font-weight:700;margin:6px 0 4px}
          .metric-detail{font-size:12px;color:#4b5563}
          .section-card{border:1px solid #e5e7eb;border-radius:16px;padding:18px 20px;margin:0 0 16px}
          .section-card h2{font-size:18px;margin:0 0 10px}
          .section-card p{margin:0 0 10px}
          .section-card ul{margin:10px 0 0 18px}
          .citation-box{margin-top:14px;padding:12px 14px;border-radius:12px;background:#f8fafc}
          .citation-box h3{font-size:12px;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;color:#6b7280}
        </style>
      </head>
      <body>
        <section class="cover">
          <div class="eyebrow">XinWiki Report</div>
          <h1>${escapeHtml(report.title)}</h1>
          <p class="summary">${escapeHtml(report.summary || "")}</p>
          <table class="meta-table">
            ${reportMeta(report).map(([label, value]) => `
              <tr>
                <td class="meta-label">${escapeHtml(label)}</td>
                <td>${escapeHtml(value)}</td>
              </tr>
            `).join("")}
          </table>
        </section>

        <h2 class="section-title">报告概览</h2>
        <p>${escapeHtml(report.summary || "暂无摘要")}</p>

        <h2 class="section-title">关键指标</h2>
        <section class="metrics">
          ${metrics}
        </section>

        ${sections}
      </body>
    </html>
  `;
}


function escapePdfText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function buildFallbackPdfBuffer(text) {
  const lines = String(text || "XinWiki Report")
    .split("\n")
    .slice(0, 46)
    .map((line) => line.length > 86 ? `${line.slice(0, 83)}...` : line);
  const streamLines = ["BT", "/F1 11 Tf", "50 790 Td"];
  lines.forEach((line, index) => {
    if (index > 0) {
      streamLines.push("0 -16 Td");
    }
    streamLines.push(`(${escapePdfText(line)}) Tj`);
  });
  streamLines.push("ET");
  const stream = streamLines.join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let offset = Buffer.byteLength("%PDF-1.4\n", "utf8");
  const xref = ["0000000000 65535 f "];
  for (const obj of objects) {
    xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
    offset += Buffer.byteLength(obj, "utf8");
  }
  const body = objects.join("");
  const xrefOffset = Buffer.byteLength("%PDF-1.4\n" + body, "utf8");
  const pdf = [
    "%PDF-1.4",
    body.trimEnd(),
    "xref",
    `0 ${xref.length}`,
    ...xref,
    "trailer",
    `<< /Size ${xref.length} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  ].join("\n");
  return Buffer.from(pdf, "utf8");
}

function reportBaseName(report) {
  return slugifyFileName(report.title || "xinwiki-report") || "xinwiki-report";
}

export async function exportReportAsDocx({ outputDir, report }) {
  await ensureDir(outputDir);
  const fileName = `${reportBaseName(report)}.docx`;
  const outputPath = path.join(outputDir, fileName);
  const tempHtmlPath = path.join(outputDir, `${reportBaseName(report)}.html`);
  await fs.writeFile(tempHtmlPath, renderReportHtml(report), "utf8");
  try {
    await execFileAsync("/usr/bin/textutil", [
      "-convert",
      "docx",
      tempHtmlPath,
      "-output",
      outputPath,
    ]);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await fs.writeFile(outputPath, renderReportHtml(report), "utf8");
  } finally {
    await fs.rm(tempHtmlPath, { force: true });
  }

  return { fileName, outputPath };
}

export async function exportReportAsPdf({ outputDir, report }) {
  await ensureDir(outputDir);
  const fileName = `${reportBaseName(report)}.pdf`;
  const outputPath = path.join(outputDir, fileName);
  const tempTextPath = path.join(outputDir, `${reportBaseName(report)}.txt`);
  await fs.writeFile(tempTextPath, renderReportPlainText(report), "utf8");
  try {
    const { stdout } = await execFileAsync("/usr/sbin/cupsfilter", [
      "-i",
      "text/plain",
      "-m",
      "application/pdf",
      tempTextPath,
    ], {
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    });
    await fs.writeFile(outputPath, stdout);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await fs.writeFile(outputPath, buildFallbackPdfBuffer(renderReportPlainText(report)));
  } finally {
    await fs.rm(tempTextPath, { force: true });
  }

  return { fileName, outputPath };
}
