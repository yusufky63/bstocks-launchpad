// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { IB20Factory } from "../../src/interfaces/IB20Factory.sol";

/// @notice EVM stand-in for a B20 asset token. Base's real B20 tokens are Rust precompiles that
///         local forks cannot execute, so tests etch this factory at the canonical address.
///         It honours the exact bootstrap sequence the launcher uses: supply cap, one mint,
///         contract URI, and then no admin at all.
contract MockB20Token is ERC20 {
    address public immutable bootstrapper;
    bool public bootstrapped;
    uint256 public supplyCap = type(uint128).max;
    string private _contractURI;

    error NotBootstrapping();
    error SupplyCapExceeded();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        bootstrapper = msg.sender;
    }

    modifier onlyBootstrap() {
        if (msg.sender != bootstrapper || bootstrapped) revert NotBootstrapping();
        _;
    }

    function finishBootstrap() external onlyBootstrap {
        bootstrapped = true;
    }

    function updateSupplyCap(uint256 newSupplyCap) external onlyBootstrap {
        supplyCap = newSupplyCap;
    }

    function mint(address to, uint256 amount) external onlyBootstrap {
        if (totalSupply() + amount > supplyCap) revert SupplyCapExceeded();
        _mint(to, amount);
    }

    function updateContractURI(string calldata newURI) external onlyBootstrap {
        _contractURI = newURI;
    }

    function contractURI() external view returns (string memory) {
        return _contractURI;
    }
}

contract MockB20Factory is IB20Factory {
    event B20Created(
        address indexed token,
        uint8 indexed variant,
        string name,
        string symbol,
        uint8 decimals,
        bytes variantEventParams
    );

    error UnsupportedVariant();
    error InitCallFailed(uint256 index);

    mapping(address => bool) public created;

    function createB20(
        B20Variant variant,
        bytes32 salt,
        bytes calldata params,
        bytes[] calldata initCalls
    ) external payable returns (address token) {
        if (variant != B20Variant.ASSET) revert UnsupportedVariant();
        B20AssetCreateParams memory p = abi.decode(params, (B20AssetCreateParams));
        bytes32 fullSalt = _fullSalt(msg.sender, salt);
        token = address(new MockB20Token{ salt: fullSalt }(p.name, p.symbol));
        for (uint256 i = 0; i < initCalls.length; i++) {
            (bool ok,) = token.call(initCalls[i]);
            if (!ok) revert InitCallFailed(i);
        }
        MockB20Token(token).finishBootstrap();
        created[token] = true;
        emit B20Created(token, uint8(variant), p.name, p.symbol, p.decimals, "");
    }

    function getB20Address(B20Variant, address sender, bytes32 salt)
        external
        view
        returns (address)
    {
        // The mock cannot know name/symbol ahead of time, so the prediction only matches when
        // the caller uses the same name/symbol as the launch; tests pass those explicitly.
        return _predict(sender, salt, "", "");
    }

    function predict(address sender, bytes32 salt, string memory name, string memory symbol)
        external
        view
        returns (address)
    {
        return _predict(sender, salt, name, symbol);
    }

    function isB20(address token) external view returns (bool) {
        return created[token];
    }

    function _fullSalt(address sender, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(sender, salt));
    }

    function _predict(address sender, bytes32 salt, string memory name, string memory symbol)
        private
        view
        returns (address)
    {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(MockB20Token).creationCode, abi.encode(name, symbol))
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), _fullSalt(sender, salt), initHash)
                    )
                )
            )
        );
    }
}
