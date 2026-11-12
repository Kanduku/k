const test = require("node:test");
const assert = require("node:assert/strict");
const { programs, programById, durations } = require("../src/training-catalog");

test("training catalog retains the source program list and durations", () => {
  assert.equal(programs.length, 30);
  assert.deepEqual(durations, ["1 month", "3 months", "6 months"]);
  assert.equal(programById.get("python-full-stack-development").title, "Python Full Stack Development");
  assert.equal(programById.get("digital-marketing-seo").category, "Non-IT");
});
