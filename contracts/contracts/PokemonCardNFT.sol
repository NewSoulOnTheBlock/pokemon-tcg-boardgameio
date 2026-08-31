// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PokemonCardNFT
 * @notice ERC-721 backing the card collection of the Pokemon TCG arena on
 *         Robinhood Chain. Each token is one pulled card; the Pokemon TCG
 *         card id (e.g. "sv1-13") is stored on chain and `tokenURI` is
 *         derived from it, so metadata is served by the game API at
 *         `<baseURI><cardId>/metadata` with no IPFS pinning involved.
 *
 * @dev Design notes:
 *      - ERC721Enumerable is deliberate. The game's "import my NFTs" page
 *        needs to answer "what does this wallet own" and Robinhood Chain
 *        has no NFT indexer to ask; enumeration puts that answer in the
 *        contract itself, at the cost of extra gas per transfer.
 *      - Minting is gated to a minter set rather than to `owner` alone, so
 *        the game server's hot key can be rotated without moving ownership.
 *      - There is no burn, no royalty, and no max supply: the server is the
 *        authority on how many cards exist, exactly as it was before the
 *        chain migration.
 */
contract PokemonCardNFT is ERC721Enumerable, Ownable {
    /// @notice Base URI every token's metadata URL is built from.
    string public baseURI;

    /// @notice Pokemon TCG card id for each minted token.
    mapping(uint256 => string) public cardIdOf;

    /// @notice Addresses allowed to mint. The game server's treasury key.
    mapping(address => bool) public isMinter;

    uint256 private _nextTokenId = 1;

    event CardMinted(address indexed to, uint256 indexed tokenId, string cardId);
    event MinterUpdated(address indexed minter, bool allowed);
    event BaseURIUpdated(string baseURI);

    error NotMinter(address caller);
    error EmptyCardId();
    error MintToZeroAddress();

    modifier onlyMinter() {
        if (!isMinter[msg.sender]) revert NotMinter(msg.sender);
        _;
    }

    /**
     * @param initialOwner Contract owner (can set minters + base URI).
     * @param initialBaseURI e.g. "https://your-app.onrender.com/api/cards/"
     */
    constructor(address initialOwner, string memory initialBaseURI)
        ERC721("Pokemon TCG Arena Card", "PTCG")
        Ownable(initialOwner)
    {
        baseURI = initialBaseURI;
        // The deployer is a minter by default so a fresh deploy is usable
        // immediately; revoke it once the server key is registered.
        isMinter[initialOwner] = true;
        emit MinterUpdated(initialOwner, true);
        emit BaseURIUpdated(initialBaseURI);
    }

    // ----- minting ---------------------------------------------------------

    /**
     * @notice Mint one card to `to`.
     * @param cardId Pokemon TCG card id, e.g. "sv1-13".
     * @return tokenId The newly assigned token id.
     */
    function mintCard(address to, string calldata cardId) external onlyMinter returns (uint256 tokenId) {
        if (to == address(0)) revert MintToZeroAddress();
        if (bytes(cardId).length == 0) revert EmptyCardId();

        tokenId = _nextTokenId++;
        cardIdOf[tokenId] = cardId;
        _safeMint(to, tokenId);
        emit CardMinted(to, tokenId, cardId);
    }

    /**
     * @notice Mint a whole booster pack in one transaction.
     * @dev Saves the server nine sequential sends (and nine nonces) per
     *      pack. Returns ids in the same order as `cardIds`.
     */
    function mintPack(address to, string[] calldata cardIds)
        external
        onlyMinter
        returns (uint256[] memory tokenIds)
    {
        if (to == address(0)) revert MintToZeroAddress();
        tokenIds = new uint256[](cardIds.length);
        for (uint256 i = 0; i < cardIds.length; i++) {
            if (bytes(cardIds[i]).length == 0) revert EmptyCardId();
            uint256 tokenId = _nextTokenId++;
            cardIdOf[tokenId] = cardIds[i];
            _safeMint(to, tokenId);
            emit CardMinted(to, tokenId, cardIds[i]);
            tokenIds[i] = tokenId;
        }
    }

    // ----- admin -----------------------------------------------------------

    function setMinter(address minter, bool allowed) external onlyOwner {
        isMinter[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        baseURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    // ----- metadata --------------------------------------------------------

    /// @notice `<baseURI><cardId>/metadata`, matching the game's REST route.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(baseURI, cardIdOf[tokenId], "/metadata");
    }

    /// @notice Total tokens minted so far, including any later transferred.
    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }
}
