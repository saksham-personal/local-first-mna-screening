#!/usr/bin/env python3
"""Small, opt-in ONNX CPU embedding service for the local MNA tool server.

The worker never downloads models. Supply an ONNX file and a tokenizers JSON
file explicitly with --model and --tokenizer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
from typing import Any
from urllib.parse import urlsplit

DEFAULT_MODEL = "Snowflake/snowflake-arctic-embed-m-v2.0"
DEFAULT_VERSION = "v2.0-int8-onnx"
DEFAULT_DIMENSIONS = 768
MAX_REQUEST_BYTES = 600 * 1024
SUB_BATCH = 8
MAX_TEXTS = 32
MAX_TEXT_BYTES = 16_000


class WorkerError(Exception):
    """Safe, user-facing input or inference error."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_request(payload: Any, identity: dict[str, Any]) -> list[str]:
    if not isinstance(payload, dict):
        raise WorkerError("Request JSON must be an object.")
    if not isinstance(payload.get("model"), str) or not isinstance(payload.get("version"), str) or type(payload.get("dimensions")) is not int:
        raise WorkerError("Request model identity has invalid field types.")
    for key in ("model", "version", "dimensions"):
        if payload.get(key) != identity[key]:
            raise WorkerError(f"Request {key} does not match the loaded model identity.")
    texts = payload.get("texts")
    if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_TEXTS:
        raise WorkerError("texts must contain between 1 and 32 strings.")
    for text in texts:
        if not isinstance(text, str) or not text.strip():
            raise WorkerError("Each text must be a nonempty string.")
        if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
            raise WorkerError("Each text must be at most 16000 UTF-8 bytes.")
    return texts


def normalize_outputs(output: Any, batch_size: int, dimensions: int, np: Any = None) -> list[list[float]]:
    if np is None:
        try:
            import numpy as np  # type: ignore[no-redef]
        except ImportError as exc:
            raise WorkerError("Local embedding dependencies are missing; install scripts/requirements-local-embed.txt.") from exc
    values = np.asarray(output)
    if values.ndim == 3:
        if values.shape[0] != batch_size or values.shape[1] < 1:
            raise WorkerError("ONNX model returned an invalid token embedding shape.")
        values = values[:, 0, :]
    elif values.ndim != 2:
        raise WorkerError("ONNX model output must be token embeddings or pooled vectors.")
    if values.shape != (batch_size, dimensions):
        raise WorkerError("ONNX model output dimensions do not match the configured model identity.")
    values = values.astype(np.float64, copy=False)
    if not np.isfinite(values).all():
        raise WorkerError("ONNX model returned non-finite embedding values.")
    norms = np.linalg.norm(values, axis=1)
    if not np.isfinite(norms).all() or (norms <= 0).any():
        raise WorkerError("ONNX model returned an invalid zero-length embedding.")
    normalized = values / norms[:, None]
    return normalized.tolist()


