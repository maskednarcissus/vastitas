// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VastitasToken
 * @notice Minimal ERC-20 token for Vastitas with voting support
 * @dev This token is intentionally minimal - it contains NO business logic
 * @dev All yield routing, distribution, and plugin logic lives in separate contracts
 * @dev This separation enables token survivability even if plugins are chaotic
 * @dev Supports voting for governance (ERC20Votes)
 */
contract VastitasToken is ERC20, ERC20Permit, ERC20Votes, Ownable {
    /**
     * @notice Constructor
     * @param name Token name
     * @param symbol Token symbol
     * @param initialSupply Initial token supply
     * @param initialHolder Address to receive initial supply
     */
    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply,
        address initialHolder,
        address initialOwner
    ) ERC20(name, symbol) ERC20Permit(name) Ownable(initialOwner) {
        if (initialSupply > 0 && initialHolder != address(0)) {
            _mint(initialHolder, initialSupply);
        }
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens
     * @param amount Amount to burn
     * @dev Used by RevenueRouter for buyback & burn
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /**
     * @notice Burn tokens from a specific address
     * @param from Address to burn from
     * @param amount Amount to burn
     * @dev Used by RevenueRouter for buyback & burn with approval
     */
    function burnFrom(address from, uint256 amount) external {
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }

    // Required overrides for ERC20Votes
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
