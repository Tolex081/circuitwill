// Enum values of CircuitWillEscrow (README "Event and re-evaluation format"). They are part of the event format.

export const KIND = { NONE: 0, DAILY_CAP: 1, WHITELIST: 2, CONFIRMATION: 3, FREEZE: 4, CUSTOM: 5 };
export const KIND_NAME = ['NONE', 'DAILY_CAP', 'WHITELIST', 'CONFIRMATION', 'FREEZE', 'CUSTOM'];
export const KIND_LABEL = ['None', 'Daily Cap', 'Payee Whitelist + Cooling-off', 'Confirmation Threshold', 'Freeze', 'Custom rule'];

/// CircuitWillEscrow.ChangeKind: what queueChange can loosen after the delay.
export const CHANGE = {
  DAILY_CAP: 0,
  TRIAL_LIMIT: 1,
  COOLING_OFF_HOURS: 2,
  CONFIRMATION_THRESHOLD: 3,
  SAVE_PAYEE: 4,
  UNFREEZE: 5,
  DETACH_CIRCUIT: 6,
  RULE_DELAY: 7,
  BENEFICIARY: 8,
};
export const CHANGE_NAME = Object.keys(CHANGE);

/// caller_role in the custom-rule facts (CircuitWillEscrow.roleOf).
export const ROLE_NAME = ['Owner', 'Agent', 'Beneficiary', 'Nobody'];

export const STATUS = { NOT_EVALUATED: 0, ALLOW: 1, DENY: 2, REVERTED: 3, MALFORMED_OUTPUT: 4 };
export const STATUS_NAME = ['NOT_EVALUATED', 'ALLOW', 'DENY', 'REVERTED', 'MALFORMED_OUTPUT'];

export const ACTION_NAME = ['Payment', 'Withdrawal'];

export const REASON = {
  NONE: 0,
  CIRCUIT_DENIED: 1,
  EVAL_FAILED: 2,
  INPUT_OUT_OF_RANGE: 3,
  NO_CIRCUITS: 4,
  INSUFFICIENT_BALANCE: 5,
  TRANSFER_FAILED: 6,
  NO_CUSTOM_RULE: 7,
};
export const REASON_NAME = [
  'NONE',
  'CIRCUIT_DENIED',
  'EVAL_FAILED',
  'INPUT_OUT_OF_RANGE',
  'NO_CIRCUITS',
  'INSUFFICIENT_BALANCE',
  'TRANSFER_FAILED',
  'NO_CUSTOM_RULE',
];
export const REASON_TEXT = [
  'All circuits allowed it',
  'A circuit returned 0',
  'A circuit reverted, ran out of its gas budget or returned malformed output',
  'A value did not fit its pin width, so no circuit input could be built',
  'No circuits attached: nothing can authorize a transfer',
  'Circuits allowed it, but the escrow does not hold enough tokens',
  'Circuits allowed it, but the token transfer failed',
  'The beneficiary can only spend under a custom rule, and none is attached',
];

/// Same priority as CircuitWillEscrow._worse: INPUT_OUT_OF_RANGE > EVAL_FAILED > CIRCUIT_DENIED.
export function reasonFromStatuses(statuses) {
  if (statuses.length === 0) return REASON.NO_CIRCUITS;
  let r = REASON.NONE;
  for (const s of statuses) {
    if (s === STATUS.ALLOW) continue;
    const next =
      s === STATUS.DENY ? REASON.CIRCUIT_DENIED : s === STATUS.NOT_EVALUATED ? REASON.INPUT_OUT_OF_RANGE : REASON.EVAL_FAILED;
    if (r === REASON.NONE) r = next;
    else if (r === REASON.INPUT_OUT_OF_RANGE || next === REASON.INPUT_OUT_OF_RANGE) r = REASON.INPUT_OUT_OF_RANGE;
    else if (r === REASON.EVAL_FAILED || next === REASON.EVAL_FAILED) r = REASON.EVAL_FAILED;
    else r = REASON.CIRCUIT_DENIED;
  }
  return r;
}
