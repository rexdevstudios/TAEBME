// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RTraderTraderPass (GameFi & NFT Trader Pass for Base L2)
 * @notice Standard ERC-721 Trader Pass supporting genuine EIP-712 signed mint vouchers,
 * complete ERC-721 transferability and approvals, anti-replay nonces, and zero platform custody.
 */

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract RTraderTraderPass is ERC721URIStorage, EIP712, Ownable {
    address public adminSigner;
    uint256 public totalSupply;

    // EIP-712 Domain & Type Hashes
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant MINT_VOUCHER_TYPEHASH = keccak256(
        "MintVoucher(address recipient,string tier,string metadataUri,uint256 nonce,uint256 deadline)"
    );

    // Pass metadata & anti-replay storage
    mapping(uint256 => string) public tokenTiers;
    mapping(uint256 => bool) public usedNonces;

    event TraderPassMinted(address indexed recipient, uint256 indexed tokenId, string tier, string metadataUri);
    event AdminSignerUpdated(address indexed previousSigner, address indexed newSigner);

    constructor(address _adminSigner)
        ERC721("RTrader Trader Pass", "RTPASS")
        EIP712("RTrader Trader Pass", "1")
        Ownable(msg.sender)
    {
        require(_adminSigner != address(0), "INVALID_ADMIN_SIGNER");
        adminSigner = _adminSigner;
    }

    // =========================================================================
    // ADMIN FUNCTIONS
    // =========================================================================

    function setAdminSigner(address _newSigner) external onlyOwner {
        require(_newSigner != address(0), "INVALID_ADMIN_SIGNER");
        emit AdminSignerUpdated(adminSigner, _newSigner);
        adminSigner = _newSigner;
    }

    // =========================================================================
    // EIP-165 INTERFACE DETECTION
    // =========================================================================

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // =========================================================================
    // EIP-712 DOMAIN SEPARATOR & VOUCHER EXECUTION
    // =========================================================================

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function mintWithVoucher(
        string calldata tier,
        string calldata metadataUri,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256) {
        return _mintWithVoucher(msg.sender, tier, metadataUri, nonce, deadline, signature);
    }

    function mintWithVoucherFor(
        address recipient,
        string calldata tier,
        string calldata metadataUri,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256) {
        return _mintWithVoucher(recipient, tier, metadataUri, nonce, deadline, signature);
    }

    function _mintWithVoucher(
        address recipient,
        string calldata tier,
        string calldata metadataUri,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal returns (uint256) {
        require(recipient != address(0), "INVALID_RECIPIENT");
        require(block.timestamp <= deadline, "VOUCHER_EXPIRED");
        require(!usedNonces[nonce], "NONCE_ALREADY_USED");

        bytes32 structHash = keccak256(
            abi.encode(
                MINT_VOUCHER_TYPEHASH,
                recipient,
                keccak256(bytes(tier)),
                keccak256(bytes(metadataUri)),
                nonce,
                deadline
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredSigner = ECDSA.recover(digest, signature);
        require(recoveredSigner == adminSigner, "INVALID_VOUCHER_SIGNATURE");

        usedNonces[nonce] = true;
        totalSupply++;
        uint256 newTokenId = totalSupply;

        _safeMint(recipient, newTokenId);
        _setTokenURI(newTokenId, metadataUri);
        tokenTiers[newTokenId] = tier;

        emit TraderPassMinted(recipient, newTokenId, tier, metadataUri);
        return newTokenId;
    }

    function recoverSigner(bytes32 digest, bytes memory sig) public pure returns (address) {
        return ECDSA.recover(digest, sig);
    }
}
