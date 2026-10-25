/**
 * logdigest core: condense a log file to its failure evidence.
 *
 * The target is a single log file, read as UTF-8 text. Lines are matched
 * against a small pattern table (three rules: TEST-FAIL, ERROR-LINE, and
 * EXIT-NONZERO). Matched lines that sit within 3 lines of each other are
 * grouped into one section, stack context after a stack head is captured,
 * and each section becomes one finding anchored at the section's first
 * line number, with the first matched line as its evidence.
 *
 * Pure function of file contents: no timestamps, no randomness, no
 * network. The same log always produces the same report.
 */
import { readFileSync, statSync } from "node:fs";
import type { Finding, Report, Severity } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "NO-FAILURES";
export const FAILURES_VERDICT = "FAILURES-FOUND";

/** Maximum number of sections emitted as findings. Overflow is counted. */
export const MAX_SECTIONS = 200;

/** Matched lines at most this many line numbers apart share a section. */
const GROUP_GAP = 3;
/** Lines of context captured after a stack head. */
const STACK_CONTEXT_LINES = 5;
/** Rendered captured lines are trimmed to this many characters. */
const MAX_RENDER_LINE = 200;

const RULE_TEST_FAIL = "TEST-FAIL";
const RULE_ERROR_LINE = "ERROR-LINE";
const RULE_EXIT_NONZERO = "EXIT-NONZERO";

/* ------------------------------------------------------------------ */
/* Pattern table                                                       */
/* ------------------------------------------------------------------ */

/** "expected ... to ..." assertion shape, as in chai and jest output. */
const EXPECTED_TO_RE = /\bexpected\b.+\bto\b/;

function isTestFailLine(line: string): boolean {
  return (
    line.includes("FAIL ") ||
    /\bfailing\b/i.test(line) ||
    line.includes("✕") ||
    line.includes("× ") ||
    /(^|\s)not ok(\s|$)/.test(line) ||
    line.includes("AssertionError") ||
    EXPECTED_TO_RE.test(line)
  );
}

function isExitNonzeroLine(line: string): boolean {
  const m = line.match(/(?:exit code|exited with code)\s*:?\s*(-?\d+)/i);
  if (m) return Number.parseInt(m[1], 10) !== 0;
  return /\bcommand failed\b/i.test(line);
}

function isErrorLine(line: string): boolean {
  return (
    /\berror\b/i.test(line) ||
    line.includes("Error:") ||
    line.includes("ERR!") ||
    /fatal:/i.test(line) ||
    /panic/i.test(line) ||
    line.includes("Traceback") ||
    /exception/i.test(line)
  );
}

/**
 * Classify one line. Priority is most specific first, so a line is
 * counted exactly once: TEST-FAIL beats EXIT-NONZERO beats ERROR-LINE.
 * Returns the rule id, or null when the line is not failure evidence.
 */
function matchRule(line: string): string | null {
  if (isTestFailLine(line)) return RULE_TEST_FAIL;
  if (isExitNonzeroLine(line)) return RULE_EXIT_NONZERO;
  if (isErrorLine(line)) return RULE_ERROR_LINE;
  return null;
}

/* ------------------------------------------------------------------ */
/* Stack shapes                                                        */
/* ------------------------------------------------------------------ */

function isStackLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("at ") || t.startsWith('File "');
}

function isTracebackLine(line: string): boolean {
  return line.includes("Traceback");
}

function isAssertionLine(line: string): boolean {
  return (
    line.includes("AssertionError") ||
    /assertion failed/i.test(line) ||
    EXPECTED_TO_RE.test(line)
  );
}

/**
 * A stack head is the line a stack capture starts from: a Traceback
 * line, the first stack line of a run, or a matched line that is
 * immediately followed by a stack line.
 */
