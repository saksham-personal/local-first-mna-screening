import json
from http.server import HTTPServer
from threading import Thread
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np

from scripts.local_embed_worker import (
    DEFAULT_DIMENSIONS,
    DEFAULT_MODEL,
    DEFAULT_VERSION,
    Embedder,
    WorkerError,
    make_handler,
    normalize_outputs,
    parse_args,
    validate_request,
)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.identity = {"model": DEFAULT_MODEL, "version": DEFAULT_VERSION, "dimensions": DEFAULT_DIMENSIONS}

    def test_validates_identity_text_count_and_utf8_size(self):
        self.assertEqual(validate_request({**self.identity, "texts": [" hello "]}, self.identity), [" hello "])
        for bad in (
            {**self.identity, "texts": []},
            {**self.identity, "texts": ["  "]},
            {**self.identity, "version": "wrong", "texts": ["x"]},
            {**self.identity, "texts": ["x" * 16_001]},
        ):
            with self.assertRaises(WorkerError):
                validate_request(bad, self.identity)

    def test_cls_pooling_and_pooled_output_are_l2_normalized(self):
        token_vectors = np.asarray([
            [[3.0, 4.0], [90.0, 90.0]],
            [[0.0, 2.0], [90.0, 90.0]],
        ])
        pooled = normalize_outputs(token_vectors, 2, 2, np)
        self.assertEqual(pooled, [[0.6, 0.8], [0.0, 1.0]])
        self.assertEqual(normalize_outputs(np.asarray([[3.0, 4.0]]), 1, 2, np), [[0.6, 0.8]])

    def test_bad_shapes_nonfinite_and_zero_vectors_fail(self):
        for output, batch, dimensions in (
            (np.ones((1, 2, 3)), 1, 2),
            (np.asarray([[float("nan"), 1.0]]), 1, 2),
            (np.zeros((1, 2)), 1, 2),
        ):
            with self.assertRaises(WorkerError):
                normalize_outputs(output, batch, dimensions, np)

    def test_no_assets_are_required_to_be_downloaded_and_missing_paths_fail_clearly(self):
        with self.assertRaises(SystemExit):
            parse_args([])
        args = SimpleNamespace(model="missing.onnx", tokenizer="missing.json", model_name=DEFAULT_MODEL,
            version=DEFAULT_VERSION, dimensions=DEFAULT_DIMENSIONS, max_tokens=512, intra_op_threads=2)
        with self.assertRaisesRegex(WorkerError, "ONNX model file not found"):
            Embedder(args).load()

    def test_http_identity_validation_health_and_embeddings_contract(self):
        class Stub:
            identity = self.identity
            args = SimpleNamespace(max_tokens=512, intra_op_threads=2)
            hashes = {"model_sha256": "m", "tokenizer_sha256": "t"}
            session = object()

            def embed(self, texts):
                return [[1.0] * DEFAULT_DIMENSIONS for _ in texts]

        server = HTTPServer(("127.0.0.1", 0), make_handler(Stub()))
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        root = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(root + "/health") as response:
                health = json.load(response)
            self.assertEqual(health["status"], "ready")
            self.assertNotIn("embeddings", health)
            body = json.dumps({**self.identity, "texts": ["hello"]}).encode()
            request = Request(root + "/embed", body, {"Content-Type": "application/json"}, method="POST")
            with urlopen(request) as response:
                result = json.load(response)
            self.assertEqual(len(result["vectors"]), 1)
            self.assertEqual(len(result["vectors"][0]), DEFAULT_DIMENSIONS)
            invalid = json.dumps({**self.identity, "model": "other", "texts": ["hello"]}).encode()
            request = Request(root + "/embed", invalid, {"Content-Type": "application/json"}, method="POST")
            with self.assertRaises(HTTPError) as caught:
                urlopen(request)
            self.assertEqual(caught.exception.code, 400)
            self.assertIn("identity", json.loads(caught.exception.read())["error"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


    def test_sub_batches_keep_request_order(self):
        embedder = Embedder(SimpleNamespace(model_name=DEFAULT_MODEL, version=DEFAULT_VERSION, dimensions=1))
        embedder.session = embedder.tokenizer = embedder.np = object()
        seen = []
        def fake_batch(texts):
            seen.append(texts)
            return [[float(len(text))] for text in texts]
        embedder._embed_batch = fake_batch
        texts = ["x" * n for n in (40, 3, 17, 1, 25, 9, 33, 2, 11, 5)]
        self.assertEqual(embedder.embed(texts), [[float(len(t))] for t in texts])
        self.assertEqual([len(batch) for batch in seen], [8, 2])
        self.assertEqual(seen[0], sorted(texts, key=len)[:8])

if __name__ == "__main__":
    unittest.main()
