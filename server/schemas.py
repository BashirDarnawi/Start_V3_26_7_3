from pydantic import BaseModel, EmailStr, Field
from typing import Any, Literal, Optional


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class UserPublic(BaseModel):
    id: str
    name: str
    email: EmailStr
    role: str
    permissions: dict[str, list[str]] = Field(default_factory=dict)


class LoginResponse(BaseModel):
    user: UserPublic


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirmRequest(BaseModel):
    token: str = Field(min_length=1, max_length=256)
    newPassword: str = Field(min_length=8, max_length=256)


class ChangePasswordRequest(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=256)
    newPassword: str = Field(min_length=8, max_length=256)


class CreateUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    role: str = Field(min_length=1, max_length=20)
    permissions: Optional[dict[str, list[str]]] = None


class SetupAdminRequest(BaseModel):
    """First-run creation of the very first Admin, straight from the browser.

    The endpoint is a no-op once ANY user exists, so it cannot be used to
    add admins after setup — it exists only to bootstrap a fresh server
    without needing shell/SSH access."""
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    setupToken: Optional[str] = Field(default=None, max_length=256)


class UpdateUserRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    email: Optional[EmailStr] = None
    password: Optional[str] = Field(default=None, min_length=8, max_length=256)
    role: Optional[str] = Field(default=None, min_length=1, max_length=20)
    permissions: Optional[dict[str, list[str]]] = None
    deleted: Optional[bool] = None


class EntityCreateRequest(BaseModel):
    id: Optional[str] = Field(default=None, max_length=80)
    data: dict[str, Any]


class EntityUpdateRequest(BaseModel):
    data: dict[str, Any]
    expectedLastModified: Optional[int] = None


class CustomerMergeRequest(BaseModel):
    """Admin-confirmed consolidation of two records for the same person."""

    keepCustomerId: str = Field(min_length=1, max_length=80)
    duplicateCustomerId: str = Field(min_length=1, max_length=80)
    expectedKeepLastModified: int = Field(ge=0)
    expectedDuplicateLastModified: int = Field(ge=0)
    idempotencyKey: str = Field(min_length=8, max_length=120)


class WalletTransferRequest(BaseModel):
    """Server-authoritative wallet transfer.

    Amounts are always integer minor units.  An idempotency key is mandatory
    so a client retry cannot charge the sender twice.
    """

    toUserId: str = Field(min_length=1, max_length=80)
    amountMinor: int = Field(gt=0, le=1_000_000_000_000)
    currency: Literal["LYD", "USD", "EUR"]
    idempotencyKey: str = Field(min_length=8, max_length=120)
    memo: Optional[str] = Field(default=None, max_length=180)


class WalletTopUpRequest(BaseModel):
    """Admin-only credit recorded after receiving funds outside the app."""

    userId: str = Field(min_length=1, max_length=80)
    amountMinor: int = Field(gt=0, le=1_000_000_000_000)
    currency: Literal["LYD", "USD", "EUR"]
    idempotencyKey: str = Field(min_length=8, max_length=120)
    memo: Optional[str] = Field(default=None, max_length=180)


class WalletReversalRequest(BaseModel):
    """Admin-only compensating entry for an immutable ledger row."""

    transactionId: str = Field(min_length=1, max_length=80)
    memo: Optional[str] = Field(default=None, max_length=180)


class SubscriptionPurchaseRequest(BaseModel):
    """Purchase a catalog service using server-owned price and duration."""

    serviceId: str = Field(min_length=1, max_length=80)
    idempotencyKey: str = Field(min_length=8, max_length=120)
    userId: Optional[str] = Field(default=None, min_length=1, max_length=80)


class ClothesOrderMutationRequest(BaseModel):
    """One idempotent, transactional order + inventory operation."""

    action: Literal["create", "update", "status", "payment", "delete"]
    idempotencyKey: str = Field(min_length=8, max_length=120)
    orderId: Optional[str] = Field(default=None, min_length=1, max_length=80)
    expectedLastModified: Optional[int] = None
    status: Optional[str] = Field(default=None, max_length=40)
    paymentStatus: Optional[str] = Field(default=None, max_length=40)
    data: dict[str, Any] = Field(default_factory=dict)


class ClothesShipmentMutationRequest(BaseModel):
    """One idempotent shipment status/delete operation with inventory."""

    action: Literal["status", "delete"]
    idempotencyKey: str = Field(min_length=8, max_length=120)
    shipmentId: str = Field(min_length=1, max_length=80)
    expectedLastModified: int
    status: Optional[str] = Field(default=None, max_length=40)


class ReceiptTransferRequest(BaseModel):
    """Move already-paid receipt credit without minting or losing money."""

    sourceReceiptId: str = Field(min_length=1, max_length=80)
    targetCustomerId: str = Field(min_length=1, max_length=80)
    targetReceiptId: str = Field(min_length=1, max_length=80)
    amountMinorUSD: int = Field(gt=0, le=1_000_000_000)
    idempotencyKey: str = Field(min_length=8, max_length=120)
    expectedSourceLastModified: int = Field(ge=0)
    note: Optional[str] = Field(default=None, max_length=500)