class Embedder:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.identity = {"model": args.model_name, "version": args.version, "dimensions": args.dimensions}
        self.session = None
        self.tokenizer = None
        self.np = None
        self.input_names: set[str] = set()
        self.output_name: str | None = None
        self.hashes: dict[str, str] = {}

    def load(self) -> None:
        model_path = Path(self.args.model).expanduser()
        tokenizer_path = Path(self.args.tokenizer).expanduser()
        if not model_path.is_file():
            raise WorkerError(f"ONNX model file not found: {model_path}")
        if not tokenizer_path.is_file():
            raise WorkerError(f"Tokenizer file not found: {tokenizer_path}")
        try:
            import numpy as np
            import onnxruntime as ort
            from tokenizers import Tokenizer
        except ImportError as exc:
            raise WorkerError("Local embedding dependencies are missing; install scripts/requirements-local-embed.txt.") from exc
        if "CPUExecutionProvider" not in ort.get_available_providers():
            raise WorkerError("ONNX Runtime CPUExecutionProvider is unavailable.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = self.args.intra_op_threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
            tokenizer = Tokenizer.from_file(str(tokenizer_path))
            padding = tokenizer.padding
            if padding:
                pad_token, pad_id = padding["pad_token"], padding["pad_id"]
            else:
                pad_token = next((token for token in ("[PAD]", "<pad>") if tokenizer.token_to_id(token) is not None), None)
                pad_id = tokenizer.token_to_id(pad_token) if pad_token else None
            if pad_id is None or pad_token is None:
                raise WorkerError("Tokenizer must define a [PAD] or <pad> token.")
            tokenizer.enable_truncation(max_length=self.args.max_tokens)
            tokenizer.enable_padding(pad_id=pad_id, pad_token=pad_token)
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("Could not load the supplied ONNX model and tokenizer files.") from exc
        inputs = session.get_inputs()
        outputs = session.get_outputs()
        names = {item.name for item in inputs}
        unknown = names - {"input_ids", "attention_mask", "token_type_ids"}
        if unknown:
            raise WorkerError("ONNX model requires unsupported inputs: " + ", ".join(sorted(unknown)))
        if "input_ids" not in names:
            raise WorkerError("ONNX model must have an input_ids input.")
        if not outputs:
            raise WorkerError("ONNX model must expose an embedding output.")
        if session.get_providers() != ["CPUExecutionProvider"]:
            raise WorkerError("ONNX model did not initialize with CPUExecutionProvider only.")
        output = next((item.name for item in outputs if item.name == "last_hidden_state"), outputs[0].name)
        self.session, self.tokenizer, self.np, self.input_names, self.output_name = session, tokenizer, np, names, output
        self.hashes = {"model_sha256": sha256_file(model_path), "tokenizer_sha256": sha256_file(tokenizer_path)}

    def embed(self, texts: list[str]) -> list[list[float]]:
        if self.session is None or self.tokenizer is None or self.np is None:
            raise WorkerError("Embedding model is not loaded.")
        # Similar-length texts run together so short texts are not padded to the longest one.
        order = sorted(range(len(texts)), key=lambda index: len(texts[index]))
        vectors: list[list[float]] = [[] for _ in texts]
        for start in range(0, len(order), SUB_BATCH):
            indexes = order[start:start + SUB_BATCH]
            for index, vector in zip(indexes, self._embed_batch([texts[i] for i in indexes])):
                vectors[index] = vector
        return vectors

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        try:
            encodings = self.tokenizer.encode_batch(texts)
            feeds: dict[str, Any] = {
                "input_ids": self.np.asarray([item.ids for item in encodings], dtype=self.np.int64),
            }
            if "attention_mask" in self.input_names:
                feeds["attention_mask"] = self.np.asarray([item.attention_mask for item in encodings], dtype=self.np.int64)
            if "token_type_ids" in self.input_names:
                feeds["token_type_ids"] = self.np.asarray([item.type_ids for item in encodings], dtype=self.np.int64)
            outputs = self.session.run([self.output_name], feeds)
            if not outputs:
                raise WorkerError("ONNX model returned no embedding output.")
            return normalize_outputs(outputs[0], len(texts), self.identity["dimensions"], self.np)
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("Local ONNX embedding inference failed.") from exc


def make_handler(embedder: Embedder):
    class Handler(BaseHTTPRequestHandler):
        server_version = "LocalEmbedWorker/1"
        sys_version = ""

        def _json(self, status: int, value: dict[str, Any]) -> None:
            raw = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if urlsplit(self.path).path != "/health":
                self._json(404, {"error": "Endpoint not found."})
                return
            self._json(200, {"status": "ready" if embedder.session is not None else "not_ready",
                **embedder.identity, "max_tokens": embedder.args.max_tokens,
                "intra_op_threads": embedder.args.intra_op_threads,
                "versioning_note": "Change version whenever model/tokenizer hashes or max_tokens change.",
                "execution_provider": "CPUExecutionProvider", **embedder.hashes})

        def do_POST(self) -> None:
            if urlsplit(self.path).path not in ("/", "/embed"):
                self._json(404, {"error": "Endpoint not found."})
                return
            try:
                length_text = self.headers.get("Content-Length", "")
                if not length_text.isdigit():
                    raise WorkerError("Content-Length must be provided.")
                length = int(length_text)
                if length > MAX_REQUEST_BYTES:
                    raise WorkerError("Request body must be at most 600 KB.")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise WorkerError("Request body was incomplete.")
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise WorkerError("Request body must be valid UTF-8 JSON.") from exc
                texts = validate_request(payload, embedder.identity)
                vectors = embedder.embed(texts)
                self._json(200, {**embedder.identity, "vectors": vectors})
            except WorkerError as exc:
                self._json(400, {"error": str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                return

        def log_message(self, fmt: str, *args: Any) -> None:
            # Avoid logging request bodies, text, and inference details.
            sys.stderr.write("local-embed-worker: " + (fmt % args) + "\n")

    return Handler


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Opt-in local CPU ONNX text embedding worker.")
    parser.add_argument("--model", required=True, help="Path to a local ONNX model file; no download is attempted.")
    parser.add_argument("--tokenizer", required=True, help="Path to a local tokenizers JSON file.")
    parser.add_argument("--model-name", default=DEFAULT_MODEL)
    parser.add_argument("--version", default=DEFAULT_VERSION,
        help="Operator-managed identity; change it whenever model/tokenizer assets or --max-tokens change.")
    parser.add_argument("--dimensions", type=int, default=DEFAULT_DIMENSIONS)
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1"])
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--intra-op-threads", type=int, default=2)
    args = parser.parse_args(argv)
    if not 32 <= args.max_tokens <= 8192:
        parser.error("--max-tokens must be between 32 and 8192")
    if not 1 <= args.intra_op_threads <= 64:
        parser.error("--intra-op-threads must be between 1 and 64")
    if args.dimensions <= 0 or not 1 <= args.port <= 65535:
        parser.error("--dimensions and --port must be positive and port must be at most 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        embedder = Embedder(args)
        embedder.load()
        server = HTTPServer((args.host, args.port), make_handler(embedder))
    except WorkerError as exc:
        print(f"local-embed-worker: {exc}", file=sys.stderr)
        return 2
    print(f"local-embed-worker: ready at http://{args.host}:{args.port} ({args.model_name} {args.version})", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
