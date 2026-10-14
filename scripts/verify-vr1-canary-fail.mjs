/**
 * VR1 canary — always fails. Used by verify:all --self-test to prove the runner detects FAIL.
 */
import { printVerifySummary } from "./verify-harness.mjs"

console.log("FAIL  canary — deliberate failure for verify:all self-test")
printVerifySummary(false, 0, 1)
process.exitCode = 1
