// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { B20Encoding } from "../../src/B20Encoding.sol";
import { IB20Factory } from "../../src/interfaces/IB20Factory.sol";

/// @notice Run only through `cast call --create` (eth_call, nothing deployed). Returns three words:
///         getB20Address before the create, the address createB20 returned, and getB20Address
///         after. All three must be equal: the precompile's address depends on the variant, the
///         sender and the salt only, never the name or symbol, which is what makes
///         StockPairFactory.predictToken (and the web's quote, which orders token and stock by
///         that address) exact. Lives outside src/ so it is never deployed.
contract PredictProbe {
    constructor() {
        IB20Factory f = IB20Factory(0xB20f000000000000000000000000000000000000);
        bytes32 salt = keccak256(abi.encode(address(0xC0FFEE), bytes32(uint256(7))));
        address predicted = f.getB20Address(IB20Factory.B20Variant.ASSET, address(this), salt);
        address created = f.createB20(
            IB20Factory.B20Variant.ASSET,
            salt,
            B20Encoding.assetParams("Some Name", "SNM"),
            B20Encoding.bootstrapCalls(address(this), 1_000_000_000e18, "", address(0))
        );
        address predictedAfter = f.getB20Address(IB20Factory.B20Variant.ASSET, address(this), salt);
        assembly {
            mstore(0, predicted)
            mstore(32, created)
            mstore(64, predictedAfter)
            return(0, 96)
        }
    }
}
