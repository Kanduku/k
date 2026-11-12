const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HttpError,
  requireId,
  parsePage,
  parseJson,
  serializeJson,
} = require("../src/http");

test("accepts imported ObjectIds and generated UUIDs", () => {
  assert.equal(requireId("507f1f77bcf86cd799439011"), "507f1f77bcf86cd799439011");
  assert.equal(
    requireId("550e8400-e29b-41d4-a716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000"
  );
});

test("rejects malformed identifiers with a client error", () => {
  assert.throws(
    () => requireId("../../admin"),
    (error) => error instanceof HttpError && error.status === 400
  );
});

test("clamps list pagination", () => {
  assert.deepEqual(parsePage({ page: "-5", limit: "500" }), {
    page: 1,
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(parsePage({ page: "3", limit: "10" }), {
    page: 3,
    limit: 10,
    offset: 20,
  });
});

test("JSON helpers preserve objects and handle malformed JSON explicitly", () => {
  assert.deepEqual(parseJson('{"ready":true}'), { ready: true });
  assert.deepEqual(parseJson("{", { fallback: true }), { fallback: true });
  assert.equal(serializeJson({ ready: true }), '{"ready":true}');
  assert.equal(serializeJson(null), null);
});
