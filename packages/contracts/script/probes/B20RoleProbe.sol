// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { B20Encoding } from "../../src/B20Encoding.sol";
import { IB20Factory, IB20Token } from "../../src/interfaces/IB20Factory.sol";

/// @notice Run only through `cast call --create` (eth_call, nothing deployed): creates a token with
///         the factory's exact editable bootstrap on the real B20 precompile and returns what the
///         token allows, as one bitmask. Bit set = expectation met, so 0x7fff means all 15 hold.
///         Lives outside src/ so it is never deployed. scripts/probe-b20.sh runs it read-only.
contract B20RoleProbe {
    bytes32 constant MINT_ROLE = keccak256("MINT_ROLE");

    constructor() {
        IB20Factory f = IB20Factory(0xB20f000000000000000000000000000000000000);
        address token = f.createB20(
            IB20Factory.B20Variant.ASSET,
            keccak256(abi.encode(address(this), block.number)),
            B20Encoding.assetParams("Probe Token", "PROBE"),
            B20Encoding.bootstrapCalls(address(this), 1_000_000_000e18, "ipfs://one", address(this))
        );
        IB20Token t = IB20Token(token);
        uint256 bits;
        if (t.balanceOf(address(this)) == 1_000_000_000e18) bits |= 1 << 0;
        if (t.hasRole(B20Encoding.METADATA_ROLE, address(this))) bits |= 1 << 1;
        if (!t.hasRole(bytes32(0), address(this))) bits |= 1 << 2;
        if (!t.hasRole(MINT_ROLE, address(this))) bits |= 1 << 3;
        try t.updateContractURI("ipfs://two") {
            if (keccak256(bytes(t.contractURI())) == keccak256("ipfs://two")) bits |= 1 << 4;
        } catch { }
        try t.grantRole(B20Encoding.METADATA_ROLE, address(0xdead)) { } catch { bits |= 1 << 5; }
        try t.mint(address(this), 1) { } catch { bits |= 1 << 6; }
        try t.updateSupplyCap(2_000_000_000e18) { } catch { bits |= 1 << 7; }
        try t.grantRole(bytes32(0), address(this)) { } catch { bits |= 1 << 8; }
        if (keccak256(bytes(t.name())) == keccak256("Probe Token")) bits |= 1 << 9;
        t.renounceRole(B20Encoding.METADATA_ROLE, address(this));
        if (!t.hasRole(B20Encoding.METADATA_ROLE, address(this))) bits |= 1 << 10;
        try t.updateContractURI("ipfs://three") { } catch { bits |= 1 << 11; }
        try t.grantRole(B20Encoding.METADATA_ROLE, address(this)) { } catch { bits |= 1 << 12; }
        // An immutable launch's bootstrap on the same precompile: no metadata role at all.
        address frozen = f.createB20(
            IB20Factory.B20Variant.ASSET,
            keccak256(abi.encode(address(this), block.number, 1)),
            B20Encoding.assetParams("Probe Frozen", "PFROZ"),
            B20Encoding.bootstrapCalls(address(this), 1_000_000_000e18, "ipfs://one", address(0))
        );
        if (!IB20Token(frozen).hasRole(B20Encoding.METADATA_ROLE, address(this))) bits |= 1 << 13;
        try IB20Token(frozen).updateContractURI("ipfs://x") { } catch { bits |= 1 << 14; }
        assembly {
            mstore(0, bits)
            return(0, 32)
        }
    }
}
