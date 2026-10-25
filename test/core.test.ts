import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, renderReport, VERSION, CLEAN_VERDICT, MAX_SECTIONS } from "../src/core.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

interface SectionFindingShape {
  endLine?: number;
  sectionLines?: string[];
}

const extra = (f: unknown): SectionFindingShape => f as SectionFindingShape;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logdigest-core-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTemp(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("constants", () => {
  it("exports the contract constants", () => {
    assert.equal(VERSION, "0.1.0");
    assert.equal(CLEAN_VERDICT, "NO-FAILURES");
  });
});

describe("npm failure log", () => {
  it("finds two failure sections with correct anchors, counts, and evidence", () => {
    const r = runCheck(fixture("log-npm-fail.log"));
    assert.equal(r.tool, "logdigest");
    assert.equal(r.version, "0.1.0");
    assert.equal(r.verdict, "FAILURES-FOUND");
    assert.equal(r.counts.totalLines, 28);
    assert.equal(r.counts.matchedLines, 9);
    assert.equal(r.counts.sections, 2);
    assert.equal(r.counts.sectionsTotal, 2);
    assert.equal(r.counts.overflowSections, 0);
    assert.equal(r.counts["TEST-FAIL"], 8);
    assert.equal(r.counts["ERROR-LINE"], 1);
    assert.equal(r.counts["EXIT-NONZERO"], 0);
    assert.equal(r.findings.length, 2);

    const [a, b] = r.findings;
    assert.equal(a.rule, "TEST-FAIL");
    assert.equal(a.line, 5);
    assert.equal(extra(a).endLine, 16);
    assert.equal(a.evidence, "FAIL src/math.test.ts");
    assert.equal(a.severity, "high");

    assert.equal(b.rule, "TEST-FAIL");
    assert.equal(b.line, 20);
    assert.equal(extra(b).endLine, 28);
    assert.equal(b.evidence, "FAIL src/string.test.ts");
    assert.equal(b.severity, "high");
  });

  it("captures stack lines after the assertion in the first section", () => {
    const r = runCheck(fixture("log-npm-fail.log"));
    const lines = extra(r.findings[0]).sectionLines ?? [];
    assert.ok(lines.some((l) => l.includes("at Object.<anonymous> (src/math.test.ts:10:11)")));
    assert.ok(lines.some((l) => l.includes("AssertionError: expected 3 to be 4")));
    assert.ok(!lines.some((l) => l.includes("FAIL src/string.test.ts")));
  });

  it("renderReport prints ranges, captured lines verbatim, then totals", () => {
    const r = runCheck(fixture("log-npm-fail.log"));
    const text = renderReport(r);
    assert.ok(text.includes("FAILURES-FOUND"));
    assert.ok(text.includes("lines 5-16"));
    assert.ok(text.includes("lines 20-28"));
    assert.ok(text.includes("FAIL src/math.test.ts"));
    assert.ok(text.includes("    ✕ adds two numbers (5 ms)"));
    assert.ok(text.includes("npm ERR! Test failed. See above for more details."));
    const totalsIdx = text.indexOf("totals:");
    assert.ok(totalsIdx > text.indexOf("lines 20-28"), "totals come after the sections");
    assert.ok(text.slice(totalsIdx).includes("total lines 28"));
    assert.ok(text.slice(totalsIdx).includes("matched lines 9"));
  });
});

describe("clean log", () => {
  it("reports NO-FAILURES with no findings", () => {
    const r = runCheck(fixture("log-clean.log"));
    assert.equal(r.verdict, CLEAN_VERDICT);
    assert.equal(r.counts.totalLines, 6);
    assert.equal(r.counts.matchedLines, 0);
    assert.equal(r.counts.sections, 0);
    assert.equal(r.findings.length, 0);
    assert.ok(renderReport(r).includes("sections: none"));
  });
});

describe("empty log", () => {
  it("reports NO-FAILURES with an EMPTY-LOG info finding", () => {
    const r = runCheck(fixture("log-empty.log"));
    assert.equal(r.verdict, CLEAN_VERDICT);
    assert.equal(r.counts.totalLines, 0);
    assert.equal(r.counts.matchedLines, 0);
    assert.equal(r.counts.sections, 0);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].rule, "EMPTY-LOG");
    assert.equal(r.findings[0].severity, "info");
  });
});

