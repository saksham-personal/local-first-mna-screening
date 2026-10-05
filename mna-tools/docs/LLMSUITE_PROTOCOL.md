# LLMSuite text protocol v1

This is the implemented Rust parsing and controller contract. The local UI does not have a live LLMSuite connection by default; preparing or approving a plan returns `executed:false` until a trusted provider is configured. A direct chat question can use LLMSuite without opening scored-screening setup. The same Rust controller gate applies to that text request when connected.

The controller sends the model the tools allowed for the current turn and their argument descriptions. A tool command is **one complete text block**, with no introduction, code fence, second block, or closing commentary:

```text
BEGIN TOOL v1 search_mid
run_id:text = "run-42"
query:text = "industrial pump manufacturers"
mode:text = "hybrid"
limit:number = 1000
END TOOL
```

The controller passes the exact allowed tool names to `parse_tool_response`. The parser returns a typed object for the internal runtime. The model never emits a JSON tool call. The runtime validates each tool's argument schema, authorization and run scope before execution. An empty argument object is represented by a header immediately followed by `END TOOL`. The live `/agent/tools` catalog gives plain-language guidance; `/agent/commands` validates the response, performs the tool and caches its outcome under the request/attempt key. It excludes analyst labels and legacy result-saving handoffs from the model allowlist. A crashed PENDING command is held for operator reconciliation, not silently replayed.

Each field has `path:type = value` on one line. A path starts with an identifier (`[A-Za-z_][A-Za-z0-9_]*`), then uses `.name` for nested object fields, `[0]` for array positions, or `["arbitrary.key"]` for map keys. Array positions start at zero and must be contiguous. Order of assignments does not matter. A field may be assigned only once, and no field may be both a value and the parent of another path. Paths have at most 24 segments; indexes are at most 4095. The response is limited to 256 KiB and 4096 fields.

Types are `text`, `number`, `boolean`, `null`, `empty-list`, and `empty-map`. `null`, `empty-list`, and `empty-map` use `-` as their value. A number uses finite JSON decimal notation; a boolean is exactly `true` or `false`. Text is double quoted, with only `\\`, `\"`, `\n`, `\r`, `\t`, and `\u{HEX}` escapes. Literal Unicode is allowed. Longer text uses `<<TAG` on its assignment line, raw lines after it, and a line containing only `TAG` to finish. The terminator must be unique within that field and use 1–32 ASCII letters, digits, or underscores. The joined text contains `\n` between body lines, with no implicit trailing newline.

A nested plan can carry arrays, source choices, and arbitrary parameter maps:

```text
BEGIN TOOL v1 propose_action_plan
run_id:text = "run-42"
rationale:text = <<WHY
Search source candidates, then screen their core business.
Keep uncertain ownership for review.
WHY
steps[0].step_id:text = "search"
steps[0].kind:text = "search_mid"
steps[0].depends_on:empty-list = -
steps[0].query_templates[0]:text = "industrial pumps"
steps[0].parameters["source.name"]:text = "MID"
steps[1].step_id:text = "screen"
steps[1].kind:text = "llm_screening"
steps[1].depends_on[0]:text = "search"
steps[1].company_ids[0]:text = "C-001"
steps[1].parameters.batch_size:number = 100
END TOOL
```

`parse_tool_response` rejects an unknown tool or type, extra prose, duplicate fields, conflicting paths, sparse arrays, malformed quoting, invalid numbers, excess size, and multiple blocks. The controller should retry a rejected response with `repair_prompt`, at most twice per request; the helper reports a bounded error and the allowed names without echoing the model's raw output. Every actual repair send shares LLMSuite's seven-send rolling-minute gate with orchestration, direct questions, and screening. Exhausted attempts should fail the operation and preserve the rejected raw response only in the controller's quarantine/audit store.

## Index-only Markdown results

For screening results, the controller provides a frozen set of integer indexes and an ordered list of requested columns. The UI can leave the model field empty; preparation binds the configured LLMSuite deployment or records `automatic` while disconnected. The controller must resolve a real deployment before an external send and must never send literal `automatic` to a provider. The analyst's digest approval binds the exact input rows, prompt, columns, and deployment. The model returns exactly one Markdown table, without a code fence or prose. Its header is `index` followed by those columns in that order, with exact spelling and case:

```text
| index | Fit Score | Rationale | Product Ownership |
| --- | --- | --- | --- |
| 2 | 8.5 | Makes the core product | Private |
| 7 | CHECK | Ownership unclear | Unknown |
```

The table has one row per frozen index, in any row order. `parse_markdown_results` returns rows in the controller's expected index order. Every row contains exactly `index` and the requested fields. It rejects duplicate, missing, or out-of-scope indexes, extra columns or prose, malformed separator lines, unsupported escapes, and invalid scores. A literal pipe inside a cell is `\|`; a literal backslash is `\\`. Markdown cell padding is trimmed. For declared score columns only, the cell must be a finite number from 0 through 10 inclusive or exactly `CHECK`; numeric scores become numbers in the returned object. Other cells remain text, including numeric-looking text. No company ID, name, or primary key is inferred from model output. The controller maps each validated index to its frozen server-owned identity and persists all-or-nothing results with the attempt provenance.

Leading/trailing blank lines, UTF-8 BOM, and CRLF are accepted. Blank lines within the table, code fences, and any surrounding explanation are rejected. The table parser is limited to 256 KiB and 4096 expected rows. The controller owns the two-repair limit and frozen index map; this module only validates one candidate response. An upload, criteria edit, shortlist change, or source change can make the plan stale; a late response stays historical and does not silently update the current shortlist.
