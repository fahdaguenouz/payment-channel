// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract PaymentChannel {
    enum StateChannel { EMPTY, ACTIVE, CLOSING, CLOSED }

    address public immutable partA;
    address public immutable partB;
    IERC20 public immutable token;
    uint256 public immutable amount;
    StateChannel public state;
    uint256 public closingBlock;
    uint256 public Nonce;
    uint256 public balanceA;
    uint256 public balanceB;

    uint256 public funded;
    mapping(address => uint256) public contributions;

    event Funded(address indexed party, uint256 value, uint256 total);
    event Closing(uint256 indexed nonce, uint256 balanceA, uint256 balanceB, uint256 closingBlock);
    event Challenged(address indexed challenger, uint256 indexed nonce);
    event Withdrawn(address indexed party, uint256 value);

    modifier onlyParty() {
        require(msg.sender == partA || msg.sender == partB, "not a party");
        _;
    }

    constructor(address tokenAddress, uint256 channelAmount, address partyA, address partyB) {
        require(tokenAddress != address(0), "zero token");
        require(partyA != address(0) && partyB != address(0) && partyA != partyB, "bad parties");
        require(channelAmount > 0, "zero amount");
        token = IERC20(tokenAddress);
        amount = channelAmount;
        partA = partyA;
        partB = partyB;
        state = StateChannel.EMPTY;
    }

    function fund(uint256 value) external onlyParty {
        require(state == StateChannel.EMPTY, "not fundable");
        require(value > 0 && funded + value <= amount, "bad amount");
        require(token.transferFrom(msg.sender, address(this), value), "transfer failed");
        funded += value;
        contributions[msg.sender] += value;
        if (msg.sender == partA) balanceA += value;
        else balanceB += value;
        emit Funded(msg.sender, value, funded);
        if (funded == amount) state = StateChannel.ACTIVE;
    }

    function message(uint256 nonce_, uint256 balanceA_, uint256 balanceB_) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(nonce_, balanceA_, balanceB_));
    }

    function closing(uint256 nonce_, uint256 balanceA_, uint256 balanceB_, bytes calldata signature) external onlyParty {
        require(state == StateChannel.ACTIVE, "not active");
        _validateState(nonce_, balanceA_, balanceB_);
        address other = msg.sender == partA ? partB : partA;
        require(_recover(_ethSigned(message(nonce_, balanceA_, balanceB_)), signature) == other, "invalid signature");
        Nonce = nonce_;
        balanceA = balanceA_;
        balanceB = balanceB_;
        closingBlock = block.number;
        state = StateChannel.CLOSING;
        emit Closing(nonce_, balanceA_, balanceB_, closingBlock);
    }

    function challenge(uint256 nonce_, uint256 balanceA_, uint256 balanceB_, bytes calldata signature) external onlyParty {
        require(state == StateChannel.CLOSING, "not closing");
        require(block.number < closingBlock + 24, "challenge period over");
        require(nonce_ > Nonce, "nonce not newer");
        _validateState(nonce_, balanceA_, balanceB_);
        address other = msg.sender == partA ? partB : partA;
        require(_recover(_ethSigned(message(nonce_, balanceA_, balanceB_)), signature) == other, "invalid signature");

        Nonce = nonce_;
        state = StateChannel.CLOSED;
        balanceA = msg.sender == partA ? amount : 0;
        balanceB = msg.sender == partB ? amount : 0;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Challenged(msg.sender, nonce_);
        emit Withdrawn(msg.sender, amount);
    }

    function withdraw() external onlyParty {
        require(state == StateChannel.CLOSING || state == StateChannel.CLOSED, "not closing");
        require(block.number >= closingBlock + 24, "challenge period active");
        state = StateChannel.CLOSED;
        uint256 valueA = balanceA;
        uint256 valueB = balanceB;
        balanceA = 0;
        balanceB = 0;
        if (valueA > 0) require(token.transfer(partA, valueA), "transfer A failed");
        if (valueB > 0) require(token.transfer(partB, valueB), "transfer B failed");
        emit Withdrawn(partA, valueA);
        emit Withdrawn(partB, valueB);
    }

    function _validateState(uint256 nonce_, uint256 balanceA_, uint256 balanceB_) internal view {
        require(balanceA_ + balanceB_ == amount, "balances mismatch");
        require(nonce_ >= Nonce, "old nonce");
    }

    function _ethSigned(bytes32 digest) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad recovery id");
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, "bad signature s");
        return ecrecover(digest, v, r, s);
    }
}
