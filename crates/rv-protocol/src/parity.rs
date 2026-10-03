//! J0 target DTOs. Their schemas are shared; availability still comes from discovery.
//! Declaring a DTO does not enable an endpoint or a client capability.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The next bearer is generated securely and durably saved by the client before
/// submission. Neither this value nor a Session may be logged with Debug.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RenewSession {
    pub operation_id: String,
    pub next_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DeviceSession {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameDevice {
    pub label: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SecondFactor {
    Totp,
    Email,
    RecoveryCode,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct AuthChallenge {
    pub challenge_id: String,
    pub methods: Vec<SecondFactor>,
    pub expires_at: String,
    pub resend_after_seconds: u32,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VerifyFactor {
    pub challenge_id: String,
    pub method: SecondFactor,
    pub code: String,
}

/// Password-only sessions keep the legacy login wire format. This new endpoint
/// returns a challenge without minting any bearer when an account has a factor.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthenticationStep {
    Session {
        session: crate::Session,
    },
    Challenge {
        challenge: AuthChallenge,
        user: crate::User,
    },
}

/// Persist next_token in secure storage before submitting. A retry repeats the
/// same operation/candidate; it never creates a second session using a spent OTP.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FinishFactor {
    pub challenge_id: String,
    pub method: SecondFactor,
    pub code: String,
    pub operation_id: String,
    pub next_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BeginFactorSetup {
    pub operation_id: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct FactorSetup {
    pub setup_id: String,
    pub secret: String,
    pub provisioning_uri: String,
    pub expires_at: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EnableFactor {
    pub setup_id: String,
    pub operation_id: String,
    pub code: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct FactorBackupCodes {
    pub codes: Vec<String>,
    /// Original committed revision, also carried by the encrypted receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FactorStatus {
    pub totp: bool,
    pub email: bool,
    pub backup_codes_remaining: u32,
    pub factor_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DisableFactor {
    pub factor_version: String,
}

/// Persist the original operation/version privately before HTTP. A retry
/// recovers the same short-lived code bag on the initiating device.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegenerateFactorBackups {
    pub factor_version: String,
    pub operation_id: String,
}

/// Pin the displayed contact and installed-factor version before HTTP. The
/// original operation is retained privately for receipt recovery.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeEmailFactor {
    pub operation_id: String,
    pub email_version: String,
    pub factor_version: Option<String>,
    pub context: ReauthenticationContext,
}

/// Codes are private presentation data; never log this receipt with Debug.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct EmailFactorChange {
    pub enabled: bool,
    pub codes: Vec<String>,
    pub factor_version: String,
    pub email_version: String,
    pub context: ReauthenticationContext,
}

/// A new delivery candidate means an explicit resend. Recovery repeats the
/// same candidate/operation and does not send, mint a code or extend the OTP.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequestFactorEmail {
    pub challenge_id: String,
    pub delivery_id: String,
    pub operation_id: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct FactorEmailDelivery {
    pub expires_at: String,
    pub delivery: EmailDeliveryState,
    pub resend_after_seconds: u32,
}

/// Persist challenge_id (32 CSPRNG bytes as lowercase hex) and operation_id in
/// private storage before HTTP. Password/OTP are transient, never persisted.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BeginReauthentication {
    pub password: String,
    pub challenge_id: String,
    pub operation_id: String,
    pub proof_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ReauthenticationContext>,
}

/// Pin proof work to the authenticated account, family and server generation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReauthenticationContext {
    pub user_id: String,
    pub device_id: String,
    pub instance_id: String,
    pub data_epoch: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetireReauthentication {
    pub context: ReauthenticationContext,
    pub proof_version: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FinishReauthentication {
    pub challenge_id: String,
    pub operation_id: String,
    pub method: SecondFactor,
    pub code: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResumeReauthentication {
    pub challenge_id: String,
    pub operation_id: String,
}

/// Metadata about proof on the current family; this is never a credential.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReauthenticationGrant {
    pub user_id: String,
    pub device_id: String,
    pub instance_id: String,
    pub data_epoch: String,
    pub factor_version: String,
    pub proof_version: String,
    pub authenticated_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReauthenticationStatus {
    pub user_id: String,
    pub device_id: String,
    pub instance_id: String,
    pub data_epoch: String,
    pub proof_version: String,
    pub recent: bool,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReauthenticationStep {
    Granted { grant: ReauthenticationGrant },
    Challenge { challenge: AuthChallenge },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoomRole {
    Owner,
    Moderator,
    Member,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RoomDetails {
    pub room: crate::Room,
    /// Opaque settings / roster revision, independent from message activity.
    pub revision: String,
    pub topic: String,
    pub description: String,
    pub announcement: String,
    pub read_only: bool,
    pub member_count: u32,
    pub permissions: RoomPermissions,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RoomMember {
    pub user: crate::User,
    pub role: RoomRole,
    pub disabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RoomMemberPage {
    pub room_id: String,
    pub revision: String,
    pub members: Vec<RoomMember>,
    pub next: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateRoom {
    pub operation_id: String,
    pub expected_revision: String,
    pub name: String,
    pub private: bool,
    pub topic: String,
    pub description: String,
    pub announcement: String,
    pub read_only: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeRoomRole {
    pub operation_id: String,
    pub expected_revision: String,
    pub role: RoomRole,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LeaveRoom {
    pub operation_id: String,
    pub expected_revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct RoomCommandReceipt {
    pub operation_id: String,
    pub room_id: String,
    pub applied_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AccountPermissions {
    pub create_public_room: bool,
    pub create_private_room: bool,
    pub manage_accounts: bool,
    pub manage_instance: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct RoomPermissions {
    pub room_id: String,
    pub revision: String,
    pub role: RoomRole,
    pub read: bool,
    pub send: bool,
    pub invite: bool,
    pub remove_member: bool,
    pub change_settings: bool,
    pub pin: bool,
    pub upload: bool,
    pub start_call: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct MessagePermissions {
    pub message_id: String,
    pub revision: String,
    pub edit: bool,
    pub delete: bool,
    pub react: bool,
    pub pin: bool,
    pub star: bool,
    /// UTC deadline; None means no time limit, not permission to edit.
    pub edit_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct ReadState {
    pub room_id: String,
    /// Membership lifetime nonce, used to purge a missed withdrawal / rejoin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub membership_version: Option<String>,
    /// Independent favorite version; reading or receiving a message does not change it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite_revision: Option<String>,
    pub revision: String,
    pub root_position: String,
    pub reply_position: String,
    pub unread_roots: String,
    pub unread_replies: String,
    pub mentions: String,
    pub group_mentions: String,
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MarkRead {
    pub root_position: String,
    pub reply_position: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetRoomFavorite {
    pub operation_id: String,
    pub expected_revision: String,
    pub present: bool,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditMessage {
    pub operation_id: String,
    pub expected_revision: String,
    pub content: MessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteMessage {
    pub operation_id: String,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetReaction {
    pub operation_id: String,
    pub emoji: String,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetMark {
    pub operation_id: String,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct QuoteReference {
    pub room_id: String,
    pub message_id: String,
    pub revision: String,
}

// No Debug: an opaque encrypted payload must not be dumped in diagnostics either.
#[derive(Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MessageContent {
    Plain {
        markdown: String,
        mentions: Vec<String>,
        quotes: Vec<QuoteReference>,
        files: Vec<String>,
    },
    Encrypted {
        format: String,
        key_version: String,
        payload: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct UserProfile {
    pub user: crate::User,
    pub revision: String,
    pub bio: String,
    pub status_text: String,
    #[serde(default = "default_profile_status")]
    pub status: crate::live::PresenceStatus,
    /// Protected resource ID, never an arbitrary URL carrying credentials.
    pub avatar_file_id: Option<String>,
}

fn default_profile_status() -> crate::live::PresenceStatus {
    crate::live::PresenceStatus::Online
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct UserPreferences {
    pub revision: String,
    pub language: String,
    pub clock_24h: bool,
    pub push_enabled: bool,
    pub push_mentions_only: bool,
    #[serde(default)]
    pub desktop_notifications: crate::profiles::DesktopNotifications,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct FileDescriptor {
    pub id: String,
    pub room_id: String,
    pub bytes: String,
    pub sha256: String,
    /// For ciphertext this is a declaration, not a verified media type.
    pub media_type: String,
    /// Absent for encrypted files: the filename lives inside client ciphertext.
    pub filename: Option<String>,
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PrepareUpload {
    pub operation_id: String,
    pub room_id: String,
    pub bytes: String,
    pub sha256: String,
    pub media_type: String,
    pub filename: Option<String>,
    pub encrypted: bool,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CompleteUpload {
    pub operation_id: String,
    pub content: MessageContent,
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PublicDeviceKey {
    pub user_id: String,
    pub device_id: String,
    pub format: String,
    pub public_key: String,
    pub fingerprint: String,
    pub revision: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct EncryptedKeyBackup {
    pub user_id: String,
    pub format: String,
    pub revision: String,
    pub ciphertext: String,
    /// Legacy UID/salt and KDF parameters must survive an import unchanged.
    pub crypto_identity: String,
    pub kdf: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct RoomKeyEnvelope {
    pub room_id: String,
    pub key_version: String,
    pub recipient_user_id: String,
    pub recipient_device_id: String,
    pub sender_device_id: String,
    pub format: String,
    pub ciphertext: String,
}

/// Export root for the J0 fixture. Crypto `format` is opaque until the dedicated
/// specification/review; these types make no algorithm or trust guarantee.
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ParityContract {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_favorite: Option<SetRoomFavorite>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_details: Option<RoomDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_members: Option<RoomMemberPage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_room: Option<UpdateRoom>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_room_role: Option<ChangeRoomRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_room: Option<LeaveRoom>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_command_receipt: Option<RoomCommandReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_email_factor: Option<ChangeEmailFactor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_factor_change: Option<EmailFactorChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_factor_email: Option<RequestFactorEmail>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor_email_delivery: Option<FactorEmailDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_verified_email: Option<RemoveVerifiedEmail>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_email_removal: Option<ResumeEmailRemoval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retire_email_removal: Option<RetireEmailRemoval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_removal_receipt: Option<EmailRemovalReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_status: Option<EmailStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_email_verification: Option<BeginEmailVerification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_email_verification: Option<ResumeEmailVerification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_email_verification: Option<ConfirmEmailVerification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retire_email_verification: Option<RetireEmailVerification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_verification_step: Option<EmailVerificationStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authentication_step: Option<AuthenticationStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_factor: Option<FinishFactor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_factor_setup: Option<BeginFactorSetup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor_setup: Option<FactorSetup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_factor: Option<EnableFactor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor_backup_codes: Option<FactorBackupCodes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor_status: Option<FactorStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_factor: Option<DisableFactor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regenerate_factor_backups: Option<RegenerateFactorBackups>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_reauthentication: Option<BeginReauthentication>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reauthentication: Option<FinishReauthentication>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_reauthentication: Option<ResumeReauthentication>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retire_reauthentication: Option<RetireReauthentication>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reauthentication_step: Option<ReauthenticationStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reauthentication_grant: Option<ReauthenticationGrant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reauthentication_status: Option<ReauthenticationStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recover_account: Option<RecoverAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_email_recovery: Option<RequestEmailRecovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_recovery_requested: Option<EmailRecoveryRequested>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_invitation: Option<AcceptInvitation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renew_session: Option<RenewSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_session: Option<DeviceSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename_device: Option<RenameDevice>,
    pub auth_challenge: AuthChallenge,
    pub verify_factor: VerifyFactor,
    pub account_permissions: AccountPermissions,
    pub room_permissions: RoomPermissions,
    pub message_permissions: MessagePermissions,
    pub read_state: ReadState,
    pub mark_read: MarkRead,
    pub edit_message: EditMessage,
    pub delete_message: DeleteMessage,
    pub reaction: SetReaction,
    pub mark: SetMark,
    pub profile: UserProfile,
    pub preferences: UserPreferences,
    pub file: FileDescriptor,
    pub prepare_upload: PrepareUpload,
    pub complete_upload: CompleteUpload,
    pub public_device_key: PublicDeviceKey,
    pub key_backup: EncryptedKeyBackup,
    pub room_key_envelope: RoomKeyEnvelope,
}

/// Creating an account does not authenticate it; normal login follows, including
/// any required second factor. Invitation/password are transient secrets.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AcceptInvitation {
    pub token: String,
    pub username: String,
    pub password: String,
}

/// Operator code resets login credentials; it never recovers E2EE keys or
/// authenticates the account in place of its normal second-factor login.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoverAccount {
    pub token: String,
    pub username: String,
    pub new_password: String,
}

/// Anonymous delivery request. Save the random operation before HTTP. No
/// address, UID, delivery status or recovery credential is returned publicly.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequestEmailRecovery {
    pub operation_id: String,
    pub username: String,
    pub instance_id: String,
    pub data_epoch: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmailRecoveryRequested {
    pub accepted: bool,
}

// Email and operation candidates are private, never part of User/room profiles.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct EmailStatus {
    pub address: Option<String>,
    pub verified_at: Option<String>,
    pub version: String,
    pub verification_version: String,
    pub context: ReauthenticationContext,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BeginEmailVerification {
    pub address: String,
    pub verification_id: String,
    pub operation_id: String,
    pub expected_version: String,
    pub verification_version: String,
    pub context: ReauthenticationContext,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResumeEmailVerification {
    pub verification_id: String,
    pub operation_id: String,
    pub context: ReauthenticationContext,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfirmEmailVerification {
    pub verification_id: String,
    pub operation_id: String,
    pub code: String,
    pub context: ReauthenticationContext,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetireEmailVerification {
    pub expected_version: String,
    pub verification_version: String,
    pub context: ReauthenticationContext,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EmailVerificationStep {
    Pending {
        verification_id: String,
        operation_id: String,
        address: String,
        expires_at: String,
        expected_version: String,
        verification_version: String,
        delivery: EmailDeliveryState,
    },
    Verified {
        address: String,
        version: String,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EmailDeliveryState {
    Queued,
    Sending,
    Deferred,
    Accepted,
    Exhausted,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RemoveVerifiedEmail {
    pub operation_id: String,
    pub expected_version: String,
    pub verification_version: String,
    pub context: ReauthenticationContext,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResumeEmailRemoval {
    pub operation_id: String,
    pub context: ReauthenticationContext,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetireEmailRemoval {
    pub expected_version: String,
    pub verification_version: String,
    pub context: ReauthenticationContext,
}
/// A removal receipt never returns the former private address or a credential.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct EmailRemovalReceipt {
    pub version: String,
    pub verification_version: String,
    pub context: ReauthenticationContext,
}
