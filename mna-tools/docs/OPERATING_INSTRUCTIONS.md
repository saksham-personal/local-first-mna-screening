# Analyst operating instructions

These steps use short, direct sentences and one action per instruction. They follow the intent of ASD-STE100 controlled language. They have not been checked against its approved-word dictionary and do not claim formal ASD-STE100 compliance. The local example uses fictional MID data. External ISCC, LLMSuite, M365, and Bing services are not connected by default. See [the workflow](WORKFLOW.md) and [tool reference](../TOOL_REFERENCE.md).

## Terms

| Term | Meaning |
|---|---|
| Run | One saved screening project. |
| Criteria revision | One saved version of the analyst's criteria and examples. |
| Considered company | A saved company in the current working scope. |
| Hidden company | A saved company outside the current working scope. It remains in history. |
| Source observation | One MID or ISCC result from one query. |
| `pk` | The stable company ID used in exports. |
| `CHECK` | A score cell that needs analyst review. It is not a number. |

## A. Prepare and approve criteria

1. Enter the company's core products and services. You can attach a DDI. The local example can use UTF-8 TXT for a draft; PDF and DOCX text extraction is not connected.
2. Read the proposed business criteria. Edit unclear terms and exclusions.
3. Keep revenue, size, geography, ownership, and industry codes for later review. Do not use them as first-search filters.
4. Accept the business review. Enter optional good-fit examples in one box and bad-fit examples in the other. You can skip both boxes.
5. Read the final criteria. Approve that saved revision.

**Check:** The UI saves the draft in a Rust run before discovery. Only the last approved revision can authorize new discovery or execution. If you edit criteria later, approve the new revision and prepare affected work again. Earlier saved companies and results remain in history.

## B. Search and review companies

1. Search broadly for products, services, descriptions, and customer problems. Use MID. Use ISCC only if its gateway is configured.
2. Use more than one useful query when one query misses a business type. A query call can return at most 1,000 results; that is not a limit on the run.
3. Keep each query's source, rank, and retrieval score. Do not treat retrieval score as a fit score. Do not combine MID and ISCC scores.
4. Review the saved company list. Check MID-only, ISCC-only, both-source, and other counts for **considered** companies.
5. Search again if you need more targets. Do not replace earlier company data or hidden decisions.

**Check:** An exact ECID/CID bridge can join identities. A similar name or website cannot join identities by itself. A company with neither ID is excluded and reported. The list can contain more than 1,000 saved companies; the UI reads it in pages.

## C. Choose the next action

1. Open **Company enrichment** for PitchBook or ROGO files.
2. Open **Research and screening** for LLMSuite, M365, or Bing. Both groups remain available.
3. Read recommendations as suggestions. Use the number `n` of considered companies:

   - PitchBook and Bing: `0 < n < 1000`.
   - ROGO: `500 < n < 2000`.
   - LLMSuite: `n > 2000`.
   - M365: `0 < n < 250` when PitchBook context exists.

4. Expect **Research and screening** to open first when `n > 5000`, when any PitchBook/ROGO/Bing context exists, or when `0 < n < 500`. At other counts, expect **Company enrichment** to open first. You can open the other group at any time.

**Example:** A broad set can move from 2,500 considered companies to 400, then 150, then 55 after review. At 2,500, LLMSuite is suggested. At 400, research opens first. At 150 with PitchBook context, M365 is suggested. Export the 55 still-considered companies when the review is complete. These numbers are an example, not an automatic removal rule.

## D. Add source data

1. Drop a PitchBook mapping CSV and its data workbook into the PitchBook step. The mapping header must contain the required eight columns. Only `Company Profile = Yes` can add PBId.
2. Review the new shortlist after a mapping import. Explicit `No` and unmapped rows can become hidden. The mapping import can also hide all remaining unmapped rows in the run. Restore any company that you want to consider.
3. Drop a ROGO workbook into the ROGO step. The importer matches websites. An unrelated ROGO file does not reapply an earlier PitchBook mapping exclusion.
4. Read the updated company context. Imported source data does not run screening by itself.

**Check:** Source rows and hidden decisions remain saved. A new source value makes a prepared screening plan stale. Preview and approve another plan before use.

## E. Ask, screen, or research

1. To ask LLMSuite or M365 a direct question, write it in chat. You do not need screening setup. Chat-purpose attachments are included by default. Turn off a file's provider toggle to omit it.
2. To screen companies, select input and output column chips. Review the prompt. Use AI prompt drafting only when a provider is connected. Leave the model field empty to use the configured deployment or the saved `automatic` placeholder.
3. Preview the exact inputs, prompt, and rows. Approve the digest. The saved plan starts with `executed:false`. A disconnected provider cannot run it.
4. When connected, the controller sends approved jobs. Require `index` plus the requested output columns. Use 0–10 or `CHECK` in a declared fit-score column. Rust rejects an incomplete or malformed response and allows at most two parsing repairs. LLMSuite shares seven actual sends per rolling minute across all purposes.
5. For Bing, enter one to five query chips or request AI suggestions when connected. Preview the count and samples. Approve the queries for all considered companies. The client continues through pages of at most 100 sends until complete.
6. Treat web findings as unverified leads. A missing answer is unknown. Do not create an analyst label from a provider answer.

**Check:** The local example reports `executed:false` for disconnected providers. A saved plan does not mean a provider received data. An edited criterion, source, candidate selection, or model setup requires fresh preparation and approval.

## F. Keep, hide, repeat, and export

1. Review fit scores and source evidence. Keep strong matches and `CHECK` cases that need work. Hide companies that you do not want in the current scope.
2. Select useful saved RESULTS columns as context for a later screen. Add source data or research questions when needed.
3. Return to criteria at any point. Save and approve the new revision before more discovery or execution.
4. Export the considered companies as PitchBook, LLM, or Full XLSX. Hidden companies stay in history and are outside the current export.

**Check:** Rust keeps old results with their original plan and company indexes. An old result cannot silently become current after a change. Reconcile an uncertain provider send before retrying it. The local discovery job ends if its process stops; Rust execution jobs and completed writes are durable.