class ReceiptSettlementRequest(BaseModel):
    """Mark a receipt paid and settle every linked ad in one transaction."""

    idempotencyKey: str = Field(min_length=8, max_length=120)
    expectedLastModified: int = Field(ge=0)
    data: dict[str, Any] = Field(default_factory=dict)


class AdMutationRequest(BaseModel):
    """Create/update an ad and its receipt funding in one transaction."""

    action: Literal["create", "update"]
    adId: str = Field(min_length=1, max_length=80)
    idempotencyKey: str = Field(min_length=8, max_length=120)
    expectedLastModified: Optional[int] = Field(default=None, ge=0)
    data: dict[str, Any] = Field(default_factory=dict)


class AdStopRequest(BaseModel):
    """Server-authoritative ad stop/re-stop request, expressed in USD cents."""

    spentMinorUSD: int = Field(ge=0, le=1_000_000_000)
    customerInformed: bool = False
    idempotencyKey: str = Field(min_length=8, max_length=120)
    expectedLastModified: int = Field(ge=0)


class AdCampaignSubmitRequest(BaseModel):
    """Optimistic-concurrency guard for a customer campaign submission."""

    expectedLastModified: int = Field(ge=0)
    operationId: str = Field(min_length=8, max_length=120)


class AdCampaignReviewRequest(BaseModel):
    """Server-controlled review transition; it never publishes a Meta ad."""

    expectedLastModified: int = Field(ge=0)
    decision: Literal["Approved", "Changes Requested", "Rejected"]
    note: Optional[str] = Field(default=None, max_length=2000)
    operationId: str = Field(min_length=8, max_length=120)


class AdminBulkImportRequest(BaseModel):
    """
    Transactional whole-backup import (admin only).

    Every listed collection is REPLACED in one database transaction:
    - records marked _deleted (or absent from the backup) are soft-deleted
    - all other records are upserted with their backup content
    A failure anywhere rolls back everything — the server can never be left
    half backup / half current data (which the old per-record flow allowed).
    """

    collections: dict[str, list[dict[str, Any]]]


class BatchDeleteItem(BaseModel):
    collection: str = Field(min_length=1, max_length=40)
    id: str = Field(min_length=1, max_length=80)


class BatchDeleteRequest(BaseModel):
    """
    Soft-delete several entities in ONE transaction (all-or-nothing).
    Used by cascade deletes (customer + receipts + ads + linked transfer
    receipts) so a flaky connection cannot leave a cascade half-applied.
    """

    items: list[BatchDeleteItem] = Field(min_length=1, max_length=500)


class AdminRestoreEntityRequest(BaseModel):
    """
    Admin-only restore/replace of an entity with optional metadata.

    This is used by the backup/restore flow to achieve a deterministic restore:
    - Replaces the entire stored data_json (no merge semantics).
    - Can preserve createdAt/createdBy/lastModified from the backup.
    """

    data: dict[str, Any]
    createdAt: Optional[int] = None
    createdBy: Optional[str] = None
    lastModified: Optional[int] = None
    deleted: Optional[bool] = None


class EntityResponse(BaseModel):
    id: str
    type: str
    deleted: bool
    createdAt: int
    createdBy: Optional[str] = None
    lastModified: int
    data: dict[str, Any]


class CustomerMergeResponse(BaseModel):
    customer: EntityResponse
    updatedPages: list[EntityResponse] = Field(default_factory=list)
    updatedReceipts: list[EntityResponse] = Field(default_factory=list)
    updatedAds: list[EntityResponse] = Field(default_factory=list)
    duplicate: EntityResponse
    replayed: bool = False


class ClothesOrderMutationResponse(BaseModel):
    order: EntityResponse
    updatedProducts: list[EntityResponse] = Field(default_factory=list)
    replayed: bool = False


class ClothesShipmentMutationResponse(BaseModel):
    shipment: EntityResponse
    updatedProducts: list[EntityResponse] = Field(default_factory=list)
    replayed: bool = False


class ReceiptTransferResponse(BaseModel):
    sourceReceipt: EntityResponse
    targetReceipt: EntityResponse
    transfer: dict[str, Any]
    replayed: bool = False


class ReceiptSettlementResponse(BaseModel):
    receipt: EntityResponse
    updatedAds: list[EntityResponse] = Field(default_factory=list)
    replayed: bool = False


class AdMutationResponse(BaseModel):
    ad: EntityResponse
    replayed: bool = False


class AdStopResponse(BaseModel):
    ad: EntityResponse
    replayed: bool = False


class BootstrapResponse(BaseModel):
    user: UserPublic
    ads: list[dict[str, Any]] = Field(default_factory=list)
    receipts: list[dict[str, Any]] = Field(default_factory=list)
    customers: list[dict[str, Any]] = Field(default_factory=list)
    pages: list[dict[str, Any]] = Field(default_factory=list)
    exchangeRateHistory: list[dict[str, Any]] = Field(default_factory=list)
    logs: list[dict[str, Any]] = Field(default_factory=list)
