import assert from "node:assert/strict";
import test from "node:test";
import { withToolDeadline } from "../src/index.js";

test("NAS-004/NAS-005 deadline aborts work and cannot return late success", async () => {
  let aborted = false;
  let lateSuccess = false;
  const result = await withToolDeadline(
    "slow",
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        setTimeout(() => {
          lateSuccess = true;
          resolve({ content: [{ type: "text", text: "late" }] });
        }, 50);
      }),
    10,
  );
  assert.equal(result.isError, true);
  assert.equal(result._meta?.category, "deadline_exceeded");
  assert.equal(aborted, true);
  assert.doesNotMatch(result.content[0].text, /late/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(lateSuccess, true, "the test proves a late resolution existed but was not returned");
});