function isStackHead(lines: string[], idx: number, matched: boolean): boolean {
  const line = lines[idx];
  if (isTracebackLine(line)) return true;
  if (isStackLine(line)) {
    if (idx === 0) return true;
    const prev = lines[idx - 1];
    return !isStackLine(prev) && !isTracebackLine(prev);
  }
  if (matched && idx + 1 < lines.length && isStackLine(lines[idx + 1])) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

interface MatchedLine {
  lineNo: number;
  rule: string;
  text: string;
}

interface Section {
  start: number;
  end: number;
  matched: MatchedLine[];
}

/** A finding that also carries its section range and captured lines. */
interface SectionFinding extends Finding {
  endLine: number;
  sectionLines: string[];
}

function groupSections(matched: MatchedLine[]): Section[] {
  const sections: Section[] = [];
  for (const m of matched) {
    const last = sections[sections.length - 1];
    if (last && m.lineNo - last.matched[last.matched.length - 1].lineNo <= GROUP_GAP) {
      last.matched.push(m);
      last.end = m.lineNo;
    } else {
      sections.push({ start: m.lineNo, end: m.lineNo, matched: [m] });
    }
  }
  return sections;
}

/**
 * Extend a section's end to capture stack context: up to
 * STACK_CONTEXT_LINES lines after each stack head inside the section.
 * The extension never crosses into the next section.
 */
function extendSection(
  lines: string[],
  section: Section,
  matchedLineNos: Set<number>,
  limit: number,
): void {
  let end = section.end;
  for (let lineNo = section.start; lineNo <= end; lineNo++) {
    const idx = lineNo - 1;
    if (isStackHead(lines, idx, matchedLineNos.has(lineNo))) {
      const candidate = Math.min(lineNo + STACK_CONTEXT_LINES, limit, lines.length);
      if (candidate > end) end = candidate;
    }
  }
  section.end = end;
}

function sectionSeverity(lines: string[], section: Section): Severity {
  const hasTestOrError = section.matched.some(
    (m) => m.rule === RULE_TEST_FAIL || m.rule === RULE_ERROR_LINE,
  );
  if (!hasTestOrError) return "medium";
  const captured = lines.slice(section.start - 1, section.end);
  const hasStack = captured.some((l) => isTracebackLine(l) || isStackLine(l));
  const hasAssertion = captured.some((l) => isAssertionLine(l));
  return hasStack || hasAssertion ? "high" : "medium";
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export function runCheck(target: string): Report {
  let st;
  try {
    st = statSync(target);
  } catch {
    throw new Error(`Cannot read log file: ${target}`);
  }
  if (st.isDirectory()) {
    throw new Error(`Target is a directory, not a log file: ${target}`);
  }
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch {
    throw new Error(`Cannot read log file: ${target}`);
  }

  // Split lines, handling CRLF. A trailing newline terminates the last
  // line rather than starting a new empty one.
  let lines: string[];
  if (content === "") {
    lines = [];
  } else {
    lines = content.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }
  const totalLines = lines.length;

  const byRule: Record<string, number> = {
    [RULE_TEST_FAIL]: 0,
    [RULE_ERROR_LINE]: 0,
    [RULE_EXIT_NONZERO]: 0,
  };

  if (content.trim() === "") {
    const findings: Finding[] = [
      {
        rule: "EMPTY-LOG",
        severity: "info",
        file: target,
        message: "Log file is empty: no lines to digest.",
      },
    ];
    return {
      tool: "logdigest",
      version: VERSION,
      target,
      verdict: CLEAN_VERDICT,
      counts: {
        totalLines,
        matchedLines: 0,
        sections: 0,
        sectionsTotal: 0,
        overflowSections: 0,
        findings: findings.length,
        ...byRule,
      },
      findings,
      summary: "Empty log: no lines to digest.",
    };
  }

  const matched: MatchedLine[] = [];
  lines.forEach((text, i) => {
    const rule = matchRule(text);
    if (rule) {
      byRule[rule] += 1;
      matched.push({ lineNo: i + 1, rule, text });
    }
  });
  const matchedLines = matched.length;
  const matchedLineNos = new Set(matched.map((m) => m.lineNo));

  const sections = groupSections(matched);
  sections.forEach((section, i) => {
    const nextStart = i + 1 < sections.length ? sections[i + 1].start : lines.length + 1;
    extendSection(lines, section, matchedLineNos, nextStart - 1);
  });

  const sectionsTotal = sections.length;
  const emitted = sections.slice(0, MAX_SECTIONS);
  const overflowSections = sectionsTotal - emitted.length;

  const findings: Finding[] = emitted.map((section) => {
    const rulesInOrder: string[] = [];
    for (const m of section.matched) {
      if (!rulesInOrder.includes(m.rule)) rulesInOrder.push(m.rule);
    }
    const finding: SectionFinding = {
      rule: section.matched[0].rule,
      severity: sectionSeverity(lines, section),
      file: target,
      line: section.start,
      message:
        `Failure section lines ${section.start}-${section.end}: ` +
        `${section.matched.length} matched line(s) [${rulesInOrder.join(", ")}]`,
      evidence: section.matched[0].text,
      endLine: section.end,
      sectionLines: lines.slice(section.start - 1, section.end),
    };
    return finding;
  });

  const verdict = sectionsTotal > 0 ? FAILURES_VERDICT : CLEAN_VERDICT;
  let summary: string;
  if (sectionsTotal === 0) {
    summary = `No failures found: ${totalLines} line(s) scanned, 0 matched lines.`;
  } else if (overflowSections > 0) {
    summary =
      `${sectionsTotal} failure section(s) found in ${totalLines} line(s): ` +
      `${matchedLines} matched line(s). Showing the first ${MAX_SECTIONS} sections; ` +
      `${overflowSections} section(s) omitted by the cap.`;
  } else {
    summary =
      `${sectionsTotal} failure section(s) found in ${totalLines} line(s): ` +
      `${matchedLines} matched line(s).`;
  }

  return {
    tool: "logdigest",
    version: VERSION,
    target,
    verdict,
    counts: {
      totalLines,
      matchedLines,
      sections: emitted.length,
      sectionsTotal,
      overflowSections,
      findings: findings.length,
      ...byRule,
    },
    findings,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderReport(report: Report): string {
  const out: string[] = [];
  out.push(`logdigest digest ${report.target}: ${report.verdict}`);
  out.push(`  ${report.summary}`);
  if (report.findings.length === 0) {
    out.push("  sections: none");
  }
  for (const f of report.findings) {
    const extra = f as Finding & Partial<Pick<SectionFinding, "endLine" | "sectionLines">>;
    if (extra.sectionLines && typeof extra.endLine === "number" && typeof f.line === "number") {
      out.push(`  [${f.severity.toUpperCase()}] ${f.rule} lines ${f.line}-${extra.endLine}`);
      for (const line of extra.sectionLines) {
        out.push(line.slice(0, MAX_RENDER_LINE));
      }
    } else {
      const where = typeof f.line === "number" ? ` line ${f.line}` : "";
      out.push(`  [${f.severity.toUpperCase()}] ${f.rule}${where} ${f.message}`);
      if (f.evidence) out.push(f.evidence.slice(0, MAX_RENDER_LINE));
    }
  }
  const c = report.counts;
  out.push(
    `  totals: total lines ${c.totalLines ?? 0}, matched lines ${c.matchedLines ?? 0}, ` +
      `sections ${c.sections ?? report.findings.length}, overflow sections ${c.overflowSections ?? 0}`,
  );
  out.push(
    `  by rule: TEST-FAIL ${c[RULE_TEST_FAIL] ?? 0}, ERROR-LINE ${c[RULE_ERROR_LINE] ?? 0}, ` +
      `EXIT-NONZERO ${c[RULE_EXIT_NONZERO] ?? 0}`,
  );
  return out.join("\n");
}
