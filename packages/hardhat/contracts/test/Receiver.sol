// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "../DeliverProof.sol";

/// Test-only recipient. Never deployed by a public deployment script.
contract Receiver {
    DeliverProof public immutable target;
    uint256 public id;
    bool public rejectPayment;
    bool public tryReenter;
    bool public reentered;
    constructor(DeliverProof t) { target = t; }
    function configure(uint256 n, bool reject, bool reenter) external {
        id = n; rejectPayment = reject; tryReenter = reenter;
    }
    function submit(string calldata cid, bytes32 sha, uint64 size, uint8 media) external {
        target.submit(id, cid, sha, size, media);
    }
    function withdraw() external { target.withdraw(id); }
    receive() external payable {
        if (rejectPayment) revert();
        if (tryReenter) {
            try target.withdraw(id) { reentered = true; } catch { }
        }
    }
}
