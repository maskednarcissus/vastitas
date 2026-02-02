// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title TreasuryVault
 * @notice Custody contract for treasury assets with role-based controls
 * @dev Manages treasury funds with withdrawal permissions
 * @dev Can receive native ETH from packages (4337 Paymaster, speculation house edge, etc.)
 */
contract TreasuryVault is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // Events
    event Deposit(address indexed token, address indexed from, uint256 amount);
    event Withdrawal(address indexed token, address indexed to, uint256 amount, address indexed authorizedBy);
    event ETHDeposit(address indexed from, uint256 amount);

    /**
     * @notice Constructor
     * @param admin Address with admin role
     * @param treasurer Address with treasurer role
     */
    constructor(address admin, address treasurer) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        if (treasurer != address(0)) {
            _grantRole(TREASURER_ROLE, treasurer);
        }
    }

    /**
     * @notice Deposit tokens to treasury
     * @param token Token address
     * @param amount Amount to deposit
     */
    function deposit(address token, uint256 amount) external {
        require(token != address(0), "TreasuryVault: zero token");
        require(amount > 0, "TreasuryVault: zero amount");
        
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(token, msg.sender, amount);
    }

    /**
     * @notice Withdraw tokens from treasury (treasurer or admin only)
     * @param token Token address
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdraw(
        address token,
        address to,
        uint256 amount
    ) external {
        require(
            hasRole(TREASURER_ROLE, msg.sender) || hasRole(ADMIN_ROLE, msg.sender),
            "TreasuryVault: unauthorized"
        );
        require(token != address(0), "TreasuryVault: zero token");
        require(to != address(0), "TreasuryVault: zero recipient");
        require(amount > 0, "TreasuryVault: zero amount");

        IERC20(token).safeTransfer(to, amount);
        emit Withdrawal(token, to, amount, msg.sender);
    }

    /**
     * @notice Get balance of a token in treasury
     * @param token Token address
     * @return balance Token balance
     */
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
    
    /**
     * @notice Get native ETH balance
     * @return balance ETH balance
     */
    function getETHBalance() external view returns (uint256) {
        return address(this).balance;
    }
    
    /**
     * @notice Withdraw native ETH from treasury (treasurer or admin only)
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawETH(
        address to,
        uint256 amount
    ) external {
        require(
            hasRole(TREASURER_ROLE, msg.sender) || hasRole(ADMIN_ROLE, msg.sender),
            "TreasuryVault: unauthorized"
        );
        require(to != address(0), "TreasuryVault: zero recipient");
        require(amount > 0, "TreasuryVault: zero amount");
        require(address(this).balance >= amount, "TreasuryVault: insufficient balance");

        (bool success, ) = payable(to).call{value: amount}("");
        require(success, "TreasuryVault: ETH transfer failed");
        emit Withdrawal(address(0), to, amount, msg.sender);
    }
    
    /**
     * @notice Receive native ETH
     * @dev Allows packages to send ETH directly to treasury (e.g., 4337 Paymaster fees, speculation house edge)
     */
    receive() external payable {
        if (msg.value > 0) {
            emit ETHDeposit(msg.sender, msg.value);
        }
    }
    
    /**
     * @notice Fallback to receive ETH
     */
    fallback() external payable {
        if (msg.value > 0) {
            emit ETHDeposit(msg.sender, msg.value);
        }
    }
}
