// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { B20RoleProbe } from "../script/probes/B20RoleProbe.sol";
import { PredictProbe } from "../script/probes/PredictProbe.sol";
import { MockB20Factory } from "./mocks/MockB20.sol";
import { Fixture } from "./Fixture.sol";

/// The read-only probes scripts/probe-b20.sh runs against Base, run here against the mock. Base
/// mainnet answered 0x7fff and three equal addresses; the mock must answer the same, or the
/// metadata tests would be proving rules the precompile does not enforce.
contract ProbesTest is Fixture {
    function _roleProbe() internal returns (uint256) {
        return uint256(bytes32(address(new B20RoleProbe()).code));
    }

    function test_RoleProbeAnswersLikeMainnet() public {
        assertEq(_roleProbe(), 0x7fff);
    }

    /// Positive controls: a precompile that dropped the grant, or granted the role unasked, is
    /// caught by the probe, so 0x7fff on a live network means something.
    function test_RoleProbeCatchesAMisbehavingPrecompile() public {
        uint256 snap = vm.snapshotState();
        MockB20Factory(B20_FACTORY).setIgnoreRoleGrants(true);
        uint256 dropped = _roleProbe();
        assertEq(dropped & (1 << 1), 0, "no role seen");
        assertEq(dropped & (1 << 4), 0, "no edit possible");
        vm.revertToState(snap);
        MockB20Factory(B20_FACTORY).setGrantUnasked(true);
        uint256 unasked = _roleProbe();
        assertEq(unasked & (1 << 13), 0, "frozen token holds the role");
        assertEq(unasked & (1 << 14), 0, "frozen token is editable");
    }

    function test_PredictProbeAnswersLikeMainnet() public {
        (address predicted, address created, address predictedAfter) =
            abi.decode(address(new PredictProbe()).code, (address, address, address));
        assertTrue(created != address(0));
        assertEq(predicted, created, "prediction before the create");
        assertEq(predictedAfter, created, "prediction after the create");
    }
}
