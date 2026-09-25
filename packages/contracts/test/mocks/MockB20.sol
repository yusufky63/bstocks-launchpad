// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { IB20Factory } from "../../src/interfaces/IB20Factory.sol";

/// @notice EVM stand-in for a B20 asset token. Base's real B20 tokens are Rust precompiles, so
///         tests etch this factory at the canonical address. It models the access rules the
///         launcher depends on, as verified against the base/base b20_asset logic and mainnet:
///         - init calls from the B20 factory are privileged: role checks are skipped, except that
///           DEFAULT_ADMIN_ROLE can never be granted on a token created with no admin;
///         - after bootstrap, grant/revoke/setRoleAdmin need an admin, and a zero-admin token has
///           none, so role holders can only shrink;
///         - renounceRole always works for the caller's own role and is never privileged;
///         - updateName/updateSymbol/updateContractURI need METADATA_ROLE, mint needs MINT_ROLE,
///           updateSupplyCap needs DEFAULT_ADMIN_ROLE.
///         The constructor takes no arguments (name and symbol arrive through `initialize`), so
///         the CREATE2 address depends on the sender and salt only, as on the precompile.
contract MockB20Token is ERC20 {
    bytes32 public constant DEFAULT_ADMIN_ROLE = bytes32(0);
    bytes32 public constant MINT_ROLE = keccak256("MINT_ROLE");
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant METADATA_ROLE = keccak256("METADATA_ROLE");

    address public immutable bootstrapper;
    bool public bootstrapped;
    uint256 public supplyCap = type(uint128).max;
    uint256 public adminCount;
    string private _contractURI;
    string private _name;
    string private _symbol;
    mapping(bytes32 => mapping(address => bool)) private _roles;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event ContractURIUpdated();
    event NameUpdated(address indexed updater, string newName);
    event SymbolUpdated(address indexed updater, string newSymbol);

    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
    error AccessControlBadConfirmation();
    error NotBootstrapping();
    error SupplyCapExceeded();

    constructor() ERC20("", "") {
        bootstrapper = msg.sender;
    }

    function _privileged() private view returns (bool) {
        return !bootstrapped && msg.sender == bootstrapper;
    }

    modifier gated(bytes32 role) {
        if (!_privileged() && !_roles[role][msg.sender]) {
            revert AccessControlUnauthorizedAccount(msg.sender, role);
        }
        _;
    }

    function initialize(string calldata name_, string calldata symbol_) external {
        if (!_privileged()) revert NotBootstrapping();
        _name = name_;
        _symbol = symbol_;
    }

    function finishBootstrap() external {
        if (!_privileged()) revert NotBootstrapping();
        bootstrapped = true;
    }

    // ---- metadata -------------------------------------------------------------------------

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    function updateContractURI(string calldata newURI) external gated(METADATA_ROLE) {
        _contractURI = newURI;
        emit ContractURIUpdated();
    }

    function updateName(string calldata newName) external gated(METADATA_ROLE) {
        _name = newName;
        emit NameUpdated(msg.sender, newName);
    }

    function updateSymbol(string calldata newSymbol) external gated(METADATA_ROLE) {
        _symbol = newSymbol;
        emit SymbolUpdated(msg.sender, newSymbol);
    }

    // ---- supply ---------------------------------------------------------------------------

    function updateSupplyCap(uint256 newSupplyCap) external gated(DEFAULT_ADMIN_ROLE) {
        supplyCap = newSupplyCap;
    }

    function mint(address to, uint256 amount) external gated(MINT_ROLE) {
        if (totalSupply() + amount > supplyCap) revert SupplyCapExceeded();
        _mint(to, amount);
    }

    // ---- roles ----------------------------------------------------------------------------

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external {
        if (_privileged()) {
            // Rust grant_role: the admin-count check still runs for DEFAULT_ADMIN_ROLE.
            if (role == DEFAULT_ADMIN_ROLE && adminCount == 0) {
                revert AccessControlUnauthorizedAccount(msg.sender, DEFAULT_ADMIN_ROLE);
            }
        } else {
            // ensure_role_admin_mutations_available: nothing moves on a zero-admin token.
            if (adminCount == 0 || !_roles[DEFAULT_ADMIN_ROLE][msg.sender]) {
                revert AccessControlUnauthorizedAccount(msg.sender, DEFAULT_ADMIN_ROLE);
            }
        }
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            if (role == DEFAULT_ADMIN_ROLE) adminCount += 1;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) external {
        if (!_privileged() && (adminCount == 0 || !_roles[DEFAULT_ADMIN_ROLE][msg.sender])) {
            revert AccessControlUnauthorizedAccount(msg.sender, DEFAULT_ADMIN_ROLE);
        }
        if (_roles[role][account]) {
            _roles[role][account] = false;
            if (role == DEFAULT_ADMIN_ROLE) adminCount -= 1;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function renounceRole(bytes32 role, address callerConfirmation) external {
        if (callerConfirmation != msg.sender) revert AccessControlBadConfirmation();
        if (_roles[role][msg.sender]) {
            _roles[role][msg.sender] = false;
            if (role == DEFAULT_ADMIN_ROLE) adminCount -= 1;
            emit RoleRevoked(role, msg.sender, msg.sender);
        }
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
    error InitCallFailed(uint256 index, bytes reason);

    mapping(address => bool) public created;
    /// @dev Test switch: skip grantRole init calls, standing in for a precompile that does not
    ///      behave as reviewed. The launch must notice and revert.
    bool public ignoreRoleGrants;
    /// @dev Test switch: grant METADATA_ROLE to the caller even when its bootstrap did not ask.
    ///      The launch must notice and revert.
    bool public grantUnasked;

    function setIgnoreRoleGrants(bool value) external {
        ignoreRoleGrants = value;
    }

    function setGrantUnasked(bool value) external {
        grantUnasked = value;
    }

    function createB20(
        B20Variant variant,
        bytes32 salt,
        bytes calldata params,
        bytes[] calldata initCalls
    ) external payable returns (address token) {
        if (variant != B20Variant.ASSET) revert UnsupportedVariant();
        B20AssetCreateParams memory p = abi.decode(params, (B20AssetCreateParams));
        if (p.initialAdmin != address(0)) revert UnsupportedVariant(); // launcher never sets one
        MockB20Token t = new MockB20Token{ salt: _fullSalt(msg.sender, salt) }();
        token = address(t);
        t.initialize(p.name, p.symbol);
        for (uint256 i = 0; i < initCalls.length; i++) {
            if (ignoreRoleGrants && bytes4(initCalls[i][:4]) == MockB20Token.grantRole.selector) {
                continue;
            }
            (bool ok, bytes memory reason) = token.call(initCalls[i]);
            if (!ok) revert InitCallFailed(i, reason);
        }
        if (grantUnasked) t.grantRole(t.METADATA_ROLE(), msg.sender);
        t.finishBootstrap();
        created[token] = true;
        emit B20Created(token, uint8(variant), p.name, p.symbol, p.decimals, "");
    }

    /// @notice The address createB20 will return for (sender, salt), whatever the name and symbol,
    ///         as on the precompile (checked on mainnet by script/probes/PredictProbe.sol).
    function getB20Address(B20Variant, address sender, bytes32 salt)
        public
        view
        returns (address)
    {
        bytes32 initHash = keccak256(type(MockB20Token).creationCode);
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

    /// @dev Kept for the older tests: the name and symbol no longer affect the address.
    function predict(address sender, bytes32 salt, string memory, string memory)
        external
        view
        returns (address)
    {
        return getB20Address(B20Variant.ASSET, sender, salt);
    }

    function isB20(address token) external view returns (bool) {
        return created[token];
    }

    function isB20Initialized(address token) external view returns (bool) {
        return created[token];
    }

    function _fullSalt(address sender, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(sender, salt));
    }
}
