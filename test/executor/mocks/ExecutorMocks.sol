// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {
    ISlipstreamSwapRouter,
    IUniswapV3SwapRouter02,
    IPermit2SignatureTransfer
} from "../../../contracts/executor/interfaces/IMPGRExecutorRouters.sol";

/// @notice Mintable ERC-20 with EIP-2612 permit and configurable decimals.
contract MockPermitToken is ERC20Permit {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Takes 1% on every transfer — must be rejected as a sell token.
contract MockFeeOnTransferToken is ERC20 {
    constructor() ERC20("FeeOnTransfer", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            uint256 cut = value / 100;
            super._update(from, address(0xdead), cut);
            super._update(from, to, value - cut);
            return;
        }
        super._update(from, to, value);
    }
}

/// @notice Minimal WETH9.
contract MockWETH9 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "WETH: ETH transfer failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @notice Shared router behavior with configurable misbehavior modes.
abstract contract MockRouterBase {
    enum Mode {
        NORMAL,
        REVERT,
        PULL_LESS,
        LIE_ABOUT_OUTPUT,
        REENTER,
        REDIRECT_OUTPUT,
        RETURN_INPUT,
        PULL_FROM_VICTIM
    }

    Mode public mode;
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;
    address public attacker;
    address public victim;
    address public reenterTarget;
    bytes public reenterData;

    // Last call, recorded for calldata assertions.
    address public lastTokenIn;
    address public lastTokenOut;
    address public lastRecipient;
    uint256 public lastAmountIn;
    uint256 public lastAmountOutMinimum;
    uint160 public lastSqrtPriceLimitX96;
    uint256 public lastDeadline;
    address public lastCaller;
    uint256 public callCount;

    function setMode(Mode m) external {
        mode = m;
    }

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function setAttack(address attacker_, address victim_) external {
        attacker = attacker_;
        victim = victim_;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function _swap(
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96
    ) internal returns (uint256 amountOut) {
        lastTokenIn = tokenIn;
        lastTokenOut = tokenOut;
        lastRecipient = recipient;
        lastAmountIn = amountIn;
        lastAmountOutMinimum = amountOutMinimum;
        lastSqrtPriceLimitX96 = sqrtPriceLimitX96;
        lastCaller = msg.sender;
        callCount += 1;

        if (mode == Mode.REVERT) revert("router failure");
        if (mode == Mode.REENTER) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (mode == Mode.PULL_FROM_VICTIM) {
            // Tries to spend the victim's allowance to the EXECUTOR via the
            // router's own position: impossible — the router only has the
            // executor's single-use allowance, never the victim's.
            IERC20(tokenIn).transferFrom(victim, attacker, amountIn);
        }

        uint256 pulled = mode == Mode.PULL_LESS ? amountIn - 1 : amountIn;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), pulled);

        amountOut = (pulled * rateNum) / rateDen;
        require(amountOut >= amountOutMinimum, "Too little received");

        if (mode == Mode.RETURN_INPUT) {
            IERC20(tokenIn).transfer(msg.sender, 1);
        }
        if (mode == Mode.LIE_ABOUT_OUTPUT) {
            IERC20(tokenOut).transfer(recipient, amountOut / 2);
            return amountOut;
        }
        if (mode == Mode.REDIRECT_OUTPUT) {
            IERC20(tokenOut).transfer(attacker, amountOut);
            return amountOut;
        }
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}

contract MockSlipstreamRouter is MockRouterBase {
    int24 public lastTickSpacing;

    function exactInputSingle(ISlipstreamSwapRouter.ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256)
    {
        require(block.timestamp <= p.deadline, "Transaction too old");
        require(msg.value == 0, "no value expected");
        lastTickSpacing = p.tickSpacing;
        lastDeadline = p.deadline;
        return _swap(p.tokenIn, p.tokenOut, p.recipient, p.amountIn, p.amountOutMinimum, p.sqrtPriceLimitX96);
    }
}

contract MockUniswapV3Router02 is MockRouterBase {
    uint24 public lastFee;

    function exactInputSingle(IUniswapV3SwapRouter02.ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256)
    {
        require(msg.value == 0, "no value expected");
        lastFee = p.fee;
        return _swap(p.tokenIn, p.tokenOut, p.recipient, p.amountIn, p.amountOutMinimum, p.sqrtPriceLimitX96);
    }
}

/// @notice Permit2 SignatureTransfer stand-in with REAL owner-signature
///         binding (token, amount, nonce, deadline, spender). The genuine
///         Permit2 is exercised by the Base mainnet fork test and the Base
///         Sepolia deployment script.
contract MockPermit2 {
    mapping(address owner => mapping(uint256 nonce => bool used)) public nonceUsed;

    function digest(address token, uint256 amount, uint256 nonce, uint256 deadline, address spender)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(token, amount, nonce, deadline, spender));
    }

    function permitTransferFrom(
        IPermit2SignatureTransfer.PermitTransferFrom calldata permit,
        IPermit2SignatureTransfer.SignatureTransferDetails calldata details,
        address owner,
        bytes calldata signature
    ) external {
        require(block.timestamp <= permit.deadline, "SignatureExpired");
        require(details.requestedAmount <= permit.permitted.amount, "InvalidAmount");
        require(!nonceUsed[owner][permit.nonce], "InvalidNonce");
        bytes32 d = digest(permit.permitted.token, permit.permitted.amount, permit.nonce, permit.deadline, msg.sender);
        require(ECDSA.recover(d, signature) == owner, "InvalidSigner");
        nonceUsed[owner][permit.nonce] = true;
        IERC20(permit.permitted.token).transferFrom(owner, details.to, details.requestedAmount);
    }
}

/// @notice Fee recipient that tries to re-enter the executor on native receive.
///         With `bubble == false` it swallows the inner revert and records its
///         selector, so a test can prove WHICH guard stopped the re-entry.
contract ReenteringReceiver {
    address public target;
    bytes public data;
    bool public bubble;
    bool public attempted;
    bytes4 public lastRevertSelector;

    function arm(address target_, bytes calldata data_, bool bubble_) external {
        target = target_;
        data = data_;
        bubble = bubble_;
    }

    receive() external payable {
        if (target != address(0) && !attempted) {
            attempted = true;
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) {
                if (bubble) {
                    assembly {
                        revert(add(ret, 32), mload(ret))
                    }
                }
                lastRevertSelector = bytes4(ret);
            }
        }
    }
}

/// @notice Contract that rejects native ETH (e.g. a fee wallet without receive()).
contract NativeRejecter {}
