# CircuitWill – Risk & Edge-Case Matrix

**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026

| Risk / Edge Case | Impact | Likelihood | Mitigation | Owner |
|------------------|--------|------------|------------|-------|
| Memory result influences or overrides a circuit decision | Critical – breaks core promise | Low (if architecture followed) | Hard separation: memory never passed as circuit input. UI always states “circuits decide”. Code review checklist. | Contract + Frontend |
| Circuit evaluation fails or reverts unexpectedly | High – payments stuck or wrongly blocked | Medium | Fail closed: any evaluation error blocks payment. Record the blocked decision and inputs without reverting so the event persists. Emit a clear error/result and test edge inputs. | Contract |
| Input packing mismatch between escrow and circuit | High – wrong allow/block | Medium | Shared constants / library for packing. Automated tests that pack in contract and unpack in circuit test. | Contract + Circuit |
| Daily cap overflow or precision issues | Medium | Low | Use checked math or saturating add. Test max values. Document unit scaling. | Circuit |
| Payee age calculation wrong (timestamp issues) | Medium | Medium | Escrow calculates age and passes clean integer. Test with block timestamps. | Contract |
| Confirmation bit can be reused or forged | High | Low | Current NFT owner confirms a hash bound to recipient, amount, nonce, and chain/escrow domain. Enforce one-time use and short expiry; consume after use. | Contract |
| Freeze flag not respected | Critical | Low | Simplest circuit. Test independently. | Circuit |
| Circuit NFT transfer does not move control | High | Medium | Escrow stores the NFT contract and token ID but does not custody the NFT. Check `ownerOf(tokenId) == msg.sender` on management and withdrawal calls so control follows wallet transfers immediately. | Contract |
| Circuit NFT is burned or stops reporting an owner | Critical | Low | Require a non-burnable NFT or prevent burning while the escrow has funds; otherwise owner checks can fail and strand funds. | Contract + NFT |
| Owner withdrawal bypasses circuit rules | Critical | Medium | Route every outbound transfer, including withdrawals, through the same circuit evaluation path. A denied withdrawal records the decision and moves no funds. | Contract |
| User confuses suggestion with decision | Medium | High | Strong UI language and visual separation. “Suggestion” badge vs “Circuit Decision” badge. | Frontend |
| Walrus Memory down or key issues | Low | Medium | Feature is optional and default off. Flow continues normally if call fails. | Agent / Frontend |
| Gas limits on multi-circuit evaluation | Medium | Medium | Limit to 4 circuits. Measure gas. Optimise packing. | Contract |
| Front-running or proposal manipulation | Medium | Low | Decisions based only on on-chain state at execution time. No off-chain trust. | Contract |
| Parameter update after proposal but before execution | Medium | Low | Parameters read at execution time, or snapshot parameters with proposal. Document behaviour. | Contract |
| Empty or zero-amount payments | Low | Medium | Explicit reject of amount == 0. | Contract |
| Re-evaluation data incomplete | Medium | Low | Both allowed and blocked decisions must persist with all inputs and circuit results. Blocked proposals return without reverting; a revert would erase their event. Document re-evaluation steps in README. | Contract |
| Daily spending reset or accounting is wrong | High | Medium | Escrow computes the UTC day as `uint32(block.timestamp / 86400)`, resets at 00:00 UTC when it changes, and increments only after an allowed outbound transfer. | Contract |
| Packed values exceed pinout widths | High | Medium | Reject out-of-range amounts and parameters before packing; never truncate. Check arithmetic overflow explicitly. | Contract + Circuit |

## Critical non-negotiables

1. Circuits are the only authority.
2. Fail closed on any uncertainty.
3. All decisions must be publicly re-evaluable from on-chain data.
4. Walrus Memory is strictly advisory and optional.

**End of risk matrix**
