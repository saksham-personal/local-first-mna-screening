# Discovery retrieval and local inference

`search_mid` and `search_iscc` default to **1,000** results and accept at most 1,000 per query. Discovery uses core-business descriptions only. Non-core geography, revenue, employee size, ownership, classification, ID filters and additional positive keyword filter fields do not narrow the MID funnel; ignored field names appear in diagnostics. Put the actual qualitative terms in the query. ISCC receives only the qualitative query and limit.

A MID exclusion narrows discovery only when it matches `content.core_business_exclusions` in the current analyst-approved profile (case/outer whitespace ignored). Query negation tokens, including NOT, EXCLUDE, parenthesized NOT and minus, are rejected before retrieval so they cannot bypass approval. A quoted literal word is not a Boolean negation token. The controller must also explain deferred free-text criteria to the analyst.

## Embedder and model-specific index

The default identity is `Snowflake/snowflake-arctic-embed-m-v2.0`, version `v2.0-int8-onnx`, dimensions **768**. [Snowflake's model card](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0) documents dimensions, a `query: ` prefix for queries, CLS pooling and L2 normalization; the repository contains [INT8 ONNX weights](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0/blob/main/onnx/model_int8.onnx). Model files are not bundled/downloaded automatically. Model benchmarks do not establish recall on MID.

Set `MNA_EMBED_ENDPOINT` to a loopback HTTP worker. `MNA_EMBED_MODEL`, `MNA_EMBED_VERSION` and `MNA_EMBED_DIMENSIONS` replace its identity. The embedding adapter sends:

```json
{"model":"Snowflake/snowflake-arctic-embed-m-v2.0","version":"v2.0-int8-onnx","dimensions":768,"texts":["Business description"]}
```

The response must have the same identity and a `vectors` array. `embed_texts` accepts 1–32 nonempty texts, each at most 16,000 bytes, and validates count, dimensions, finite values and nonzero norm. Response reads are bounded. Calling this tool alone does not write a company index.

Use the analyst operation `/admin/embedding-index` (`rebuild_embedding_index`) to populate the model-specific SQLite index. It pages up to 1,000 companies, embeds at most 32 at once (default 16), and returns the next company cursor. Repeat until complete. Documents contain only trimmed company descriptions. Each vector is float32 with company ID, model, version, dimensions and SHA-256 of the exact embedded text. Saving skips rows whose description changed during the request. Reading rejects incompatible identity/dimensions or stale description hashes. A model, tokenizer, pooling or truncation change requires a new version and rebuild.

Semantic/hybrid query search with a configured adapter automatically embeds `query: <query>` and uses only that model's fresh index. There is no fabricated fallback vector. Without an adapter, semantic search reports unavailable; hybrid can use its explicitly reported lexical fallback. Example-similarity tools require compatible current vectors when an adapter is configured. Explicit caller vectors and old unversioned stored vectors remain a separate legacy path with unverified model identity; they are not labeled Arctic results.

## Optional CPU worker

`scripts/local_embed_worker.py` serves a local serial ONNX worker using CPUExecutionProvider only. Install its isolated dependencies from `scripts/requirements-local-embed.txt`, supply the local model and tokenizer JSON paths, and start it:

```powershell
py -3 scripts/local_embed_worker.py --model C:/models/model_int8.onnx --tokenizer C:/models/tokenizer.json
$env:MNA_EMBED_ENDPOINT = 'http://127.0.0.1:8765/embed'
```

Check `--help` for actual model/version/port/truncation options. The worker validates requested identity, feeds supported ONNX inputs, uses the tokenizer's padding token, extracts CLS (or compatible pooled output), normalizes output, and checks 768 dimensions. Defaults use two CPU intra-op threads, one inter-op thread, sequential execution and 512-token truncation. Truncation is editable and must be reflected in the version. The health response includes asset hashes and preprocessing settings. No GPU, WebGL or local generative model is required.

Worker protocol/tokenization tests use mocked sessions. **Actual ONNX weights, tokenizer and large-corpus inference have not been executed or benchmarked.** Match the worker version to the Rust environment before indexing. The model card supports a longer sequence limit; the 512-token default is an explicit CPU operating choice, not a claim about maximum model capability.

## Replaceable reranker

The model is undecided. Configure a loopback worker with `MNA_RERANK_ENDPOINT`, `MNA_RERANK_MODEL` and `MNA_RERANK_VERSION`. `rerank_candidates` accepts at most 1,000 unique candidates from one source/query group and sends only the first 500:

```json
{"model":"chosen-reranker","version":"chosen-version","query":"claims software","candidates":[{"company_id":"C1","description":"Claims software","source":"MID","retrieval_score":0.8,"query_id":"Q1"}]}
```

Response: `{"model":"chosen-reranker","version":"chosen-version","results":[{"company_id":"C1","score":0.9}]}`. Every submitted ID must appear exactly once, with a finite score and matching identity. Sort the reranked prefix by descending score with a deterministic ID tie-break. Preserve positions 501–1,000 in original order with `rerank_score:null`. Retain source, query ID, original retrieval score and reranker provenance for every company. Do not combine MID and ISCC scores or discard the tail.

`get_retrieval_config` reports planned/configured_but_unverified and `executed:false` for inspection. Actual successful adapter calls report execution. The default model identity alone does not mean assets are installed. Local model responsibilities stop at embedding and reranking; LLMSuite/M365/Bing handle generation and research.
