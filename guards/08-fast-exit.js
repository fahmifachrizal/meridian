/**
 * Guard #8 — fast OOR + negative-PnL exit (this is close-side "rule 4" in
 * getDeterministicCloseRule's numbering).
 *
 * Fires during the management/close cycle, inside
 * index.js's getDeterministicCloseRule — not part of the deploy-gate
 * pipeline at all.
 *
 * Don't wait out the full OOR timer if the position is already bleeding
 * meaningfully — SalaryCat-SOL went OOR at 20:09 and didn't close until
 * 20:19 at -35.96% because the full stop-loss/OOR-wait rules are
 * independent lagging brakes. Close immediately once both conditions hold.
 *
 * @param {number} effectiveStopLossPct - position.stop_loss_pct_override
 *   (set by guard #6) falling back to managementConfig.stopLossPct.
 * @returns {{action: "CLOSE", rule: 4, reason: string} | null}
 */
export function checkFastExit(position, effectiveStopLossPct, pnlSuspect, managementConfig) {
  if (
    managementConfig.fastExitOnOorEnabled &&
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.in_range === false &&
    position.pnl_pct <= effectiveStopLossPct * (managementConfig.fastExitStopLossFraction ?? 0.5)
  ) {
    return {
      action: "CLOSE",
      rule: 4,
      reason: `Fast exit: OOR + PnL ${position.pnl_pct}% past ${managementConfig.fastExitStopLossFraction ?? 0.5} of stop-loss`,
    };
  }
  return null;
}
