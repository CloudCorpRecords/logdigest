# logdigest

Condense a log file to its failure evidence.

A CI or test log can run to ten thousand lines, but the part anyone reads
is the handful of failure sections: the failing test, the error line, the
stack, the nonzero exit. logdigest reads a log file, finds those lines,
groups them into sections with their original line numbers, and prints a
digest you can read in one screen. It reports a verdict of
`FAILURES-FOUND` when it finds any failure section and `NO-FAILURES`
when it finds none.

## Install

```sh
npx @reneturcios/logdigest digest build.log
```

Or install it globally:

```sh
npm install -g @reneturcios/logdigest
```

Requires Node 20 or newer.

## CLI

```sh
logdigest digest [file] [--json]
logdigest mcp
logdigest --version
```

- `logdigest digest <file>` prints the human readable digest.
- `logdigest digest <file> --json` prints the full report as JSON.
- `logdigest mcp` runs the MCP server over stdio (see below).
- `logdigest --version` prints the version.

Exit codes: `0` when the verdict is `NO-FAILURES`, `1` when the verdict
is `FAILURES-FOUND`, `2` for a usage or read error (for example, the
target is a directory or cannot be read), and `141` when the reader
closed the output pipe early.

Example digest:

```text
logdigest digest test.log: FAILURES-FOUND
  2 failure section(s) found in 28 line(s): 9 matched line(s).
  [HIGH] TEST-FAIL lines 5-16
FAIL src/math.test.ts
    AssertionError: expected 3 to be 4
        at Object.<anonymous> (src/math.test.ts:10:11)
  totals: total lines 28, matched lines 9, sections 2, overflow sections 0
  by rule: TEST-FAIL 8, ERROR-LINE 1, EXIT-NONZERO 0
```

(The example above is shortened; the real digest prints every captured
line of every section.)

## MCP

The same binary is an MCP server:

```sh
npx @reneturcios/logdigest mcp
```

It exposes one tool:

- `digest_log` with a `path` argument (the log file to check). It
  returns the same report as the CLI `--json` output.

## What it detects

Detection is pattern based. Every matched line is assigned to exactly
one rule; when a line matches several patterns, the most specific rule
wins (TEST-FAIL over EXIT-NONZERO over ERROR-LINE).

| Rule | Patterns | Notes |
| --- | --- | --- |
| TEST-FAIL | `FAIL `, the word `failing` (for example `2 failing` in a runner summary), `✕`, `× `, `not ok ` (TAP), `AssertionError`, and the shape `expected ... to ...` | Test runner failures and assertion failures |
| ERROR-LINE | the word `error` (any case), `Error:`, `ERR!`, `fatal:`, `panic`, `Traceback`, `Exception` | Generic error evidence, including Python tracebacks and npm ERR! lines |
| EXIT-NONZERO | `exit code` or `exited with code` followed by a nonzero number, and the phrase `command failed` | An exit code of 0 is not a match |

## How sections and verdicts work

- Matched lines that are within 3 lines of each other form one section.
  A wider gap starts a new section.
- After a stack head (a `Traceback` line, the first `at ` stack line of
  a run, or a matched line directly followed by a stack line), up to 5
  further lines are captured as context, so the top of a stack survives
  the digest. The capture never crosses into the next section.
- Each section becomes one finding. Its `line` is the section's first
  line number, its `evidence` is the first matched line, and findings
  also carry `endLine` and the captured `sectionLines`.
- Severity is `high` for a TEST-FAIL or ERROR-LINE section that contains
  a stack head or an assertion, and `medium` otherwise. An empty log
  produces one `info` finding with rule `EMPTY-LOG`.
- The report counts `totalLines`, `matchedLines`, `sections` (sections
  actually emitted), `sectionsTotal`, `overflowSections`, and one count
  per rule.
- Verdict: `FAILURES-FOUND` if there is at least one section, otherwise
  `NO-FAILURES`. An empty log is `NO-FAILURES` with the `EMPTY-LOG`
  finding above.
- Findings are capped at 200 sections. Sections past the cap are not
  emitted, but they are counted in `overflowSections` so the report
  never silently truncates.
- In the human readable digest, each section prints its line range
  followed by its captured lines verbatim, trimmed to 200 characters
  per line, then the totals. Output is deterministic: it is a pure
  function of the file contents, with no timestamps.

## Limits

- Detection is pattern based, so a log that phrases a failure in a
  novel way, with none of the shapes in the table above, can be missed.
  A `NO-FAILURES` verdict means "no known failure shape was found",
  not a proof that the run succeeded.
- logdigest condenses; it does not diagnose. It surfaces the failure
  lines and their immediate context, but root cause analysis beyond
  the lines it surfaces is up to the reader.
- Only the first 200 sections are emitted (the rest are counted), and
  rendered lines are trimmed to 200 characters, so a digest is a
  starting point for reading the original log, not a copy of it. The
  original line numbers are always preserved so any section can be
  found in the source log.

## Development

```sh
npm install
npm run build
npm test
```

The core is in `src/core.ts` and uses only the Node standard library.
