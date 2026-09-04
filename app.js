/* CCML Mark Checker -- browser UI. Wires core.js to file inputs and DOM
 * rendering. Everything (PDF/Excel parsing, comparison) happens locally in
 * the browser -- no file or mark ever leaves this tab.
 */
(function () {
  "use strict";

  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  const appEl = document.getElementById("app");
  const modalRoot = document.getElementById("modalRoot");

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------
  function freshState() {
    return {
      screen: "welcome", // welcome | components | results
      ccml: null,
      componentOrder: [],
      componentStatus: {}, // name -> {status:'pending'|'skipped'|'uploaded', fileName, table, adminCol, markColFromEnd, rows}
      currentIndex: 0,
      // pending upload for the component currently being reviewed (before Continue is clicked)
      pendingUpload: null, // {fileName, table, adminCol, markColFromEnd, rows}
      issues: [],
      checked: false,
      roundMode: CCML.DEFAULT_ROUND_MODE,
      auditLog: [],
    };
  }
  let state = freshState();

  function resetAll() {
    state = freshState();
    render();
  }
  document.getElementById("resetBtn").addEventListener("click", () => {
    if (confirm("Reset will discard the loaded CCML, all uploaded files and results. Continue?")) {
      resetAll();
    }
  });

  // -------------------------------------------------------------------
  // Helpers: file -> rows
  // -------------------------------------------------------------------
  async function fileToArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  async function extractTableFromFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) {
      const buf = new Uint8Array(await fileToArrayBuffer(file));
      const { rows } = await CCML.pdfToRows(pdfjsLib, buf);
      return CCML.tableFromRows(rows);
    } else if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
      const buf = await fileToArrayBuffer(file);
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
      const rows = aoa.map((r) => r.map((c) => String(c === undefined || c === null ? "" : c).trim()));
      return CCML.tableFromRows(rows);
    } else if (name.endsWith(".xls")) {
      throw new Error("Old-style .xls isn't supported -- please re-save/export as .xlsx first.");
    } else {
      throw new Error("Unsupported file type -- please upload a PDF or .xlsx file.");
    }
  }

  // -------------------------------------------------------------------
  // Render router
  // -------------------------------------------------------------------
  function render() {
    appEl.innerHTML = "";
    try {
      if (state.screen === "welcome") renderWelcome();
      else if (state.screen === "components") renderComponents();
      else if (state.screen === "results") renderResults();
    } catch (err) {
      console.error("RENDER ERROR:", err.stack || err.message);
    }
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") e.className = v;
        else if (k === "html") e.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
        else if (typeof v === "boolean") { if (v) e.setAttribute(k, ""); }
        else e.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => {
      if (c === null || c === undefined) return;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return e;
  }

  // -------------------------------------------------------------------
  // Screen 1: Welcome / Load CCML
  // -------------------------------------------------------------------
  function renderWelcome() {
    const card = el("div", { class: "card" }, [
      el("h1", {}, ["Load the CCML"]),
      el("p", { class: "lead" }, [
        "Pick the Component Mark List PDF for the subject/class you're checking. ",
        "Everything happens in your browser -- the file is never uploaded anywhere.",
      ]),
      el("div", { class: "upload-box" }, [
        el("div", {}, ["Drop or choose the CCML PDF"]),
        (() => {
          const input = el("input", { type: "file", accept: ".pdf" });
          input.addEventListener("change", onCcmlFile);
          return input;
        })(),
      ]),
      el("div", { id: "ccmlStatus" }, []),
    ]);
    appEl.appendChild(card);

    if (state.ccml) {
      appEl.appendChild(renderCcmlPreview());
    }
  }

  async function onCcmlFile(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById("ccmlStatus");
    statusEl.innerHTML = "";
    statusEl.appendChild(el("p", { class: "muted" }, ["Reading PDF..."]));
    try {
      const buf = new Uint8Array(await fileToArrayBuffer(file));
      const { rows, text } = await CCML.pdfToRows(pdfjsLib, buf);
      const result = CCML.parseCcml(rows, text);
      state.ccml = result;
      state.componentOrder = result.components.map((c) => c.name);
      state.componentStatus = {};
      state.componentOrder.forEach((n) => (state.componentStatus[n] = { status: "pending" }));
      state.currentIndex = 0;
      render();
    } catch (err) {
      statusEl.innerHTML = "";
      statusEl.appendChild(el("div", { class: "banner error" }, ["Could not read this CCML: " + err.message]));
    }
  }

  function renderCcmlPreview() {
    const c = state.ccml;
    const card = el("div", { class: "card" }, []);
    card.appendChild(el("h2", {}, ["Detected"]));
    if (c.warnings && c.warnings.length) {
      card.appendChild(
        el("div", { class: "banner warn" }, [
          `${c.warnings.length} row(s) had an unusual layout and were skipped -- see below.`,
        ])
      );
    }
    const grid = el("div", { class: "row" }, [
      infoBlock("Class", c.class_name || "(not detected)"),
      infoBlock("Subject", c.subject || "(not detected)"),
      infoBlock("Students", String(c.students.length)),
      infoBlock("Components", String(c.components.length)),
    ]);
    card.appendChild(grid);

    card.appendChild(el("h3", { class: "mt20" }, ["Components (in CCML order)"]));
    const tw = el("div", { class: "table-wrap" });
    const table = el("table");
    table.appendChild(
      el("thead", {}, [el("tr", {}, [el("th", {}, ["#"]), el("th", {}, ["Component"]), el("th", {}, ["Max"]), el("th", {}, ["Weight"])])])
    );
    const tbody = el("tbody");
    c.components.forEach((comp, i) => {
      tbody.appendChild(
        el("tr", {}, [el("td", {}, [String(i + 1)]), el("td", {}, [comp.name]), el("td", {}, [String(comp.max)]), el("td", {}, [String(comp.wt)])])
      );
    });
    table.appendChild(tbody);
    tw.appendChild(table);
    card.appendChild(tw);

    card.appendChild(el("h3", { class: "mt20" }, ["Student preview (first 8)"]));
    const tw2 = el("div", { class: "table-wrap" });
    const table2 = el("table");
    table2.appendChild(el("thead", {}, [el("tr", {}, [el("th", {}, ["Admin No"]), el("th", {}, ["Name"]), el("th", {}, ["Total"])])]));
    const tbody2 = el("tbody");
    c.students.slice(0, 8).forEach((s) => {
      tbody2.appendChild(el("tr", {}, [el("td", {}, [s.adm_no]), el("td", {}, [s.name]), el("td", {}, [s.total === null || s.total === undefined ? "-" : String(s.total)])]));
    });
    table2.appendChild(tbody2);
    tw2.appendChild(table2);
    card.appendChild(tw2);

    if (c.warnings && c.warnings.length) {
      const wl = el("ul", { class: "mt12" });
      c.warnings.forEach((w) => wl.appendChild(el("li", { class: "muted" }, [w])));
      card.appendChild(wl);
    }

    card.appendChild(
      el("div", { class: "row end mt20" }, [
        el("button", { class: "btn btn-primary", onclick: () => { state.screen = "components"; render(); } }, [
          "This looks right -- Continue",
        ]),
      ])
    );
    return card;
  }

  function infoBlock(label, value) {
    return el("div", { style: "min-width:180px;margin:6px 18px 6px 0;" }, [
      el("div", { class: "muted" }, [label]),
      el("div", { style: "font-weight:700;font-size:15px;" }, [value]),
    ]);
  }

  // -------------------------------------------------------------------
  // Screen 2: per-component upload/skip
  // -------------------------------------------------------------------
  function renderComponents() {
    const total = state.componentOrder.length;
    const idx = state.currentIndex;
    const name = state.componentOrder[idx];

    // checklist card
    const listCard = el("div", { class: "card" }, [el("h2", {}, ["Components"])]);
    const ul = el("ul", { class: "checklist" });
    state.componentOrder.forEach((n, i) => {
      const st = state.componentStatus[n].status;
      const badge =
        st === "uploaded" ? el("span", { class: "badge done" }, ["✓"]) :
        st === "skipped" ? el("span", { class: "badge skip" }, ["-"]) :
        el("span", { class: "badge" }, [String(i + 1)]);
      const pill =
        st === "uploaded" ? el("span", { class: "pill uploaded" }, ["Uploaded"]) :
        st === "skipped" ? el("span", { class: "pill skipped" }, ["Skipped"]) :
        el("span", { class: "pill pending" }, [i === idx ? "Current" : "Pending"]);
      ul.appendChild(el("li", {}, [badge, el("span", { class: "name" }, [n]), pill]));
    });
    listCard.appendChild(ul);
    appEl.appendChild(listCard);

    if (idx >= total) {
      // all done
      const card = el("div", { class: "card" }, [
        el("h2", {}, ["All components handled"]),
        el("p", { class: "lead" }, ["Every component has been uploaded or skipped. Run the check when ready."]),
        el("div", { class: "row end" }, [
          el("button", { class: "btn", onclick: () => { state.currentIndex = total - 1; render(); } }, ["Back"]),
          el("button", { class: "btn btn-primary", onclick: runCheckAndShowResults }, ["Run check"]),
        ]),
      ]);
      appEl.appendChild(card);
      return;
    }

    const card = el("div", { class: "card" }, []);
    card.appendChild(el("div", { class: "step-progress" }, [`Component ${idx + 1} of ${total}`]));
    card.appendChild(el("h2", {}, [name]));
    card.appendChild(
      el("p", { class: "lead" }, [
        "Upload the grade-export file for this component (PDF or .xlsx), or Skip if you don't teach/hold it -- skipped components are left out of the check entirely, not treated as an error.",
      ])
    );

    const uploadBox = el("div", { class: "upload-box" }, [
      el("div", {}, ["Choose evidence file (.pdf or .xlsx)"]),
      (() => {
        const input = el("input", { type: "file", accept: ".pdf,.xlsx,.xlsm" });
        input.addEventListener("change", (ev) => onComponentFile(ev, name));
        return input;
      })(),
    ]);
    card.appendChild(uploadBox);

    const previewHost = el("div", { id: "componentPreview" }, []);
    card.appendChild(previewHost);

    const existing = state.componentStatus[name];
    if (state.pendingUpload) {
      card.appendChild(renderComponentPreview(state.pendingUpload));
    } else if (existing.status === "uploaded") {
      card.appendChild(
        el("div", { class: "banner ok" }, [`Already uploaded: ${existing.fileName} (${existing.rows.length} rows detected)`])
      );
    } else if (existing.status === "skipped") {
      card.appendChild(el("div", { class: "banner warn" }, ["This component is currently skipped."]));
    }

    card.appendChild(
      el("div", { class: "row between mt20" }, [
        el("button", { class: "btn", disabled: idx === 0, onclick: onBackComponent }, ["Back"]),
        el("div", { class: "row" }, [
          el("button", { class: "btn btn-danger", onclick: onSkipComponent }, ["Skip this component"]),
          el(
            "button",
            {
              class: "btn btn-primary",
              disabled: !(state.pendingUpload || existing.status === "uploaded" || existing.status === "skipped"),
              onclick: onContinueComponent,
            },
            ["Continue"]
          ),
        ]),
      ])
    );

    appEl.appendChild(card);
  }

  async function onComponentFile(ev, compName) {
    const file = ev.target.files[0];
    if (!file) return;
    const previewHost = document.getElementById("componentPreview");
    previewHost.innerHTML = "";
    previewHost.appendChild(el("p", { class: "muted" }, ["Reading file..."]));
    try {
      const table = await extractTableFromFile(file);
      const guess = CCML.guessColumns(table);
      const rows = CCML.buildComponentRows(table, guess.adminCol, guess.markColFromEnd);
      state.pendingUpload = {
        fileName: file.name,
        table,
        adminCol: guess.adminCol,
        markColFromEnd: guess.markColFromEnd,
        rows,
      };
      render();
    } catch (err) {
      previewHost.innerHTML = "";
      previewHost.appendChild(el("div", { class: "banner error" }, ["Could not read this file: " + err.message]));
    }
  }

  // Renders the editable admin/mark column dropdowns + live preview table.
  // `upload` is a {fileName, table, adminCol, markColFromEnd, rows} object;
  // `onChange(newAdminCol, newMarkColFromEnd)` is called when the user edits
  // a dropdown so the caller can recompute rows and re-render.
  function renderComponentPreview(upload, onChange) {
    const table = upload.table;
    const nCols = table.n_cols;
    const refLen = (table.rows[0] || []).length || nCols;

    const wrap = el("div", { class: "mt16" });
    wrap.appendChild(el("div", { class: "banner ok" }, [`${upload.fileName} -- ${upload.rows.length} row(s) detected`]));

    const adminSelect = el("select", {}, []);
    const markSelect = el("select", {}, []);
    for (let i = 0; i < nCols; i++) {
      adminSelect.appendChild(el("option", { value: String(i) }, [CCML.colLabel(table, i)]));
    }
    for (let i = 0; i < nCols; i++) {
      const fromEnd = i; // distance-from-end value
      const idxForLabel = Math.max(0, refLen - 1 - fromEnd);
      markSelect.appendChild(el("option", { value: String(fromEnd) }, [CCML.colLabel(table, idxForLabel)]));
    }
    adminSelect.value = String(upload.adminCol);
    markSelect.value = String(upload.markColFromEnd);

    function fireChange() {
      const newAdminCol = parseInt(adminSelect.value, 10);
      const newMarkColFromEnd = parseInt(markSelect.value, 10);
      if (onChange) {
        onChange(newAdminCol, newMarkColFromEnd);
      } else {
        upload.adminCol = newAdminCol;
        upload.markColFromEnd = newMarkColFromEnd;
        upload.rows = CCML.buildComponentRows(table, newAdminCol, newMarkColFromEnd);
        render();
      }
    }
    adminSelect.addEventListener("change", fireChange);
    markSelect.addEventListener("change", fireChange);

    const fields = el("div", { class: "row" }, [
      el("div", { class: "field" }, [el("label", { class: "field-label" }, ["Admin No. column"]), adminSelect]),
      el("div", { class: "field" }, [el("label", { class: "field-label" }, ["Mark column"]), markSelect]),
    ]);
    wrap.appendChild(fields);
    wrap.appendChild(
      el("p", { class: "muted mb0" }, [
        "If names look garbled or marks don't make sense, change the dropdowns above -- the preview updates immediately, no re-upload needed.",
      ])
    );

    const tw = el("div", { class: "table-wrap mt12" });
    const t = el("table");
    t.appendChild(el("thead", {}, [el("tr", {}, [el("th", {}, ["Admin No"]), el("th", {}, ["Name"]), el("th", {}, ["Mark"])])]));
    const tbody = el("tbody");
    upload.rows.slice(0, 10).forEach((r) => {
      tbody.appendChild(el("tr", {}, [el("td", {}, [r.adm_no]), el("td", {}, [r.name || "(blank)"]), el("td", {}, [CCML.fmtValue(r.mark)])]));
    });
    t.appendChild(tbody);
    tw.appendChild(t);
    wrap.appendChild(tw);
    if (upload.rows.length > 10) {
      wrap.appendChild(el("p", { class: "muted" }, [`...and ${upload.rows.length - 10} more row(s).`]));
    }
    return wrap;
  }

  function onSkipComponent() {
    const name = state.componentOrder[state.currentIndex];
    state.componentStatus[name] = { status: "skipped" };
    state.pendingUpload = null;
    state.currentIndex++;
    render();
  }

  function onContinueComponent() {
    const name = state.componentOrder[state.currentIndex];
    if (state.pendingUpload) {
      state.componentStatus[name] = { status: "uploaded", ...state.pendingUpload };
      state.pendingUpload = null;
    }
    state.currentIndex++;
    render();
  }

  function onBackComponent() {
    if (state.currentIndex === 0) return;
    state.pendingUpload = null;
    state.currentIndex--;
    render();
  }

  // -------------------------------------------------------------------
  // Run check
  // -------------------------------------------------------------------
  function computeIssues() {
    const issues = [];
    state.componentOrder.forEach((name) => {
      const st = state.componentStatus[name];
      if (st.status !== "uploaded") return;
      const compIssues = CCML.compareComponent(state.ccml, name, st.rows, state.roundMode);
      issues.push(...compIssues);
    });
    return issues;
  }

  function runCheckAndShowResults() {
    state.issues = computeIssues();
    state.checked = true;
    state.screen = "results";
    render();
  }

  function recompute() {
    state.issues = computeIssues();
    render();
  }

  // -------------------------------------------------------------------
  // Screen 3: Results
  // -------------------------------------------------------------------
  function renderResults() {
    const card = el("div", { class: "card" }, []);
    card.appendChild(el("h1", {}, ["Results"]));

    if (state.issues.length === 0) {
      card.appendChild(el("div", { class: "banner ok" }, ["✓ All checks passed -- no discrepancies found."]));
    } else {
      card.appendChild(el("div", { class: "banner error" }, [`${state.issues.length} issue(s) found -- review before signing off.`]));
    }

    // rounding control
    const roundSelect = el("select", {}, []);
    Object.entries(CCML.ROUND_MODES).forEach(([k, label]) => {
      roundSelect.appendChild(el("option", { value: k }, [label]));
    });
    roundSelect.value = state.roundMode;
    card.appendChild(
      el("div", { class: "row mt16" }, [
        el("div", { class: "field mb0" }, [el("label", { class: "field-label" }, ["Mark comparison"]), roundSelect]),
        el(
          "button",
          {
            class: "btn mt16",
            onclick: () => {
              state.roundMode = roundSelect.value;
              recompute();
            },
          },
          ["Recompute"]
        ),
      ])
    );

    if (state.issues.length > 0) {
      card.appendChild(el("h3", { class: "mt20" }, ["Issues"]));
      const tw = el("div", { class: "table-wrap" });
      const t = el("table");
      t.appendChild(
        el("thead", {}, [
          el("tr", {}, [
            el("th", {}, ["Component"]),
            el("th", {}, ["Admin No"]),
            el("th", {}, ["Name"]),
            el("th", {}, ["CCML"]),
            el("th", {}, ["Evidence"]),
            el("th", {}, ["Issue"]),
          ]),
        ])
      );
      const tbody = el("tbody");
      state.issues.forEach((i) => {
        tbody.appendChild(
          el("tr", { class: "issue-row" }, [
            el("td", {}, [i.component]),
            el("td", {}, [i.adm_no]),
            el("td", {}, [i.name || ""]),
            el("td", {}, [i.ccml_value === null || i.ccml_value === undefined ? "-" : String(CCML.fmtValue(i.ccml_value))]),
            el("td", {}, [i.evidence_value === null || i.evidence_value === undefined ? "-" : String(CCML.fmtValue(i.evidence_value))]),
            el("td", { class: "issue-cell" }, [i.issue]),
          ])
        );
      });
      t.appendChild(tbody);
      tw.appendChild(t);
      card.appendChild(tw);
    }

    // Fix a component
    card.appendChild(el("h3", { class: "mt20" }, ["Missed or wrong file for a component?"]));
    const fixSelect = el("select", {}, []);
    state.componentOrder.forEach((n) => fixSelect.appendChild(el("option", { value: n }, [n])));
    card.appendChild(
      el("div", { class: "row" }, [
        fixSelect,
        el("button", { class: "btn", onclick: () => openFixModal(fixSelect.value) }, ["Upload / Replace file..."]),
      ])
    );

    // Correction log
    if (state.auditLog.length) {
      card.appendChild(el("h3", { class: "mt20" }, ["Correction Log"]));
      const tw = el("div", { class: "table-wrap" });
      const t = el("table");
      t.appendChild(
        el("thead", {}, [
          el("tr", {}, [
            el("th", {}, ["Time"]),
            el("th", {}, ["Component"]),
            el("th", {}, ["Action"]),
            el("th", {}, ["File"]),
            el("th", {}, ["Issues before"]),
            el("th", {}, ["Issues after"]),
          ]),
        ])
      );
      const tbody = el("tbody");
      state.auditLog.forEach((a) => {
        tbody.appendChild(
          el("tr", {}, [
            el("td", {}, [a.time]),
            el("td", {}, [a.component]),
            el("td", {}, [a.action]),
            el("td", {}, [a.fileName || "-"]),
            el("td", {}, [String(a.beforeCount)]),
            el("td", {}, [String(a.afterCount)]),
          ])
        );
      });
      t.appendChild(tbody);
      tw.appendChild(t);
      card.appendChild(tw);
    }

    card.appendChild(
      el("div", { class: "row end mt20" }, [
        el("button", { class: "btn", onclick: exportReportCsv }, ["Export report as CSV"]),
      ])
    );

    appEl.appendChild(card);
  }

  // -------------------------------------------------------------------
  // Fix-a-component modal
  // -------------------------------------------------------------------
  function openFixModal(compName) {
    modalRoot.innerHTML = "";
    let uploadState = null;

    const body = el("div", { id: "fixModalBody" }, [
      el("p", { class: "muted" }, ["Pick a replacement evidence file (PDF or .xlsx) for this component."]),
      (() => {
        const input = el("input", { type: "file", accept: ".pdf,.xlsx,.xlsm" });
        input.addEventListener("change", async (ev) => {
          const file = ev.target.files[0];
          if (!file) return;
          const host = document.getElementById("fixPreviewHost");
          host.innerHTML = "";
          host.appendChild(el("p", { class: "muted" }, ["Reading file..."]));
          try {
            const table = await extractTableFromFile(file);
            const guess = CCML.guessColumns(table);
            const rows = CCML.buildComponentRows(table, guess.adminCol, guess.markColFromEnd);
            uploadState = { fileName: file.name, table, adminCol: guess.adminCol, markColFromEnd: guess.markColFromEnd, rows };
            function renderFixPreview() {
              host.innerHTML = "";
              host.appendChild(
                renderComponentPreview(uploadState, (a, m) => {
                  uploadState.adminCol = a;
                  uploadState.markColFromEnd = m;
                  uploadState.rows = CCML.buildComponentRows(table, a, m);
                  renderFixPreview();
                  applyBtn.disabled = false;
                })
              );
            }
            renderFixPreview();
            applyBtn.disabled = false;
          } catch (err) {
            host.innerHTML = "";
            host.appendChild(el("div", { class: "banner error" }, ["Could not read this file: " + err.message]));
          }
        });
        return input;
      })(),
      el("div", { id: "fixPreviewHost" }, []),
    ]);

    const applyBtn = el(
      "button",
      {
        class: "btn btn-primary",
        disabled: "true",
        onclick: () => {
          if (!uploadState) return;
          applyFix(compName, uploadState);
          closeModal();
        },
      },
      ["Apply and Recompute"]
    );

    const modal = el("div", { class: "modal" }, [
      el("h2", {}, [`Upload / Replace: ${compName}`]),
      body,
      el("div", { class: "row end mt20" }, [
        el("button", { class: "btn", onclick: closeModal }, ["Cancel"]),
        applyBtn,
      ]),
    ]);
    const overlay = el("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) closeModal(); } }, [modal]);
    modalRoot.appendChild(overlay);
  }

  function closeModal() {
    modalRoot.innerHTML = "";
  }

  function applyFix(compName, upload) {
    const before = state.issues;
    const wasStatus = state.componentStatus[compName].status;
    state.componentStatus[compName] = { status: "uploaded", ...upload };
    const after = computeIssues();
    const diff = CCML.diffIssues(before, after);
    state.issues = after;
    state.auditLog.push({
      time: new Date().toLocaleString(),
      component: compName,
      action: wasStatus === "skipped" ? "Uploaded (was skipped)" : "Replaced file",
      fileName: upload.fileName,
      beforeCount: before.length,
      afterCount: after.length,
      resolved: diff.resolved,
      still_issue: diff.still_issue,
      new_issue: diff.new_issue,
    });
    render();
  }

  // -------------------------------------------------------------------
  // CSV export
  // -------------------------------------------------------------------
  function csvEscape(v) {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildReportCsv() {
    const lines = [];
    lines.push(["CCML Mark Checker Report"].join(","));
    lines.push(["Generated", new Date().toLocaleString()].map(csvEscape).join(","));
    lines.push(["Class", state.ccml ? state.ccml.class_name || "" : ""].map(csvEscape).join(","));
    lines.push(["Subject", state.ccml ? state.ccml.subject || "" : ""].map(csvEscape).join(","));
    lines.push(["Rounding mode", CCML.ROUND_MODES[state.roundMode] || state.roundMode].map(csvEscape).join(","));
    lines.push("");
    lines.push(["Component", "Status", "File"].map(csvEscape).join(","));
    state.componentOrder.forEach((n) => {
      const st = state.componentStatus[n];
      lines.push([n, st.status, st.fileName || ""].map(csvEscape).join(","));
    });
    lines.push("");
    lines.push(["Issues"].join(","));
    lines.push(["Component", "Admin No", "Name", "CCML Value", "Evidence Value", "Issue"].map(csvEscape).join(","));
    if (state.issues.length === 0) {
      lines.push(["", "", "", "", "", "All checks passed"].map(csvEscape).join(","));
    } else {
      state.issues.forEach((i) => {
        lines.push(
          [i.component, i.adm_no, i.name || "", CCML.fmtValue(i.ccml_value), CCML.fmtValue(i.evidence_value), i.issue].map(csvEscape).join(",")
        );
      });
    }
    if (state.auditLog.length) {
      lines.push("");
      lines.push(["Correction Log"].join(","));
      lines.push(["Time", "Component", "Action", "File", "Issues Before", "Issues After", "Detail"].map(csvEscape).join(","));
      state.auditLog.forEach((a) => {
        const detailParts = [];
        a.resolved.forEach((r) => detailParts.push(`RESOLVED ${r.adm_no} ${r.name || ""}: ${r.issue}`));
        a.still_issue.forEach((r) => detailParts.push(`STILL PRESENT ${r.adm_no} ${r.name || ""}: ${r.issue}`));
        a.new_issue.forEach((r) => detailParts.push(`NEW ${r.adm_no} ${r.name || ""}: ${r.issue}`));
        lines.push(
          [a.time, a.component, a.action, a.fileName || "", String(a.beforeCount), String(a.afterCount), detailParts.join(" | ")]
            .map(csvEscape)
            .join(",")
        );
      });
    }
    return lines.join("\n");
  }

  function exportReportCsv() {
    const csv = buildReportCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `CCML_Check_Report_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  render();
})();