describe("python traceback log", () => {
  it("anchors the traceback section and the exit section", () => {
    const r = runCheck(fixture("log-python.log"));
    assert.equal(r.verdict, "FAILURES-FOUND");
    assert.equal(r.counts.totalLines, 10);
    assert.equal(r.counts.matchedLines, 3);
    assert.equal(r.counts["ERROR-LINE"], 2);
    assert.equal(r.counts["EXIT-NONZERO"], 1);
    assert.equal(r.counts["TEST-FAIL"], 0);
    assert.equal(r.counts.sections, 2);

    const [a, b] = r.findings;
    assert.equal(a.rule, "ERROR-LINE");
    assert.equal(a.line, 3);
    assert.equal(a.evidence, "Traceback (most recent call last):");
    assert.equal(a.severity, "high");

    assert.equal(b.rule, "ERROR-LINE");
    assert.equal(b.line, 8);
    assert.equal(b.evidence, "ValueError: bad input");
  });

  it("captures the traceback File lines as stack context", () => {
    const r = runCheck(fixture("log-python.log"));
    const text = renderReport(r);
    assert.ok(text.includes('  File "worker.py", line 12, in <module>'));
    assert.ok(text.includes('    raise ValueError("bad input")'));
  });
});

describe("exit code handling", () => {
  it("matches nonzero exits and command failed, ignores exit code 0", () => {
    const p = writeTemp(
      "exit.log",
      ["step one ok", "Process exited with code 0", "step two ok", "thing exited with code 2", "later the command failed"].join("\n") + "\n",
    );
    const r = runCheck(p);
    assert.equal(r.verdict, "FAILURES-FOUND");
    assert.equal(r.counts["EXIT-NONZERO"], 2);
    assert.equal(r.counts.matchedLines, 2);
    assert.equal(r.findings[0].line, 4);
    assert.equal(r.findings[0].rule, "EXIT-NONZERO");
    assert.equal(r.findings[0].severity, "medium");
  });
});

describe("target validation", () => {
  it("throws a clear error for a directory target", () => {
    assert.throws(() => runCheck(FIXTURES), /directory, not a log file/);
  });

  it("throws a clear error for a missing file", () => {
    assert.throws(() => runCheck(join(dir, "nope.log")), /Cannot read log file/);
  });
});

describe("line splitting", () => {
  it("handles CRLF and anchors lines correctly", () => {
    const p = writeTemp("crlf.log", "first line\r\nError: broken thing\r\nthird line\r\n");
    const r = runCheck(p);
    assert.equal(r.counts.totalLines, 3);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].line, 2);
    assert.equal(r.findings[0].evidence, "Error: broken thing");
  });
});

describe("grouping", () => {
  it("merges matched lines within 3 lines and splits wider gaps", () => {
    const lines = [
      "Error: first",
      "noise a",
      "noise b",
      "Error: second",
      "noise c",
      "noise d",
      "noise e",
      "noise f",
      "Error: third",
    ];
    const r = runCheck(writeTemp("group.log", lines.join("\n") + "\n"));
    assert.equal(r.counts.sections, 2);
    assert.equal(r.findings[0].line, 1);
    assert.equal(extra(r.findings[0]).endLine, 4);
    assert.equal(r.findings[1].line, 9);
  });
});

describe("section cap", () => {
  it("caps findings at MAX_SECTIONS and counts the overflow", () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_SECTIONS + 50; i++) {
      lines.push(`Error: isolated failure ${i}`);
      for (let k = 0; k < 9; k++) lines.push(`noise ${i} ${k}`);
    }
    const r = runCheck(writeTemp("cap.log", lines.join("\n") + "\n"));
    assert.equal(r.counts.sectionsTotal, MAX_SECTIONS + 50);
    assert.equal(r.counts.sections, MAX_SECTIONS);
    assert.equal(r.counts.overflowSections, 50);
    assert.equal(r.findings.length, MAX_SECTIONS);
  });
});

describe("huge log", () => {
  it("finds the single error at its exact line in 5000 lines of noise", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 5000; i++) {
      lines.push(i === 4321 ? "Error: disk exploded mid run" : `noise line ${i} everything is fine`);
    }
    const r = runCheck(writeTemp("huge.log", lines.join("\n") + "\n"));
    assert.equal(r.counts.totalLines, 5000);
    assert.equal(r.counts.matchedLines, 1);
    assert.equal(r.counts.sections, 1);
    assert.equal(r.findings[0].line, 4321);
    assert.equal(r.findings[0].evidence, "Error: disk exploded mid run");
  });
});

describe("rendering limits", () => {
  it("trims captured lines to 200 characters in the rendered digest", () => {
    const long = `Error: ${"x".repeat(300)}`;
    const r = runCheck(writeTemp("long.log", `${long}\n`));
    assert.equal(r.findings[0].evidence, long);
    const text = renderReport(r);
    assert.ok(text.includes(long.slice(0, 200)));
    assert.ok(!text.includes(long));
  });
});

describe("determinism", () => {
  it("produces identical reports for identical contents", () => {
    const a = runCheck(fixture("log-npm-fail.log"));
    const b = runCheck(fixture("log-npm-fail.log"));
    assert.deepEqual(a, b);
    assert.equal(renderReport(a), renderReport(b));
  });
});
