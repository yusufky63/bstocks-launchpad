// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IB20Factory, IB20Token } from "./interfaces/IB20Factory.sol";

/// @notice Encodes the exact B20 asset bootstrap used by every StockPair launch: zero admin,
///         18 decimals, fixed supply minted once to the launcher, and a contract URI. When the
///         creator opted into an editable profile, one more call grants METADATA_ROLE to
///         `metadataEditor` (the factory). Nothing else is ever encoded: no admin, no mint,
///         pause, burn, policy or operator role, ever.
library B20Encoding {
    uint8 internal constant PARAMS_VERSION = 1;
    uint8 internal constant DECIMALS = 18;
    /// @dev keccak256("METADATA_ROLE"); matches METADATA_ROLE() on Base mainnet B20 tokens.
    bytes32 internal constant METADATA_ROLE =
        0x6bd6b5318a46e5fff572d5e4258a20774aab40cc35ac7680654b9081fcc82f80;

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

    /// @param metadataEditor address(0) for a permanently frozen profile (byte-identical to
    ///        every earlier launch); otherwise the one account given METADATA_ROLE.
    function bootstrapCalls(
        address recipient,
        uint256 supply,
        string memory contractURI,
        address metadataEditor
    ) internal pure returns (bytes[] memory calls) {
        calls = new bytes[](metadataEditor == address(0) ? 3 : 4);
        calls[0] = abi.encodeCall(IB20Token.updateSupplyCap, (supply));
        calls[1] = abi.encodeCall(IB20Token.mint, (recipient, supply));
        calls[2] = abi.encodeCall(IB20Token.updateContractURI, (contractURI));
        if (metadataEditor != address(0)) {
            calls[3] = abi.encodeCall(IB20Token.grantRole, (METADATA_ROLE, metadataEditor));
        }
    }
}
