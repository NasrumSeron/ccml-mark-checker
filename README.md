# CCML Mark Checker (Web)

A browser-based version of the CCML Mark Checker — cross-checks a Component
Mark List (CCML) PDF against your per-component evidence files (PDF/Excel
grade exports) and flags any discrepancy before you sign off on final marks.

This is a **static site**: HTML, CSS and JavaScript only, no server, no
build step, no login. It's meant to be hosted for free on GitHub Pages so
colleagues can use it from a link, even on laptops that block installing or
running `.exe` files.

No AI/LLM involved — marks are compared as exact numbers, deterministically
(same logic as the desktop version).

## Privacy — read this first

**Everything runs locally in your browser tab.** The CCML PDF and every
component evidence file you upload are read and processed entirely on your
own computer, using two vendored JavaScript libraries (`pdf.js` for PDF
text extraction, `SheetJS` for Excel) that ship inside this repo. There is
no backend, no API call, no upload — nothing about a student's marks is
ever sent anywhere, including to GitHub, even though the app itself is
hosted on a public GitHub Pages URL. Closing or refreshing the tab clears
everything; nothing is saved between visits.

## How to use it

Same flow as the desktop app:

1. **Load CCML** — pick the CCML PDF. The app shows the detected class,
   subject, student count and full component list (Max/Weight) plus a
   student preview. Check this before continuing.
2. **Per component** — for each component in turn, either upload the
   evidence file (`.pdf` or `.xlsx`) or **Skip** if you don't teach/hold
   it. On upload, the app guesses which column holds the admin number and
   which holds the mark, and shows both as editable dropdowns next to a
   live preview — if a guess looks wrong (garbled names, marks that don't
   make sense), change the dropdown; the preview updates immediately.
3. **Automatic check** — once every component is uploaded or skipped,
   click **Run check**. Marks are compared student-by-student (matched by
   admin number) with zero tolerance by default. It also flags students in
   the CCML missing from the evidence file, and rows in the evidence file
   with no matching CCML student.
4. **Results** — every issue is listed, or a clean "All checks passed". Use
   the **Mark comparison** dropdown + **Recompute** if the CCML export
   rounds marks (e.g. to a whole number) while your evidence file keeps
   decimals. Use **Missed or wrong file for a component?** to
   upload/replace a component's file after the fact — every correction is
   timestamped in the **Correction Log**, with per-student before/after
   detail. **Export report as CSV** downloads a copy for your records.
5. **Reset** (top-right) — clears everything and starts over. Nothing is
   ever written to disk automatically (unlike the desktop version) since a
   browser can't do that silently — export the CSV if you want to keep a
   copy.

## Known limitations

Same as the desktop version, plus a couple specific to browser-side PDF
parsing:

- **Component evidence layouts vary** — the parser guesses the admin
  number/mark columns; always check the preview and use the dropdowns if a
  guess looks wrong.
- **Excel support covers `.xlsx`/`.xlsm` only.** Old-style `.xls` isn't
  supported — re-save/export as `.xlsx` first.
- **Zero mark tolerance by default** — any difference is flagged unless you
  switch the rounding mode.
- A CCML component name that wraps onto a second line in the PDF (e.g.
  "Online Test 1 (Theory)") may occasionally show without its wrapped
  suffix (e.g. just "Online Test 1") in this web version. This is
  cosmetic only — matching is done by column position, not by name text,
  so it never affects the comparison result.
- No files are saved automatically (browsers can't write silently to disk)
  — use **Export report as CSV** to keep a copy of a result.

## Hosting this on GitHub Pages

You'll need a GitHub account with permission to create a public repo (or
push to an existing one).

1. **Create a new repository** on GitHub (e.g. `ccml-mark-checker`). It can
   be public — the site is static and, per above, no data is ever sent to
   it; only this app's source code is public.
2. **Push these files** to the repo's default branch (`main`), keeping the
   folder structure as-is:
   ```
   git init
   git add .
   git commit -m "CCML Mark Checker web app"
   git branch -M main
   git remote add origin https://github.com/<you>/ccml-mark-checker.git
   git push -u origin main
   ```
3. **Enable Pages**: on GitHub, go to the repo's **Settings → Pages**.
   Under "Build and deployment", set **Source** to "Deploy from a branch",
   pick branch `main` and folder `/ (root)`, then **Save**.
4. Wait a minute or two, then refresh that Settings → Pages screen — it
   will show your live URL, something like:
   ```
   https://<you>.github.io/ccml-mark-checker/
   ```
5. **Share that link** with colleagues. It works in any modern desktop
   browser (Chrome, Edge, Firefox) — no install needed on their end either.

### Updating it later

Any time you want to change the app, edit the files and push again:
```
git add .
git commit -m "Update"
git push
```
GitHub Pages redeploys automatically within a minute or two.

## Files

- `index.html`, `styles.css`, `app.js` — the app.
- `core.js` — the parsing/comparison logic (framework-agnostic; also
  usable under Node for testing).
- `vendor/pdf.min.js`, `vendor/pdf.worker.min.js` — pdf.js (PDF text
  extraction), vendored so the app has zero external dependencies at
  runtime.
- `vendor/xlsx.full.min.js` — SheetJS (Excel parsing), also vendored.

## Relationship to the desktop (.exe) version

Same core logic, same checks, same UX — this is a from-scratch port to
run entirely client-side in a browser instead of as a Python/Tkinter
desktop app, specifically so it can be shared as a link instead of an
executable file. If your laptop can run the `.exe` freely, that version
works identically and additionally auto-saves a report copy to disk after
every check — either is fine to use.
