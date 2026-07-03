from pydantic import BaseModel, EmailStr, Field
from typing import Any, Optional


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


class BootstrapResponse(BaseModel):
    user: UserPublic
    ads: list[dict[str, Any]] = Field(default_factory=list)
    receipts: list[dict[str, Any]] = Field(default_factory=list)
    customers: list[dict[str, Any]] = Field(default_factory=list)
    pages: list[dict[str, Any]] = Field(default_factory=list)
    exchangeRateHistory: list[dict[str, Any]] = Field(default_factory=list)
    logs: list[dict[str, Any]] = Field(default_factory=list)


