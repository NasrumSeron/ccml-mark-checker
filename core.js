/* CCML Mark Checker -- core parsing & comparison logic.
 * Pure JS, no DOM dependency, so it can run both in the browser and under
 * Node for testing. Mirrors the desktop (Python/Tkinter) version's logic
 * exactly where the data is well-structured, with extra defensiveness for
 * quirks specific to browser-side PDF text extraction (see comments).
 */
(function (root) {
  "use strict";

  const ADM_NO_RE = /\b(\d{6,8}[A-Za-z])\b/;
  const FLOAT_RE = /^-?\d+(\.\d+)?$/;
  const GRADE_RE = /^[A-F][+-]?$/;

  // ---------------------------------------------------------------------
  // Row/token extraction shared by both PDF parsers (CCML + generic file)
  // ---------------------------------------------------------------------

  // Cluster raw pdf.js text items (each {str,x,y,width,height}) into
  // reading-order rows, then split each row into tokens on x-gaps. This is
  // the JS analogue of what pdfplumber's grid-based table extraction gave
  // the desktop app "for free" -- it's not pixel-identical, but is
  // deliberately always followed by a human preview/confirm step, exactly
  // like the desktop app, so an imperfect guess is always catchable.
  function itemsToRows(items) {
    const clean = items
      .filter((it) => it.str && it.str.trim() !== "")
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
        height: Math.abs(it.transform[3]) || 10,
      }));
    clean.sort((a, b) => b.y - a.y || a.x - b.x);

    const yTol = 3;
    const rows = [];
    for (const it of clean) {
      let row = rows.find((r) => Math.abs(r.y - it.y) <= yTol);
      if (!row) {
        row = { y: it.y, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }
    rows.sort((a, b) => b.y - a.y);

    const out = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      const tokens = [];
      let cur = null;
      for (const it of row.items) {
        if (cur && it.x - cur.right > cur.height * 0.35) {
          tokens.push(cur.text.trim());
          cur = null;
        }
        if (!cur) cur = { text: "", right: it.x, height: it.height };
        cur.text += it.str;
        cur.right = it.x + it.width;
        cur.height = Math.max(cur.height, it.height);
      }
      if (cur) tokens.push(cur.text.trim());
      const filtered = tokens.filter((t) => t !== "");
      if (filtered.length) out.push(filtered);
    }
    return out;
  }

  async function pdfToRows(pdfjsLib, data) {
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const allRows = [];
    const fullText = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = itemsToRows(content.items);
      allRows.push(...rows);
      fullText.push(rows.map((r) => r.join(" ")).join("\n"));
    }
    return { rows: allRows, text: fullText.join("\n") };
  }

  // ---------------------------------------------------------------------
  // CCML parsing
  // ---------------------------------------------------------------------

  function firstNumber(tok) {
    if (tok === undefined || tok === null || tok === "") return null;
    const m = String(tok).split(/\s+/)[0];
    const v = parseFloat(m);
    return Number.isNaN(v) ? null : v;
  }

  function parseCcml(rows, fullText) {
    const classMatch = fullText.match(/Class:\s*(\S+)/);
    const className = classMatch ? classMatch[1] : null;
    const subjMatch = fullText.match(/Subject:\s*(.+)/);
    let subject = null;
    if (subjMatch) {
      subject = subjMatch[1]
        .split(/\s{2,}|Page No|Printed Date|Report ID|<Restricted>/)[0]
        .trim();
    }

    const headerRowIdx = rows.findIndex((r) => (r[0] || "").trim() === "SNo");
    if (headerRowIdx === -1) {
      throw new Error(
        "Could not find the CCML table (expected a column literally titled " +
          "'SNo'). Is this a TPAEP Component Mark List PDF?"
      );
    }
    const l1 = rows[headerRowIdx]; // e.g. [...,"Care GrpMax=10/Wt=10.0","Max=20/Wt=15.0",...,"Cwk Wt=100.0"]
    const l2 = rows[headerRowIdx + 1] || []; // component name first lines, prefixed with stray "Code"

    const l1Text = l1.join(" ");
    const maxWtMatches = [...l1Text.matchAll(/Max=([\d.]+)\/Wt=([\d.]+)/g)];
    const nComponents = maxWtMatches.length;
    if (nComponents === 0) {
      throw new Error("Could not detect any components (no 'Max=.../Wt=...' headers found).");
    }

    let names = l2.slice();
    if (names[0] && names[0].trim() === "Code") names = names.slice(1);
    // drop a trailing "(Total)" label if present so names[] lines up with components only
    if (names.length && /\(Total\)/i.test(names[names.length - 1])) {
      names = names.slice(0, -1);
    }

    const components = maxWtMatches.map((m, i) => ({
      name: (names[i] || `Component ${i + 1}`).trim(),
      max: parseFloat(m[1]),
      wt: parseFloat(m[2]),
    }));

    const expectedTokens = 6 + 3 * (nComponents + 1);
    const students = [];
    const seen = new Set();
    const warnings = [];

    for (let ri = headerRowIdx + 2; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!row || row.length < 8) continue;
      const admCell = row[1] || "";
      const m = ADM_NO_RE.exec(admCell);
      if (!m) continue;
      const admNo = m[1].toUpperCase();
      if (seen.has(admNo)) continue;

      const name = (row[2] || "").trim();
      const marks = {};
      let ok = true;

      if (row.length === expectedTokens) {
        // Fast, exact path -- matches the desktop app's positional indexing.
        for (let i = 0; i < nComponents; i++) {
          marks[components[i].name] = firstNumber(row[6 + i * 3]);
        }
      } else {
        // Row is a different length than expected (e.g. a blank cell
        // dropped out of the text entirely). Fall back to scanning for
        // (number, number, grade) triplets in order, which is robust to
        // *some* dropped cells but not to knowing exactly which component
        // they belonged to -- so we flag this row for manual review
        // instead of silently mis-assigning a value to the wrong component.
        const triplets = [];
        for (let i = 3; i + 2 < row.length; i++) {
          if (
            FLOAT_RE.test(row[i]) &&
            FLOAT_RE.test(row[i + 1]) &&
            GRADE_RE.test(row[i + 2])
          ) {
            triplets.push(parseFloat(row[i]));
            i += 2;
          }
        }
        if (triplets.length === nComponents + 1) {
          for (let i = 0; i < nComponents; i++) marks[components[i].name] = triplets[i];
        } else {
          ok = false;
          warnings.push(
            `${admNo} (${name}): row layout looked unusual (found ${triplets.length} of ` +
              `${nComponents + 1} expected mark groups) -- SKIPPED, please check this ` +
              `student's row directly in the CCML PDF.`
          );
        }
      }

      seen.add(admNo);
      const totalTail = row.slice(-3);
      const total = firstNumber(totalTail[0]);
      students.push({ adm_no: admNo, name, marks, total, incomplete: !ok });
    }

    if (students.length === 0) {
      throw new Error("Found the CCML table header but no student rows under it.");
    }

    return { class_name: className, subject, components, students, warnings };
  }

  // ---------------------------------------------------------------------
  // Generic component evidence table (PDF text rows, or a 2D array from
  // an Excel sheet -- both normalized to the same {header_row, rows,
  // n_cols} shape before reaching here)
  // ---------------------------------------------------------------------

  function tableFromRows(rows) {
    // Deliberately NOT right-padding ragged rows here: a row missing an
    // internal cell (e.g. a blank quiz score dropped out of PDF text
    // extraction entirely) must keep its own true length, or padding would
    // push a trailing value like the mark away from row.length-1 and break
    // the right-anchored ("distance from end") indexing that guessColumns/
    // buildComponentRows rely on to stay robust to exactly that case.
    // n_cols is just the widest row, for display/dropdown purposes only.
    const nCols = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
    return { header_row: rows[0] || [], rows: rows.slice(), n_cols: nCols };
  }

  function guessColumns(table) {
    const { rows, n_cols: nCols } = table;
    if (nCols === 0 || rows.length === 0) return { adminCol: 0, markColFromEnd: 0 };

    const admScores = new Array(nCols).fill(0);
    const floatScores = new Array(nCols).fill(0);
    // Right-anchored numeric scoring: for each row, walk from its own end
    // so a dropped/blank cell earlier in that row doesn't desync which
    // "column" (by distance-from-end) a trailing numeric value counts for.
    const floatScoresFromEnd = new Array(nCols).fill(0);

    for (const row of rows) {
      for (let i = 0; i < nCols; i++) {
        const cell = (row[i] || "").trim();
        if (!cell) continue;
        if (ADM_NO_RE.test(cell)) admScores[i]++;
        if (FLOAT_RE.test(cell)) floatScores[i]++;
      }
      for (let k = 0; k < row.length; k++) {
        const idx = row.length - 1 - k; // distance-from-end k
        const cell = (row[idx] || "").trim();
        if (cell && FLOAT_RE.test(cell)) floatScoresFromEnd[k] = (floatScoresFromEnd[k] || 0) + 1;
      }
    }

    let adminCol = 0;
    for (let i = 1; i < nCols; i++) if (admScores[i] > admScores[adminCol]) adminCol = i;

    const totalRows = rows.length;
    const threshold = Math.max(1, Math.floor(0.5 * totalRows));
    let markColFromEnd = null;
    for (let k = 0; k < floatScoresFromEnd.length; k++) {
      if (floatScoresFromEnd[k] >= threshold) {
        markColFromEnd = k;
        break;
      }
    }
    if (markColFromEnd === null) {
      // fall back to whichever distance-from-end scored best at all
      let best = 0;
      for (let k = 1; k < floatScoresFromEnd.length; k++) {
        if ((floatScoresFromEnd[k] || 0) > (floatScoresFromEnd[best] || 0)) best = k;
      }
      markColFromEnd = best;
    }
    return { adminCol, markColFromEnd };
  }

  function guessName(cells, admNo) {
    let best = "";
    for (const raw of cells) {
      const c = (raw || "").trim();
      if (admNo && c.toUpperCase().includes(admNo)) continue;
      const letters = (c.match(/[A-Za-z]/g) || []).length;
      const bestLetters = (best.match(/[A-Za-z]/g) || []).length;
      if (letters > bestLetters) best = c;
    }
    return best;
  }

  function buildComponentRows(table, adminCol, markColFromEnd) {
    const out = [];
    const seen = new Set();
    for (const row of table.rows) {
      const adminCell = (row[adminCol] || "").trim();
      let m = ADM_NO_RE.exec(adminCell);
      if (!m) {
        const joined = row.join(" ");
        m = ADM_NO_RE.exec(joined);
      }
      if (!m) continue;
      const admNo = m[1].toUpperCase();
      if (seen.has(admNo)) continue;

      const markIdx = row.length - 1 - markColFromEnd;
      if (markIdx < 0 || markIdx >= row.length) continue;
      const markCell = (row[markIdx] || "").trim();
      if (!FLOAT_RE.test(markCell)) continue;

      seen.add(admNo);
      out.push({
        adm_no: admNo,
        name: guessName(row, admNo),
        mark: parseFloat(markCell),
        row,
      });
    }
    return out;
  }

  function colLabel(table, idx) {
    const header = (table.header_row[idx] || "").trim().replace(/\n/g, " ");
    let sample = "";
    for (let r = 0; r < Math.min(3, table.rows.length); r++) {
      const v = (table.rows[r][idx] || "").trim();
      if (v) {
        sample = v;
        break;
      }
    }
    let label = `Col ${idx + 1}`;
    if (header) label += `: "${header.slice(0, 28)}"`;
    if (sample) label += ` (e.g. ${sample.slice(0, 18)})`;
    return label;
  }

  // convenience: convert a left-based column index (as shown/chosen in the
  // UI dropdown, computed against a reference row) into "distance from end"
  function colIndexToFromEnd(refRowLength, idx) {
    return refRowLength - 1 - idx;
  }
  function colFromEndToIndex(refRowLength, fromEnd) {
    return refRowLength - 1 - fromEnd;
  }

  // ---------------------------------------------------------------------
  // Comparison
  // ---------------------------------------------------------------------

  const ROUND_MODES = {
    exact: "Exact match (no rounding)",
    whole: "Round to nearest whole number",
    "1dp": "Round to 1 decimal place",
  };
  const DEFAULT_ROUND_MODE = "exact";

  function roundForCompare(v, mode) {
    if (v === null || v === undefined || (mode !== "whole" && mode !== "1dp")) return v;
    const factor = mode === "whole" ? 1 : 10;
    // half-up rounding (not banker's), matching typical grading conventions
    return Math.round(v * factor + (v >= 0 ? 1e-9 : -1e-9)) / factor;
  }

  function fmtValue(v) {
    if (typeof v !== "number") return v;
    const r = Math.round(v * 100) / 100;
    return Number.isInteger(r) ? r : r;
  }

  function compareComponent(ccml, compName, evidenceRows, roundMode) {
    roundMode = roundMode || DEFAULT_ROUND_MODE;
    const issues = [];
    const evByAdm = new Map(evidenceRows.map((r) => [r.adm_no, r]));

    for (const student of ccml.students) {
      const admNo = student.adm_no;
      const ccmlVal = student.marks[compName] !== undefined ? student.marks[compName] : null;
      const evRow = evByAdm.get(admNo);

      if (!evRow) {
        issues.push({
          component: compName, adm_no: admNo, name: student.name,
          ccml_value: ccmlVal, evidence_value: null,
          issue: "Student in CCML but NOT FOUND in evidence file",
        });
        continue;
      }

      const evVal = evRow.mark;
      if (ccmlVal === null || ccmlVal === undefined) {
        if (evVal !== null && evVal !== undefined && evVal !== 0) {
          issues.push({
            component: compName, adm_no: admNo, name: student.name,
            ccml_value: ccmlVal, evidence_value: evVal,
            issue: "Evidence has a mark but CCML shows none for this student",
          });
        }
        continue;
      }

      const a = roundForCompare(ccmlVal, roundMode);
      const b = roundForCompare(evVal, roundMode);
      if (Math.abs(a - b) > 1e-6) {
        issues.push({
          component: compName, adm_no: admNo, name: student.name,
          ccml_value: ccmlVal, evidence_value: evVal, issue: "MISMATCH",
        });
      }
    }

    const ccmlAdmNos = new Set(ccml.students.map((s) => s.adm_no));
    for (const [admNo, evRow] of evByAdm) {
      if (!ccmlAdmNos.has(admNo)) {
        issues.push({
          component: compName, adm_no: admNo, name: evRow.name,
          ccml_value: null, evidence_value: evRow.mark,
          issue: "In evidence file but NOT FOUND in CCML",
        });
      }
    }
    return issues;
  }

  function diffIssues(oldIssues, newIssues) {
    const oldByAdm = new Map(oldIssues.map((i) => [i.adm_no, i]));
    const newByAdm = new Map(newIssues.map((i) => [i.adm_no, i]));
    const resolved = [], stillIssue = [], newIssue = [];
    for (const [admNo, oi] of oldByAdm) {
      if (!newByAdm.has(admNo)) {
        resolved.push({ adm_no: admNo, name: oi.name, issue: oi.issue, ccml_value: oi.ccml_value, evidence_value: oi.evidence_value });
      } else {
        const ni = newByAdm.get(admNo);
        stillIssue.push({ adm_no: admNo, name: ni.name, issue: ni.issue, ccml_value: ni.ccml_value, evidence_value: ni.evidence_value });
      }
    }
    for (const [admNo, ni] of newByAdm) {
      if (!oldByAdm.has(admNo)) {
        newIssue.push({ adm_no: admNo, name: ni.name, issue: ni.issue, ccml_value: ni.ccml_value, evidence_value: ni.evidence_value });
      }
    }
    return { resolved, still_issue: stillIssue, new_issue: newIssue };
  }

  const CCML = {
    itemsToRows,
    pdfToRows,
    parseCcml,
    tableFromRows,
    guessColumns,
    buildComponentRows,
    colLabel,
    colIndexToFromEnd,
    colFromEndToIndex,
    compareComponent,
    roundForCompare,
    fmtValue,
    diffIssues,
    ROUND_MODES,
    DEFAULT_ROUND_MODE,
    ADM_NO_RE,
    FLOAT_RE,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CCML;
  } else {
    root.CCML = CCML;
  }
})(typeof window !== "undefined" ? window : globalThis);
