// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Coinbase tokenized stocks on Base and their Chainlink total-return feeds.
///         Source: docs.base.org "Tokenized Stocks on Base" (September 2026).
library BaseStocks {
    struct Entry {
        address token;
        address feed;
        string symbol;
    }

    function all() internal pure returns (Entry[] memory list) {
        list = new Entry[](13);
        list[0] = Entry(
            0xb20000000000000000000078ee7ce2fE4908108C,
            0x04689a41629776563E6822F76f2e57D148d28513,
            "NVDAc"
        );
        list[1] = Entry(
            0xb200000000000000000000C2e324d24d7eEcd1fb,
            0x787f13dEa48Db0897CbCDD985de77809D837F988,
            "AAPLc"
        );
        list[2] = Entry(
            0xb2000000000000000000008bC8786B856E61707C,
            0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D,
            "METAc"
        );
        list[3] = Entry(
            0xb2000000000000000000002D0BA3164cc74f58B7,
            0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2,
            "GOOGLc"
        );
        list[4] = Entry(
            0xb2000000000000000000001e800a7f5189430cD0,
            0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4,
            "TSLAc"
        );
        list[5] = Entry(
            0xB200000000000000000000Ab99cFa739E253872B,
            0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c,
            "MSFTc"
        );
        list[6] = Entry(
            0xb200000000000000000000d9192b6B456483C2E8,
            0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295,
            "AMZNc"
        );
        list[7] = Entry(
            0xb2000000000000000000004884b426556b92883d,
            0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a,
            "MSTRc"
        );
        list[8] = Entry(
            0xb200000000000000000000397293Cb8cda9a10c5,
            0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA,
            "SNDKc"
        );
        list[9] = Entry(
            0xb2000000000000000000007b9fcbd005511aCBd5,
            0x6A634B235903C4ad6376892180d6fF8612e3Fa68,
            "SPCXc"
        );
        list[10] = Entry(
            0xb200000000000000000000c85a31389D71F3ecfb,
            0x408e44f504A7371a345F03a73dDC96A4b48e8aa7,
            "COINc"
        );
        list[11] = Entry(
            0xB20000000000000000000019f6E7C675b73C2e4D,
            0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33,
            "CRCLc"
        );
        list[12] = Entry(
            0xB2000000000000000000004AFF16039bA04bdFBc,
            0xAB657C39bac0D5886250D70849e2E3E008F2EECB,
            "INTCc"
        );
    }
}
