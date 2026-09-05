import assert from "node:assert/strict";
import { describe, it } from "node:test";

type TpsGrade = "green" | "yellow" | "gold" | "red";

function gradeOf(tps: number): TpsGrade {
  if (tps >= 19.5) return "green";
  if (tps >= 15) return "yellow";
  if (tps >= 10) return "gold";
  return "red";
}

describe("monitor grade", () => {
  it("色阶边界正确", () => {
    assert.equal(gradeOf(20), "green");
    assert.equal(gradeOf(19.5), "green");
    assert.equal(gradeOf(15), "yellow");
    assert.equal(gradeOf(10), "gold");
    assert.equal(gradeOf(9.99), "red");
  });
});
