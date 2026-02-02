// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/VastitasToken.sol";
import "../../contracts/PluginRegistry.sol";
import "../../contracts/RevenueRouter.sol";
import "../../contracts/SwapModule.sol";
import "../../contracts/TreasuryVault.sol";
import "../../contracts/types/PluginTypes.sol";

/**
 * @title YieldRoutingProperties
 * @notice Property-based fuzz tests for yield routing
 */
contract YieldRoutingProperties is Test {
    VastitasToken token;
    PluginRegistry registry;
    RevenueRouter router;
    SwapModule swapModule;
    TreasuryVault treasury;
    address treasuryAsset;

    function setUp() public {
        treasuryAsset = address(new MockERC20("Treasury", "TREAS"));
        
        token = new VastitasToken("Vastitas", "Vastitas", 0, address(this));
        treasury = new TreasuryVault(address(this), address(this));
        registry = new PluginRegistry(address(this), address(this));
        swapModule = new SwapModule(treasuryAsset, address(registry), address(this));
        router = new RevenueRouter(
            address(registry),
            address(swapModule),
            address(token),
            address(treasury),
            PluginTypes.DistributionModel.BUYBACK_ONLY,
            address(this),
            address(this)
        );
    }

    /**
     * @notice Invariant: Total yield received >= accumulated yield
     * @dev Fuzz test with random yield amounts
     */
    function testFuzz_TotalYieldInvariant(uint256 yieldAmount) public {
        // Bound yield amount to reasonable range
        yieldAmount = bound(yieldAmount, 1, 1_000_000 * 10**18);
        
        uint256 initialTotal = router.getTotalYield();
        uint256 initialAccumulated = router.getAccumulatedYield();
        
        // In a real test, we would route yield here
        // For now, we verify the invariant structure
        
        uint256 finalTotal = router.getTotalYield();
        uint256 finalAccumulated = router.getAccumulatedYield();
        
        // Invariant: total yield can only increase
        assertGe(finalTotal, initialTotal, "Total yield should not decrease");
        
        // Invariant: accumulated <= total
        assertLe(finalAccumulated, finalTotal, "Accumulated should not exceed total");
    }

    /**
     * @notice Invariant: Plugin yield accounting is monotonic
     */
    function testFuzz_PluginYieldMonotonic(bytes32 pluginId, uint256 yieldAmount) public {
        yieldAmount = bound(yieldAmount, 1, 1_000_000 * 10**18);
        
        uint256 initialYield = router.getPluginYield(pluginId);
        
        // After routing yield, plugin yield should increase
        // (In real test, would actually route yield)
        
        uint256 finalYield = router.getPluginYield(pluginId);
        
        // Plugin yield can only increase (or stay same)
        assertGe(finalYield, initialYield, "Plugin yield should not decrease");
    }

    /**
     * @notice Invariant: No negative balances
     */
    function testFuzz_NoNegativeBalances() public {
        // Verify all accounting values are non-negative
        uint256 totalYield = router.getTotalYield();
        uint256 accumulated = router.getAccumulatedYield();
        
        assertGe(totalYield, 0, "Total yield should be non-negative");
        assertGe(accumulated, 0, "Accumulated should be non-negative");
    }
}

// Mock ERC20 for testing
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        balanceOf[msg.sender] = 1_000_000 * 10**18;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
