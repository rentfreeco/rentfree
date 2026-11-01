import { describe, expect, test } from "vitest";
import { maskKey } from "./output";

describe("a key as it is typed", () => {
  const key = "rf_7Hq2x9Lm" + "s".repeat(35);

  test("shows its prefix and an asterisk for every character after it", () => {
    expect(maskKey(key)).toBe("rf_7Hq2x9Lm" + "*".repeat(35));
  });

  test("shows what is typed until the prefix is complete", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("r")).toBe("r");
    expect(maskKey("rf_7H")).toBe("rf_7H");
    expect(maskKey("rf_7Hq2x9Lm")).toBe("rf_7Hq2x9Lm");
    expect(maskKey("rf_7Hq2x9LmA")).toBe("rf_7Hq2x9Lm*");
  });

  test("is all asterisks when it does not start like a key", () => {
    expect(maskKey("hunter2")).toBe("*******");
    expect(maskKey(" rf_7Hq2x9Lm")).toBe("************");
  });
});
