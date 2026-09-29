// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Testnet-only, single final delivery with explicit buyer approval.
/// Amounts inside Hedera's EVM are TINYBARS, not the 18-decimal RPC value.
/// No admin, fee, automatic release, upgrade, or claim of off-chain file quality.
contract DeliverProof {
    enum State { Missing, Draft, Funded, Submitted, Approved, Refunded }
    struct Agreement {
        address buyer;
        address supplier;
        uint64 amountTinybar;
        uint64 deliveryDeadline;
        uint64 reviewDeadline;
        bytes32 termsHash;
        State state;
        bytes32 commitment;
        string cid;
        bytes32 fileSha256;
        uint64 fileSize;
        uint8 mediaType; // 1 text/plain, 2 application/json, 3 application/pdf
        bool withdrawn;
    }

    bytes32 public constant DOMAIN = keccak256("DeliverProof.delivery.v1");
    uint64 public constant MAX_AMOUNT_TINYBAR = 1_000_000_000; // 10 test HBAR
    uint64 public constant MAX_FILE_BYTES = 1_048_576;
    uint256 public nextId = 1;
    uint256 public totalLocked;
    uint256 public totalCredits;
    mapping(uint256 => Agreement) private agreements;
    uint256 private entered;

    error UnsupportedChain();
    error InvalidTerms();
    error UnknownAgreement();
    error Unauthorized();
    error WrongState();
    error DeadlinePassed();
    error RefundNotAvailable();
    error WrongAmount();
    error InvalidDelivery();
    error WrongCommitment();
    error AlreadyWithdrawn();
    error TransferFailed();
    error ReentrantCall();
    error DirectPaymentRejected();

    event Created(uint256 indexed id, address indexed buyer, address indexed supplier,
        uint64 amountTinybar, uint64 deliveryDeadline, uint64 reviewDeadline, bytes32 termsHash);
    event Funded(uint256 indexed id, uint64 amountTinybar);
    event Submitted(uint256 indexed id, bytes32 indexed commitment, string cid,
        bytes32 fileSha256, uint64 fileSize, uint8 mediaType, uint32 version);
    event Approved(uint256 indexed id, bytes32 indexed commitment);
    event Refunded(uint256 indexed id, address indexed initiator);
    event CreditAvailable(uint256 indexed id, address indexed beneficiary, uint64 amountTinybar);
    event Withdrawn(uint256 indexed id, address indexed beneficiary, uint64 amountTinybar);

    constructor() {
        if (block.chainid != 296 && block.chainid != 31337) revert UnsupportedChain();
    }
    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    function createAgreement(address supplier, uint64 amountTinybar,
        uint64 deliveryDeadline, uint64 reviewDeadline, bytes32 termsHash)
        external nonReentrant returns (uint256 id)
    {
        if (supplier == address(0) || supplier == msg.sender || supplier == address(this)
            || amountTinybar == 0 || amountTinybar > MAX_AMOUNT_TINYBAR
            || deliveryDeadline <= block.timestamp || reviewDeadline <= deliveryDeadline
            || termsHash == bytes32(0)) revert InvalidTerms();
        id = nextId++;
        Agreement storage a = agreements[id];
        a.buyer = msg.sender;
        a.supplier = supplier;
        a.amountTinybar = amountTinybar;
        a.deliveryDeadline = deliveryDeadline;
        a.reviewDeadline = reviewDeadline;
        a.termsHash = termsHash;
        a.state = State.Draft;
        emit Created(id, msg.sender, supplier, amountTinybar, deliveryDeadline, reviewDeadline, termsHash);
    }

    function getAgreement(uint256 id) external view returns (Agreement memory) {
        return existing(id);
    }

    function fund(uint256 id) external payable nonReentrant {
        Agreement storage a = existing(id);
        if (msg.sender != a.buyer) revert Unauthorized();
        if (a.state != State.Draft) revert WrongState();
        if (block.timestamp > a.deliveryDeadline) revert DeadlinePassed();
        if (msg.value != a.amountTinybar) revert WrongAmount();
        a.state = State.Funded;
        totalLocked += msg.value;
        emit Funded(id, a.amountTinybar);
    }

    function submit(uint256 id, string calldata cid, bytes32 fileSha256,
        uint64 fileSize, uint8 mediaType) external nonReentrant
    {
        Agreement storage a = existing(id);
        if (msg.sender != a.supplier) revert Unauthorized();
        if (a.state != State.Funded) revert WrongState();
        if (block.timestamp > a.deliveryDeadline) revert DeadlinePassed();
        bytes memory c = bytes(cid);
        if (c.length < 10 || c.length > 96 || c[0] != bytes1("b")
            || fileSha256 == bytes32(0) || fileSize == 0 || fileSize > MAX_FILE_BYTES
            || mediaType < 1 || mediaType > 3) revert InvalidDelivery();
        // CIDv1 base32 only; codec/multihash/DAG are checked by the independent verifier.
        for (uint256 i = 1; i < c.length; ++i) {
            if (!((c[i] >= 0x61 && c[i] <= 0x7a) || (c[i] >= 0x32 && c[i] <= 0x37))) {
                revert InvalidDelivery();
            }
        }
        a.cid = cid;
        a.fileSha256 = fileSha256;
        a.fileSize = fileSize;
        a.mediaType = mediaType;
        a.commitment = keccak256(abi.encode(DOMAIN, block.chainid, address(this), id,
            a.termsHash, keccak256(c), fileSha256, fileSize, mediaType, uint32(1)));
        a.state = State.Submitted;
        emit Submitted(id, a.commitment, cid, fileSha256, fileSize, mediaType, 1);
    }

    function approve(uint256 id, bytes32 expectedCommitment) external nonReentrant {
        Agreement storage a = existing(id);
        if (msg.sender != a.buyer) revert Unauthorized();
        if (a.state != State.Submitted) revert WrongState();
        if (block.timestamp > a.reviewDeadline) revert DeadlinePassed();
        if (expectedCommitment != a.commitment) revert WrongCommitment();
        a.state = State.Approved;
        releaseCredit(a);
        emit Approved(id, expectedCommitment);
        emit CreditAvailable(id, a.supplier, a.amountTinybar);
    }

    /// Supplier may refund voluntarily. Buyer may refund strictly AFTER reviewDeadline.
    /// A refund creates credit; actual transfer is a separate withdraw transaction.
    function refund(uint256 id) external nonReentrant {
        Agreement storage a = existing(id);
        if (a.state != State.Funded && a.state != State.Submitted) revert WrongState();
        if (msg.sender != a.supplier && msg.sender != a.buyer) revert Unauthorized();
        if (msg.sender == a.buyer && block.timestamp <= a.reviewDeadline) revert RefundNotAvailable();
        a.state = State.Refunded;
        releaseCredit(a);
        emit Refunded(id, msg.sender);
        emit CreditAvailable(id, a.buyer, a.amountTinybar);
    }

    function withdraw(uint256 id) external nonReentrant {
        Agreement storage a = existing(id);
        if (a.state != State.Approved && a.state != State.Refunded) revert WrongState();
        address beneficiary = a.state == State.Approved ? a.supplier : a.buyer;
        if (msg.sender != beneficiary) revert Unauthorized();
        if (a.withdrawn) revert AlreadyWithdrawn();
        a.withdrawn = true;
        totalCredits -= a.amountTinybar;
        (bool ok,) = payable(beneficiary).call{value: a.amountTinybar}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(id, beneficiary, a.amountTinybar);
    }

    function releaseCredit(Agreement storage a) private {
        totalLocked -= a.amountTinybar;
        totalCredits += a.amountTinybar;
    }
    function existing(uint256 id) private view returns (Agreement storage a) {
        a = agreements[id];
        if (a.state == State.Missing) revert UnknownAgreement();
    }
    receive() external payable { revert DirectPaymentRejected(); }
    fallback() external payable { revert DirectPaymentRejected(); }
}
