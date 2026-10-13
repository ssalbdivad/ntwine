import assert from "node:assert/strict"
import test from "node:test"
import { SHEET_CLOSE_MS, prefersReducedMotion, sheetWidth } from "./sheet.ts"

test("sheetWidth steps each stacked layer 28px / 4vw narrower", () => {
  assert.equal(sheetWidth(0), "min(720px, 80vw)")
  assert.equal(sheetWidth(1), "min(692px, 76vw)")
  assert.equal(sheetWidth(2), "min(664px, 72vw)")
  assert.equal(sheetWidth(3), "min(636px, 68vw)")
})

test("sheetWidth with the ThreadDrawer flip offset renders at the width of the layer beneath", () => {
  // The ntwine-doc is a flip surface of the chat drawer for the same thread, not a real extra layer, so
  // it passes offset=1: at widthDepth 0 or 1 it stays the base 720px (matching the chat drawer it flips
  // from / sits beside), and only a genuine extra layer below (widthDepth 2) steps it one notch narrower.
  assert.equal(sheetWidth(0, 1), "min(720px, 80vw)")
  assert.equal(sheetWidth(1, 1), "min(720px, 80vw)")
  assert.equal(sheetWidth(2, 1), "min(692px, 76vw)")
  assert.equal(sheetWidth(3, 1), "min(664px, 72vw)")
})

test("sheetWidth never lets the offset drive the depth negative", () => {
  assert.equal(sheetWidth(0, 5), "min(720px, 80vw)")
})

test("the shared slide-out duration stays 210ms (just past the 200ms transition)", () => {
  assert.equal(SHEET_CLOSE_MS, 210)
})

test("prefersReducedMotion is false without a window (SSR / test env)", () => {
  assert.equal(prefersReducedMotion(), false)
})
