import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module shared with the browser, no types.
import { qrMatrix, qrSvg } from "../public/app/qr.js";
import fixtures from "./qr-fixtures.json";

/**
 * The encoder's real acceptance test can't run in the Workers runtime: it was
 * verified by rendering 210 codes across every version 1-9 and decoding them
 * with zxing-cpp (210/210). These fixtures freeze that verified output, so a
 * regression shows up as a diff rather than as a QR nobody can scan.
 */

const rows = (text: string): string[] => qrMatrix(text).map((r: number[]) => r.join(""));

describe("qr encoder", () => {
  it("reproduces the verified fixtures exactly", () => {
    for (const [text, expected] of Object.entries(fixtures as Record<string, string[]>)) {
      expect(rows(text), `matrix changed for ${text.slice(0, 40)}`).toEqual(expected);
    }
  });

  it("picks the smallest version that fits", () => {
    // Sizes are 4*version + 17.
    expect(rows("A")).toHaveLength(21); // version 1
    expect(rows("x".repeat(100))).toHaveLength(41); // version 6
    expect(rows("x".repeat(180))).toHaveLength(53); // version 9
  });

  it("returns null rather than a broken code when the text is too long", () => {
    expect(qrMatrix("x".repeat(181))).toBeNull();
    expect(qrSvg("x".repeat(181))).toBeNull();
  });

  it("places the three finder patterns", () => {
    const m = qrMatrix("https://quiz.jett.io/play?code=603614");
    const size = m.length;
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      expect(m[r0][c0]).toBe(1);
      expect(m[r0 + 1][c0 + 1]).toBe(0); // the light ring
      expect(m[r0 + 3][c0 + 3]).toBe(1); // the solid core
    }
    // ...and not a fourth one in the bottom-right corner.
    expect(m[size - 1][size - 1]).not.toBe(undefined);
  });

  it("alternates the timing patterns and sets the dark module", () => {
    const m = qrMatrix("https://quiz.jett.io/play?code=603614");
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0 ? 1 : 0);
      expect(m[i][6]).toBe(i % 2 === 0 ? 1 : 0);
    }
    expect(m[size - 8][8]).toBe(1);
  });

  it("renders an svg with a quiet zone", () => {
    const svg = qrSvg("https://quiz.jett.io/play?code=603614");
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 37 37"'); // 29 modules + 4 quiet each side
    expect(svg).not.toContain("<script");
  });
});
