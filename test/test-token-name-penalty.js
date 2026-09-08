/**
 * Offline unit tests for guard #9 — token-name pattern size penalty.
 * Pure function, no I/O, no state file involved.
 * Run: node test/test-token-name-penalty.js
 */

import { createSuite } from "./lib/test-kit.js";
import { computeTokenNamePenalty } from "../guards/09-token-name-penalty.js";

const suite = createSuite("Guard #9: token-name pattern size penalty");
const { section, check } = suite;

function cfg(overrides = {}) {
  return {
    management: {
      tokenNamePenaltiesEnabled: true,
      tokenNamePenalties: [{ pattern: "cat", penaltyPct: 50 }],
      ...overrides,
    },
  };
}

section("disabled — always passes through unchanged");
{
  const r = computeTokenNamePenalty("CRIMECAT-SOL", 0.7, cfg({ tokenNamePenaltiesEnabled: false }));
  check("not penalized when disabled", r.penalized === false);
  check("amountY unchanged when disabled", r.amountY === 0.7);
}

section("no token name — fails open");
{
  const r = computeTokenNamePenalty(null, 0.7, cfg());
  check("not penalized with no name", r.penalized === false);
  check("amountY unchanged with no name", r.amountY === 0.7);
}

section("matching pattern — cuts size by penaltyPct, case-insensitive");
{
  const r1 = computeTokenNamePenalty("CRIMECAT-SOL", 0.7, cfg());
  check("penalized on match", r1.penalized === true);
  check("50% cut halves the amount", r1.amountY === 0.35);
  check("matchedPattern reported", r1.matchedPattern === "cat");
  check("penaltyPct reported", r1.penaltyPct === 50);

  const r2 = computeTokenNamePenalty("bullCAT-SOL", 0.7, cfg());
  check("case-insensitive match", r2.penalized === true && r2.amountY === 0.35);
}

section("non-matching pattern — passes through unchanged");
{
  const r = computeTokenNamePenalty("Waddles-SOL", 0.7, cfg());
  check("not penalized when name doesn't match", r.penalized === false);
  check("amountY unchanged when no match", r.amountY === 0.7);
}

section("floor — never cuts below 0.1 SOL even at a 100% penalty");
{
  const r = computeTokenNamePenalty("CRIMECAT-SOL", 0.15, cfg({
    tokenNamePenaltiesEnabled: true,
    tokenNamePenalties: [{ pattern: "cat", penaltyPct: 100 }],
  }));
  check("floored at 0.1 SOL, never zero", r.amountY === 0.1);
}

section("multiple rules — first match wins, not combined");
{
  const r = computeTokenNamePenalty("CRIMECAT-SOL", 1.0, cfg({
    tokenNamePenaltiesEnabled: true,
    tokenNamePenalties: [
      { pattern: "cat", penaltyPct: 50 },
      { pattern: "crime", penaltyPct: 90 },
    ],
  }));
  check("first matching rule applies (50%, not 90%)", r.amountY === 0.5);
}

section("invalid penaltyPct — fails open");
{
  const r0 = computeTokenNamePenalty("CRIMECAT-SOL", 0.7, cfg({
    tokenNamePenaltiesEnabled: true,
    tokenNamePenalties: [{ pattern: "cat", penaltyPct: 0 }],
  }));
  check("penaltyPct=0 is a no-op", r0.penalized === false && r0.amountY === 0.7);

  const rNeg = computeTokenNamePenalty("CRIMECAT-SOL", 0.7, cfg({
    tokenNamePenaltiesEnabled: true,
    tokenNamePenalties: [{ pattern: "cat", penaltyPct: -10 }],
  }));
  check("negative penaltyPct is a no-op", rNeg.penalized === false);

  const rNaN = computeTokenNamePenalty("CRIMECAT-SOL", 0.7, cfg({
    tokenNamePenaltiesEnabled: true,
    tokenNamePenalties: [{ pattern: "cat", penaltyPct: "not-a-number" }],
  }));
  check("non-numeric penaltyPct is a no-op", rNaN.penalized === false);
}

section("empty/missing rules list — fails open");
{
  const r = computeTokenNamePenalty("CRIMECAT-SOL", 0.7, cfg({ tokenNamePenaltiesEnabled: true, tokenNamePenalties: [] }));
  check("no rules configured — not penalized", r.penalized === false);
}

process.exit(suite.finish());
