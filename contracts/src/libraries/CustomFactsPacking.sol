// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LittleEndian} from "./LittleEndian.sol";

/// @notice Input packing for custom rule circuits ("facts v1", docs/RULE_BUILDER_RESEARCH.md).
/// @dev Pins (nIn = 256, nOut = 1), bit-packed LSB-first per byte (bit i = (byte[i >> 3] >> (i & 7)) & 1):
///        bits   0..31   amount_c             payment amount in cents, rounded up
///        bits  32..63   spent_day_after_c    UTC-day total including this payment, cents, rounded up, saturating
///        bits  64..95   spent_7d_after_c     rolling 7 UTC days including this payment, cents, saturating
///        bits  96..127  spent_month_after_c  calendar UTC month including this payment, cents, saturating
///        bits 128..159  balance_after_c      escrow balance after this payment, cents, rounded down, saturating
///        bits 160..167  count_day_after      allowed transfers today including this one, saturating at 255
///        bits 168..177  slot_of_week_utc     15-minute slot since Monday 00:00 UTC, 0..671
///        bit  178       payee_trusted        recipient is a saved payee
///        bit  179       payee_known          recipient has a payee entry
///        bit  180       payee_paid_before    recipient has received an allowed transfer while its entry existed
///        bits 181..196  payee_age_hours      hours since the recipient was added, saturating at 65535
///        bits 197..212  checkin_age_hours    hours since the controller's last check-in, saturating at 65535
///        bits 213..214  caller_role          0 controller, 1 agent, 2 beneficiary
///        bit  215       confirmed            the controller confirmed this exact payment
///        bit  216       is_withdrawal        the call is `withdraw` (owner withdrawal), not `proposePayment`
///        bits 217..255  reserved             always 0
///      The input count (256) is the facts version: any future layout must use a different nIn so an old circuit
///      can never receive new meanings. The amount is rejected (not truncated) when it does not fit; every other
///      value saturates. Saturation is only on the safe side for "<= K" tests with K below the maximum and ">= K"
///      tests with K at or below it; the rule compiler (circuits/custom) refuses any other comparison.
///      Must stay identical to circuits/custom/facts.mjs `packFacts`.
library CustomFactsPacking {
    uint32 internal constant N_IN = 256;
    uint32 internal constant N_OUT = 1;
    uint32 internal constant FACTS_VERSION = 1;
    uint256 internal constant INPUT_BYTES = 32;

    struct Facts {
        uint256 amountC;
        uint256 spentDayAfterC;
        uint256 spent7dAfterC;
        uint256 spentMonthAfterC;
        uint256 balanceAfterC;
        uint256 countDayAfter;
        uint256 slotOfWeek;
        bool payeeTrusted;
        bool payeeKnown;
        bool payeePaidBefore;
        uint256 payeeAgeHours;
        uint256 checkinAgeHours;
        uint256 callerRole;
        bool confirmed;
        bool isWithdrawal;
    }

    function pack(Facts memory f) internal pure returns (bool ok, bytes memory input) {
        if (f.amountC > type(uint32).max) return (false, "");
        uint256 w = f.amountC;
        w |= _sat(f.spentDayAfterC, 32) << 32;
        w |= _sat(f.spent7dAfterC, 32) << 64;
        w |= _sat(f.spentMonthAfterC, 32) << 96;
        w |= _sat(f.balanceAfterC, 32) << 128;
        w |= _sat(f.countDayAfter, 8) << 160;
        if (f.slotOfWeek > 671 || f.callerRole > 3) return (false, "");
        w |= f.slotOfWeek << 168;
        w |= _bit(f.payeeTrusted) << 178;
        w |= _bit(f.payeeKnown) << 179;
        w |= _bit(f.payeePaidBefore) << 180;
        w |= _sat(f.payeeAgeHours, 16) << 181;
        w |= _sat(f.checkinAgeHours, 16) << 197;
        w |= f.callerRole << 213;
        w |= _bit(f.confirmed) << 215;
        w |= _bit(f.isWithdrawal) << 216;
        return (true, LittleEndian.toBytes(w, INPUT_BYTES));
    }

    function _sat(uint256 v, uint256 width) private pure returns (uint256) {
        uint256 max = (uint256(1) << width) - 1;
        return v > max ? max : v;
    }

    function _bit(bool b) private pure returns (uint256) {
        return b ? 1 : 0;
    }
}
