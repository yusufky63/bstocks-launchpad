// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IB20Factory, IB20Token } from "./interfaces/IB20Factory.sol";

/// @notice Encodes the exact B20 asset bootstrap used by every StockPair launch:
///         zero admin, 18 decimals, fixed supply minted once to the launcher, immutable
///         contract URI. Nothing else is ever encoded.
library B20Encoding {
    uint8 internal constant PARAMS_VERSION = 1;
    uint8 internal constant DECIMALS = 18;

    function assetParams(string memory name, string memory symbol)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            IB20Factory.B20AssetCreateParams({
                version: PARAMS_VERSION,
                name: name,
                symbol: symbol,
                initialAdmin: address(0),
                decimals: DECIMALS
            })
        );
    }

    function bootstrapCalls(address recipient, uint256 supply, string memory contractURI)
        internal
        pure
        returns (bytes[] memory calls)
    {
        calls = new bytes[](3);
        calls[0] = abi.encodeCall(IB20Token.updateSupplyCap, (supply));
        calls[1] = abi.encodeCall(IB20Token.mint, (recipient, supply));
        calls[2] = abi.encodeCall(IB20Token.updateContractURI, (contractURI));
    }
}
