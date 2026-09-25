// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Vm } from "forge-std/Test.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { B20Encoding } from "../src/B20Encoding.sol";
import { IB20Factory, IB20Token } from "../src/interfaces/IB20Factory.sol";
import { MockB20Factory, MockB20Token } from "./mocks/MockB20.sol";
import { Fixture } from "./Fixture.sol";

contract MetadataTest is Fixture {
    bytes32 constant METADATA_ROLE = keccak256("METADATA_ROLE");
    address stranger = makeAddr("stranger");

    function _launchEditable(bytes32 salt) internal returns (address token) {
        StockPairFactory.LaunchOptions memory o = _options(true);
        vm.prank(creator);
        (token,) = factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, salt), o);
    }

    function _status(address token) internal view returns (uint8) {
        return uint8(factory.metadataStatus(token));
    }

    // ---- the encoding ---------------------------------------------------------------------------

    function test_MetadataRoleIsTheMainnetValue() public pure {
        assertEq(B20Encoding.METADATA_ROLE, keccak256("METADATA_ROLE"));
        assertEq(
            B20Encoding.METADATA_ROLE, 0x6bd6b5318a46e5fff572d5e4258a20774aab40cc35ac7680654b9081fcc82f80
        );
    }

    /// A frozen launch encodes exactly what every earlier launch encoded (spelled out here with
    /// signature strings, independent of the interface), and the editable one only appends the
    /// metadata grant to the factory.
    function test_ImmutableBootstrapIsByteIdenticalToEarlierLaunches() public view {
        address recipient = address(factory);
        string memory uri = "ipfs://bafkreitest";
        bytes[] memory earlier = new bytes[](3);
        earlier[0] = abi.encodeWithSignature("updateSupplyCap(uint256)", SUPPLY);
        earlier[1] = abi.encodeWithSignature("mint(address,uint256)", recipient, SUPPLY);
        earlier[2] = abi.encodeWithSignature("updateContractURI(string)", uri);

        bytes[] memory frozen = B20Encoding.bootstrapCalls(recipient, SUPPLY, uri, address(0));
        assertEq(keccak256(abi.encode(frozen)), keccak256(abi.encode(earlier)), "byte-identical");

        bytes[] memory editable = B20Encoding.bootstrapCalls(recipient, SUPPLY, uri, address(factory));
        assertEq(editable.length, 4);
        for (uint256 i; i < 3; i++) {
            assertEq(editable[i], earlier[i]);
        }
        assertEq(
            editable[3],
            abi.encodeWithSignature("grantRole(bytes32,address)", METADATA_ROLE, address(factory))
        );
    }

    // ---- default: frozen ----------------------------------------------------------------------

    function test_LaunchIsFrozen() public {
        vm.prank(creator);
        (address token,) = factory.launch{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(1))));
        assertEq(_status(token), uint8(StockPairFactory.MetadataStatus.Immutable));
        assertFalse(MockB20Token(token).hasRole(METADATA_ROLE, address(factory)));
        vm.startPrank(creator);
        vm.expectRevert(StockPairFactory.MetadataNotEditable.selector);
        factory.updateContractURI(token, "ipfs://bafkreinew");
        vm.expectRevert(StockPairFactory.MetadataNotEditable.selector);
        factory.lockMetadata(token);
        vm.stopPrank();
    }

    function test_OptionsDefaultIsFrozen() public {
        StockPairFactory.LaunchOptions memory o = _options(false);
        vm.prank(creator);
        (address token,) = factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, 0), o);
        assertEq(_status(token), uint8(StockPairFactory.MetadataStatus.Immutable));
        assertFalse(MockB20Token(token).hasRole(METADATA_ROLE, address(factory)));
        vm.startPrank(creator);
        vm.expectRevert(StockPairFactory.MetadataNotEditable.selector);
        factory.updateContractURI(token, "ipfs://bafkreinew");
        vm.expectRevert(StockPairFactory.MetadataNotEditable.selector);
        factory.lockMetadata(token);
        vm.stopPrank();
    }

    // ---- editable: exactly one metadata-only role, held by the factory -----------------------

    function test_EditableGrantsOnlyMetadataRoleToFactory() public {
        address token = _launchEditable(bytes32(uint256(2)));
        MockB20Token t = MockB20Token(token);
        assertEq(_status(token), uint8(StockPairFactory.MetadataStatus.Editable));
        assertTrue(t.hasRole(METADATA_ROLE, address(factory)));
        assertEq(t.adminCount(), 0, "still zero admin");
        address[5] memory who = [address(factory), creator, address(hook), owner, treasury];
        bytes32[3] memory powerful = [t.DEFAULT_ADMIN_ROLE(), t.MINT_ROLE(), t.PAUSE_ROLE()];
        for (uint256 i; i < who.length; i++) {
            for (uint256 j; j < powerful.length; j++) {
                assertFalse(t.hasRole(powerful[j], who[i]), "no mint/pause/admin for anyone");
            }
            if (who[i] != address(factory)) assertFalse(t.hasRole(METADATA_ROLE, who[i]));
        }
        bytes32 mintRole = t.MINT_ROLE();
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(
                MockB20Token.AccessControlUnauthorizedAccount.selector, address(factory), mintRole
            )
        );
        t.mint(address(factory), 1);
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(
                MockB20Token.AccessControlUnauthorizedAccount.selector, address(factory), bytes32(0)
            )
        );
        t.updateSupplyCap(type(uint128).max);
    }

    function test_CreatorUpdatesContractURI() public {
        address token = _launchEditable(bytes32(uint256(3)));
        vm.recordLogs();
        vm.prank(creator);
        factory.updateContractURI(token, "ipfs://bafkreinewprofile");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(MockB20Token(token).contractURI(), "ipfs://bafkreinewprofile");
        assertEq(MockB20Token(token).name(), "Test Token", "name never changes");
        assertEq(MockB20Token(token).symbol(), "TEST", "symbol never changes");
        bool tokenEvent;
        bool factoryEvent;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == MockB20Token.ContractURIUpdated.selector) {
                assertEq(logs[i].emitter, token);
                tokenEvent = true;
            }
            if (logs[i].topics[0] == StockPairFactory.ContractURIChanged.selector) {
                factoryEvent = true;
                assertEq(logs[i].emitter, address(factory));
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(token))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(creator))));
                assertEq(abi.decode(logs[i].data, (string)), "ipfs://bafkreinewprofile");
            }
        }
        assertTrue(tokenEvent && factoryEvent);
        assertEq(_status(token), uint8(StockPairFactory.MetadataStatus.Editable), "still editable");
    }

    function test_OnlyTheOriginalCreator() public {
        address token = _launchEditable(bytes32(uint256(4)));
        address[4] memory others = [stranger, owner, treasury, address(hook)];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(StockPairFactory.NotCreator.selector);
            factory.updateContractURI(token, "ipfs://bafkreix");
            vm.prank(others[i]);
            vm.expectRevert(StockPairFactory.NotCreator.selector);
            factory.lockMetadata(token);
        }
    }

    function test_CreatorCannotWriteTheTokenDirectly() public {
        address token = _launchEditable(bytes32(uint256(5)));
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockB20Token.AccessControlUnauthorizedAccount.selector, creator, METADATA_ROLE
            )
        );
        IB20Token(token).updateContractURI("ipfs://direct");
    }

    function test_RejectsNonContentAddressedAndMalformedURIs() public {
        address token = _launchEditable(bytes32(uint256(6)));
        string[] memory bad = _badEditableURIs();
        for (uint256 i; i < bad.length; i++) {
            vm.prank(creator);
            vm.expectRevert(StockPairFactory.InvalidText.selector);
            factory.updateContractURI(token, bad[i]);
        }
        vm.prank(creator);
        factory.updateContractURI(token, string(abi.encodePacked("ipfs://", _letters(505)))); // 512
        vm.prank(creator);
        factory.updateContractURI(token, "ipfs://b"); // 8, the shortest
        // What the site actually pins: a bare CIDv0 or CIDv1.
        vm.prank(creator);
        factory.updateContractURI(token, CID_V0);
        assertEq(MockB20Token(token).contractURI(), CID_V0);
        vm.prank(creator);
        factory.updateContractURI(token, CID_V1);
        assertEq(MockB20Token(token).contractURI(), CID_V1);
    }

    string constant CID_V0 = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    string constant CID_V1 = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    /// Not content-addressed, malformed, or a path a gateway normalizes out of /ipfs/<cid> (to a
    /// mutable /ipns/ name, for the traversals). An editable profile must refuse every one.
    function _badEditableURIs() internal pure returns (string[] memory bad) {
        bad = new string[](25);
        bad[0] = "";
        bad[1] = "ipfs://";
        bad[2] = "https://example.com/meta.json";
        bad[3] = "IPFS://bafkrei";
        bad[4] = "data:application/json;base64,e30=";
        bad[5] = "ipfs://bafk\nrei";
        bad[6] = "ipfs://bafk rei";
        bad[7] = "ipfs://bafk\x7frei";
        bad[8] = string(abi.encodePacked("ipfs://", _letters(506))); // 513 bytes
        bad[9] = "ipfs://../ipns/x";
        bad[10] = "ipfs://%2e%2e/ipns/x";
        bad[11] = "ipfs://a/../../ipns/x";
        bad[12] = "ipfs://a\\..\\..\\ipns\\x";
        bad[13] = "ipfs://a/b";
        bad[14] = "ipfs://a\\b";
        bad[15] = "ipfs://a?x";
        bad[16] = "ipfs://a#x";
        bad[17] = "ipfs://..";
        bad[18] = "ipfs:///ipns/x";
        bad[19] = "ipfs://a.eth";
        bad[20] = "ipfs://a%2Fb";
        bad[21] = "ipfs://a-b";
        bad[22] = "ipfs://a_b";
        bad[23] = string.concat(CID_V1, "/meta.json");
        bad[24] = string.concat(CID_V0, "/");
    }

    /// Every byte value, first, inside and last in the CID: only letters and digits get through.
    function test_CidIsLettersAndDigitsOnly() public {
        address token = _launchEditable(bytes32(uint256(13)));
        for (uint256 v; v < 256; v++) {
            bytes1 c = bytes1(uint8(v));
            bool alnum = (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5A)
                || (v >= 0x61 && v <= 0x7A);
            bytes[3] memory uris = [
                abi.encodePacked("ipfs://", c, "bafy"),
                abi.encodePacked("ipfs://ba", c, "fy"),
                abi.encodePacked("ipfs://bafy", c)
            ];
            for (uint256 j; j < uris.length; j++) {
                vm.prank(creator);
                if (!alnum) vm.expectRevert(StockPairFactory.InvalidText.selector);
                factory.updateContractURI(token, string(uris[j]));
            }
        }
    }

    function _letters(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; i++) b[i] = "a";
    }

    function test_LockIsPermanent() public {
        address token = _launchEditable(bytes32(uint256(7)));
        vm.expectEmit(true, true, false, false, address(factory));
        emit StockPairFactory.MetadataLocked(token, creator);
        vm.prank(creator);
        factory.lockMetadata(token);
        assertEq(_status(token), uint8(StockPairFactory.MetadataStatus.Locked));
        assertFalse(MockB20Token(token).hasRole(METADATA_ROLE, address(factory)));
        vm.startPrank(creator);
        vm.expectRevert(StockPairFactory.MetadataNotEditable.selector);
        factory.updateContractURI(token, "ipfs://bafkreiafter");
        vm.expectRevert(StockPairFactory.MetadataNotEditable.selector);
        factory.lockMetadata(token);
        vm.stopPrank();
        // Nothing can hand the role back: the token has no admin.
        vm.prank(address(factory));
        vm.expectRevert();
        MockB20Token(token).grantRole(METADATA_ROLE, address(factory));
    }

    function test_LockIsPerToken() public {
        address a = _launchEditable(bytes32(uint256(8)));
        address b = _launchEditable(bytes32(uint256(9)));
        vm.prank(creator);
        factory.lockMetadata(a);
        assertTrue(_editable(b));
        vm.prank(creator);
        factory.updateContractURI(b, "ipfs://bafkreib");
    }

    function test_NobodyCanGrantRolesAfterLaunch() public {
        address token = _launchEditable(bytes32(uint256(10)));
        MockB20Token t = MockB20Token(token);
        bytes32 admin = t.DEFAULT_ADMIN_ROLE();
        bytes32 minter = t.MINT_ROLE();
        address[3] memory who = [address(factory), creator, owner];
        for (uint256 i; i < who.length; i++) {
            vm.startPrank(who[i]);
            vm.expectRevert();
            t.grantRole(METADATA_ROLE, stranger);
            vm.expectRevert();
            t.grantRole(admin, who[i]);
            vm.expectRevert();
            t.grantRole(minter, who[i]);
            vm.stopPrank();
        }
    }

    function test_UnknownTokenIsNotEditable() public {
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.NotCreator.selector);
        factory.updateContractURI(address(0xBEEF), "ipfs://bafkreix");
    }

    /// Tokens the factory never launched (including every token of an earlier factory) read as
    /// Immutable without an external call, so the view cannot revert on an address with no code.
    function test_UnknownTokenStatusIsImmutable() public view {
        assertEq(_status(address(0xBEEF)), uint8(StockPairFactory.MetadataStatus.Immutable));
        assertEq(_status(address(0)), uint8(StockPairFactory.MetadataStatus.Immutable));
        assertEq(_status(STOCK_LOW), uint8(StockPairFactory.MetadataStatus.Immutable));
    }

    /// The mock must refuse what the real precompile refuses, or the tests above prove nothing.
    function test_MockRefusesAdminGrantAtBootstrapLikeThePrecompile() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(IB20Token.grantRole, (bytes32(0), address(this)));
        vm.expectRevert();
        MockB20Factory(B20_FACTORY).createB20(
            IB20Factory.B20Variant.ASSET,
            bytes32(uint256(1)),
            abi.encode(IB20Factory.B20AssetCreateParams(1, "X", "X", address(0), 18)),
            calls
        );
    }

    // ---- the factory checks the token it got --------------------------------------------------

    /// A precompile that dropped the grant would leave an "editable" launch nobody can edit.
    function test_LaunchStopsIfTheRoleGrantDoesNotHappen() public {
        MockB20Factory(B20_FACTORY).setIgnoreRoleGrants(true);
        StockPairFactory.LaunchOptions memory o = _options(true);
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.UnexpectedRoles.selector);
        factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(11))), o);
        assertEq(factory.tokenCount(), 0);
    }

    /// A precompile that handed out a role nobody asked for would make a "frozen" launch editable.
    function test_LaunchStopsIfARoleIsGrantedUnasked() public {
        MockB20Factory(B20_FACTORY).setGrantUnasked(true);
        StockPairFactory.LaunchOptions memory o = _options(false);
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.UnexpectedRoles.selector);
        factory.launch{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(12))));
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.UnexpectedRoles.selector);
        factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(12))), o);
        assertEq(factory.tokenCount(), 0);
        // An editable launch asked for exactly that role, so it is unaffected.
        o = _options(true);
        vm.prank(creator);
        (address token,) = factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(12))), o);
        assertTrue(_editable(token));
    }

    // ---- the factory has no other way to touch token metadata ---------------------------------

    /// Walks the runtime bytecode and fails if any PUSH4 carries a B20 selector the factory must
    /// never call, or if the code contains DELEGATECALL / SELFDESTRUCT. A tripwire for review:
    /// a future "multicall" or rename helper would trip it.
    function test_FactoryBytecodeHasNoRenameOrGenericCallPath() public view {
        bytes memory code = address(factory).code;
        bool sawUpdateUri;
        bool sawRenounce;
        bytes4[4] memory forbidden = [
            bytes4(keccak256("updateName(string)")),
            bytes4(keccak256("updateSymbol(string)")),
            bytes4(keccak256("updateExtraMetadata(string,string)")),
            bytes4(keccak256("revokeRole(bytes32,address)"))
        ];
        for (uint256 i; i < code.length; i++) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xff, "SELFDESTRUCT");
            if (op == 0x63 && i + 4 < code.length) {
                bytes4 v = bytes4(
                    uint32(uint8(code[i + 1])) << 24 | uint32(uint8(code[i + 2])) << 16
                        | uint32(uint8(code[i + 3])) << 8 | uint32(uint8(code[i + 4]))
                );
                for (uint256 j; j < forbidden.length; j++) {
                    assertTrue(v != forbidden[j], "forbidden B20 selector in factory");
                }
                if (v == bytes4(keccak256("updateContractURI(string)"))) sawUpdateUri = true;
                if (v == bytes4(keccak256("renounceRole(bytes32,address)"))) sawRenounce = true;
            }
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip push data
        }
        // Positive control: the scanner does find the selectors the factory is meant to use.
        assertTrue(sawUpdateUri, "scanner missed updateContractURI");
        assertTrue(sawRenounce, "scanner missed renounceRole");
    }

    function test_EditableLaunchNeedsAnIpfsURI() public {
        string[] memory bad = _badEditableURIs();
        for (uint256 i; i < bad.length; i++) {
            StockPairFactory.LaunchParams memory p = _params(STOCK_LOW, bytes32(i + 900));
            p.contractURI = bad[i];
            vm.prank(creator);
            vm.expectRevert(StockPairFactory.InvalidText.selector);
            factory.launchWithOptions{ value: FEE }(p, _options(true));
            vm.prank(creator);
            vm.expectRevert(StockPairFactory.InvalidText.selector);
            factory.launchAndBuy{ value: FEE }(
                p, _options(true), StockPairFactory.CreatorBuy(1e8, 1)
            );
        }
        assertEq(factory.tokenCount(), 0);
        // A bare CID of either version launches editable.
        StockPairFactory.LaunchParams memory v0 = _params(STOCK_LOW, bytes32(uint256(997)));
        v0.contractURI = CID_V0;
        vm.prank(creator);
        (address t0,) = factory.launchWithOptions{ value: FEE }(v0, _options(true));
        assertTrue(_editable(t0));
        StockPairFactory.LaunchParams memory v1 = _params(STOCK_LOW, bytes32(uint256(998)));
        v1.contractURI = CID_V1;
        vm.prank(creator);
        (address t1,) = factory.launchWithOptions{ value: FEE }(v1, _options(true));
        assertTrue(_editable(t1));
        // A fixed profile is unaffected: its URI is only checked as text, exactly as before.
        StockPairFactory.LaunchParams memory ok = _params(STOCK_LOW, bytes32(uint256(999)));
        ok.contractURI = "https://x.example/meta.json";
        vm.prank(creator);
        factory.launchWithOptions{ value: FEE }(ok, _options(false));
        ok.salt = bytes32(uint256(1000));
        ok.contractURI = string.concat(CID_V1, "/meta.json");
        vm.prank(creator);
        factory.launch{ value: FEE }(ok);
    }
}
