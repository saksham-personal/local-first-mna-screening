# Configurable research gateway contracts

The Rust service calls configured JSON gateways. The LLMSuite and M365 text and screening adapters are implemented; corporate endpoints remain unconfigured and unverified. The private ISCC browser/CDP protocol requires a separate bridge that parses CSV/XLSX and returns the JSON rows below. `MNA_ENABLE_EXTERNAL=true` enables configured external providers and public URL fetching. Each gateway also needs its own `MNA_<PROVIDER>_ENDPOINT`, `MNA_<PROVIDER>_TOKEN`, and optional `MNA_<PROVIDER>_RPM`. Production endpoints require HTTPS; local test endpoints can use HTTP. Tokens are bearer credentials. Keep them out of tool arguments and plans. See [the execution contract](EXECUTION_CONTRACT.md) for screening and [the LLMSuite protocol](LLMSUITE_PROTOCOL.md) for parsed text responses, approvals, shared rate limits, and durable receipts.

## Requests sent to the gateway

| Tool | JSON sent |
|---|---|
| `search_iscc` | `{"query":"insurance policy administration software","limit":500}` |
| `bing_search` | `{"query":"Does Carrier Cloud build policy administration software?","max_results":20}` |
| `m365_research` | `{"question":"Which products support policy administration?","companies":["Carrier Cloud; https://carrier.example [100-101]"],"required_fields":["products"]}` |

ISCC receives only `query` and `limit`. It does not receive local `run_id`, `plan_id`, `step_id`, filters, company IDs, or a chosen score cutoff. The query is qualitative and at most 14 words. The result limit defaults to 500 and cannot exceed 1,000. A plan permits at most five variants.

Bing receives only its literal query and result limit. Local company, run, plan, and step IDs support approval and evidence scope but do not enter gateway JSON. An approved research plan expands three to five fit questions into exact company/query pairs. The caller must preserve the IDs locally with the receipt.

For M365, local `company_ids` are checked against the approved plan scope. They derive one gateway `companies` string per company from its preferred name, usable website, and canonical ID. Omit the `companies` argument or supply exactly the derived list; a different list is rejected. Only `question`, `companies`, and `required_fields` reach the gateway. A criteria-only question can use no company IDs. Local `run_id`, `plan_id`, `step_id`, and the structured `company_ids` array are not forwarded. The derived `companies` strings include canonical IDs.

## Responses

ISCC must return a JSON object with an array named `rows`, `results`, `companies`, or `value`. Each row must be an object, and the array must not exceed the requested limit. The bridge should preserve the source columns it has: ECID, CID, company name, website, HQ city/state, description, and relevance score. For example:

```json
{
  "rows": [
    {
      "ECID": "100",
      "CID": "101",
      "Company Name": "Carrier Cloud",
      "Website": "https://carrier.example",
      "HQ City": "Pune",
      "HQ State": "Maharashtra",
      "Description": "Builds insurance policy software",
      "Relevance Score": 0.81
    }
  ]
}
```

Rust retains raw row JSON and normalizes IDs. It returns unique canonical companies with the highest observed relevance score and MID-preferred common fields, raw and unique result counts, score bands, retrieval time, and `cutoff_applied:false`. Read original rows with `get_source_rows` or Full Export. `usual_reference_cutoff:0.45` is a guide, not a filter. The bridge is responsible for its own export conversion; the current Rust source-row store has query/run provenance but no original file/sheet/row locators.

Bing and M365 may return an answer and sources, citations, or result arrays. For example:

```json
{"answer":"Carrier Cloud offers policy administration software.","sources":[{"title":"Company site","url":"https://carrier.example","snippet":"Product description"}]}
```

The adapter recognizes answer fields `answer`, `response`, `summary`, or `text`. It recognizes `results`, `companies`, `value`, `sources`, `citations`, and Bing's `webPages.value`. A recognized empty array is a valid empty answer; an error object, invalid JSON, missing recognized shape, network failure, or excess ISCC rows is a provider error. Normalized research results include provider, query, answer, sources, timestamp, cached flag, and ranked items. Item metadata retains source fields. A search routed through the search engine also records query provenance.

The response cache and rate counters are local to one running service instance and reset at restart. Durable query, evidence, and successful operation records support recovery. A provider failure is never converted to an empty successful result or a negative fit conclusion.
