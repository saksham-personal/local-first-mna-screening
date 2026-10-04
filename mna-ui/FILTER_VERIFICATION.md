# Companies filter verification

Verified on 5 October 2026 in the running application at `http://127.0.0.1:4173/` using the existing four-company fictional MID screening. No company data, criteria, approvals or exports were changed.

The reproduced fault was the column-filter popup closing during table updates. An inline selection callback rebuilt the column definitions, and inline default-column settings caused further grid reconfiguration. Repeated row-count notifications also generated unnecessary renders.

`src/workspace/CompanyGrid.tsx` now uses stable default settings, row identity, selection configuration and pagination options. `src/WorkspaceApp.tsx` supplies a stable selection callback and ignores unchanged count notifications. The grid stays mounted when an external search/source filter yields zero rows, preserving active column filters.

| Interaction in the running browser | Verified result |
|---|---|
| Click Company filter; enter Harbor | One matching row, 1 of 4 count; popup stays open after filtering |
| Change Harbor to Cedar in the open popup | Cedar is the only row; popup remains editable |
| Enter a nonexistent company | Zero rows, 0 of 4 count; filter controls remain available |
| Clear the company filter | All four rows return |
| Click HQ location filter; enter Boston | HarborPoint is the only row |
| Combine Boston with toolbar search Cedar | Zero rows; clearing toolbar search restores the Boston match |
| Change source to ISCC, then All sources | Zero rows, then one Boston match; the location filter survives |
| MID score equals 0, then 1 | Zero rows, then all four rows; numeric filter remains editable |
| Click the clear icon after the final visual check | All four rows return; popup closed and table left ready |

Page size remained 50 throughout the fixed-build checks. MID and ISCC scores remain separate. Toolbar and column filters affect the displayed rows; exports still use the full saved set.

All 79 UI tests passed. TypeScript and the production build passed; Vite retained its existing large-chunk warning. Browser actions used the computer-use API, with native CDP mouse input for the grid's icon controls and keyboard input for the numeric filter. Some higher-level automation clicks could not target AG Grid icons reliably; native mouse clicks confirmed the actual user interactions.

Visual proof is saved locally at `output/playwright/company-filter-fixed.jpg` and excluded from the source archive. The screenshot shows the applied Harbor filter, the open popup and the 1-of-4 count. The browser was returned to the unfiltered list after capture. No subagents were needed for this two-component correction.
