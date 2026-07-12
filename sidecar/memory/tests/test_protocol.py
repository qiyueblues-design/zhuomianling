import json
import unittest

from desktop_pet_memory_sidecar.protocol import ProtocolError, encode_response, parse_request


class ProtocolTests(unittest.TestCase):
    def test_parses_bounded_request(self):
        request = parse_request(
            json.dumps(
                {
                    "id": "rpc-1",
                    "method": "sleep",
                    "petId": "pet-a",
                    "deadlineMs": 1200,
                    "params": {"delayMs": 1},
                }
            ).encode()
        )
        self.assertEqual(request.pet_id, "pet-a")

    def test_rejects_unknown_fields_and_invalid_pet(self):
        for value in (
            {"id": "x", "method": "health", "deadlineMs": 1, "params": {}, "extra": True},
            {"id": "x", "method": "sleep", "petId": "../pet", "deadlineMs": 1, "params": {}},
        ):
            with self.assertRaises(ProtocolError):
                parse_request(json.dumps(value).encode())

    def test_bounds_depth_arrays_and_output(self):
        nested = {}
        current = nested
        for _ in range(20):
            current["next"] = {}
            current = current["next"]
        with self.assertRaises(ProtocolError):
            parse_request(
                json.dumps(
                    {"id": "x", "method": "health", "deadlineMs": 1, "params": nested}
                ).encode()
            )
        response = encode_response("x", result={"value": "x" * 40_000})
        self.assertIn(b'"code":"output-budget"', response)


if __name__ == "__main__":
    unittest.main()
