// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Base-native B20 factory surface (Beryl upgrade, base/base-std).
/// @dev These are Rust precompiles at fixed addresses, not EVM contracts. The interface is
///      pinned to the reviewed base-std ABI; only the calls the launcher needs are declared.
interface IB20Factory {
    enum B20Variant {
        ASSET,
        STABLECOIN
    }

    struct B20AssetCreateParams {
        uint8 version;
        string name;
        string symbol;
        address initialAdmin;
        uint8 decimals;
    }

    function createB20(
        B20Variant variant,
        bytes32 salt,
        bytes calldata params,
        bytes[] calldata initCalls
    ) external payable returns (address token);

    function getB20Address(B20Variant variant, address sender, bytes32 salt)
        external
        view
        returns (address);

    function isB20(address token) external view returns (bool);
    function isB20Initialized(address token) external view returns (bool);
}

/// @notice The B20 token calls used during bootstrap and by the launcher.
interface IB20Token {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function mint(address to, uint256 amount) external;
    function supplyCap() external view returns (uint256);
    function updateSupplyCap(uint256 newSupplyCap) external;
    function contractURI() external view returns (string memory);
    function updateContractURI(string calldata newURI) external;
    function hasRole(bytes32 role, address account) external view returns (bool); // 0x91d14854
    /// @dev Only ever encoded as a bootstrap init call; never called on a live token.
    function grantRole(bytes32 role, address account) external; // 0x2f2ff15d
    function renounceRole(bytes32 role, address callerConfirmation) external; // 0x36568abe
}
