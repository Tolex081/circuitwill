// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Rolling 7-day spend ring and UTC calendar helpers for the custom-rule facts.
/// @dev The ring is one storage word: seven uint32 day buckets (cents, saturating) in bits 0..223, bucket for UTC
///      day `d` at index `d % 7`, and the UTC day number the ring was last advanced to in bits 224..255.
///      Every value is a saturating uint32, so a full bucket can only make a "spent <= K" test fail (safe side).
library SpendWindows {
    uint256 internal constant U32 = type(uint32).max;

    function ringDay(uint256 ring) internal pure returns (uint32) {
        return uint32(ring >> 224);
    }

    function bucket(uint256 ring, uint256 i) internal pure returns (uint256) {
        return (ring >> (32 * i)) & U32;
    }

    /// @dev Moves the ring forward to `day`, zeroing the buckets of every day that has fallen out of the window.
    ///      A ring that has never been used (all zero) or is 7+ days old is simply reset.
    function advance(uint256 ring, uint32 day) internal pure returns (uint256) {
        uint32 last = ringDay(ring);
        if (day <= last) return ring; // same day (time never goes backwards on chain)
        if (day - last >= 7) return uint256(day) << 224;
        for (uint32 d = last + 1; d <= day; ++d) {
            uint256 i = d % 7;
            ring &= ~(U32 << (32 * i));
        }
        return (ring & ((uint256(1) << 224) - 1)) | (uint256(day) << 224);
    }

    /// @dev Sum of the seven buckets, saturating at uint32 max.
    function sum(uint256 ring) internal pure returns (uint256 s) {
        for (uint256 i; i < 7; ++i) {
            s += bucket(ring, i);
        }
        if (s > U32) s = U32;
    }

    /// @dev Adds `cents` to today's bucket. The ring must already be advanced to `day`.
    function add(uint256 ring, uint32 day, uint256 cents) internal pure returns (uint256) {
        uint256 i = day % 7;
        uint256 b = bucket(ring, i) + cents;
        if (b > U32) b = U32;
        return (ring & ~(U32 << (32 * i))) | (b << (32 * i));
    }

    /// @dev Calendar month key `year * 12 + (month - 1)` for a UTC day number (days since 1970-01-01).
    ///      Civil-from-days algorithm (H. Hinnant), valid for every non-negative day number.
    function monthKey(uint256 day) internal pure returns (uint32) {
        uint256 z = day + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        // Bounded by the day number; cannot truncate for any realistic timestamp.
        return uint32(y * 12 + m - 1);
    }

    /// @dev 15-minute slot since Monday 00:00 UTC, 0..671. 1970-01-01 (day 0) was a Thursday.
    function slotOfWeek(uint256 timestamp) internal pure returns (uint256) {
        uint256 day = timestamp / 86_400;
        return ((day + 3) % 7) * 96 + (timestamp % 86_400) / 900;
    }
}
