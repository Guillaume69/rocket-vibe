// Generated from crates/rv-protocol. Run scripts/generate-native-protocol.mjs.
export type AcceptInvitation = { "password": string; "token": string; "username": string; };
export type AccountPermissions = { "create_bot"?: boolean; "create_private_room": boolean; "create_public_room": boolean; "manage_accounts": boolean; "manage_instance": boolean; };
export type AdminContract = { "create_emoji": CreateEmoji; "delete_user": DeleteAdminUser; "icon_command": IconCommand; "instance_icon": InstanceIcon; "operation": AdminOperation; "overview": AdminOverview; "remove_emoji": RemoveEmoji; "report": ReportInput; "reported_messages": AdminReportedMessagePage; "reported_users": AdminReportedUserPage; "room_page": AdminRoomPage; "update_user": UpdateAdminUser; "user_page": AdminUserPage; };
export type AdminMessageCounts = { "direct": number; "encrypted": number; "private": number; "public": number; "total": number; };
export type AdminOperation = { "operation_id": string; };
export type AdminOverview = { "data_epoch": string; "instance_id": string; "messages": AdminMessageCounts; "migration_version"?: string | null; "postgres_version": string; "reports": AdminReportCounts; "rooms": AdminRoomCounts; "server_version": string; "started_at": string; "uploads": AdminUploadCounts; "users": AdminUserCounts; };
export type AdminReport = { "created_at": string; "reason": string; "reporter": User; };
export type AdminReportCounts = { "messages": number; "users": number; };
export type AdminReportedMessage = { "author": User; "author_revision"?: string | null; "created_at": string; "deleted": boolean; "latest_report_at": string; "message_id": string; "report_count": number; "reports": (AdminReport)[]; "room_id": string; "room_kind": RoomKind; "room_name": string; "text": string; };
export type AdminReportedMessagePage = { "items": (AdminReportedMessage)[]; "next"?: string | null; };
export type AdminReportedUser = { "latest_report_at": string; "report_count": number; "reports": (AdminReport)[]; "user": AdminUser; };
export type AdminReportedUserPage = { "items": (AdminReportedUser)[]; "next"?: string | null; };
export type AdminRoom = { "created_at"?: string | null; "direct_members"?: (User)[]; "encrypted": boolean; "id": string; "kind": RoomKind; "last_message_at"?: string | null; "member_count": number; "message_count": number; "name": string; "read_only": boolean; "topic"?: string | null; };
export type AdminRoomCounts = { "direct": number; "encrypted": number; "private": number; "public": number; "total": number; };
export type AdminRoomPage = { "items": (AdminRoom)[]; "next"?: string | null; };
export type AdminUploadCounts = { "bytes": number; "count": number; };
export type AdminUser = { "admin": boolean; "avatar_file_id"?: string | null; "bot"?: boolean; "created_at"?: string | null; "disabled": boolean; "display_name": string; "id": string; "last_seen_at"?: string | null; "revision": string; "status": PresenceStatus; "username": string; };
export type AdminUserCounts = { "active": number; "admins": number; "away": number; "busy": number; "deactivated": number; "offline": number; "online": number; "total": number; };
export type AdminUserPage = { "items": (AdminUser)[]; "next"?: string | null; };
export type AnswerForm = { "answers": {  }; "operation_id": string; };
export type AnswerRing = { "data_epoch": string; "e2ee"?: boolean; "membership_version": string; };
export type ApiError = { "code": string; "request_id": string; };
export type ApplicationCancellation = { "fingerprint": string; "header": string; "operation_id": string; "room_id": string; "scope": Scope; };
export type ApplicationMessage = { "ciphertext": string; "proof": string; "receipt": ApplicationReceipt; };
export type ApplicationReceipt = { "fingerprint": string; "header": string; "message_id": string; "operation_id": string; "position": string; "room_id": string; "scope": Scope; };
export type ApplicationSettlement = { "data": ApplicationReceipt; "kind": "accepted"; } | { "data": ApplicationCancellation; "kind": "cancelled"; };
export type ApplicationSubmission = { "ciphertext": string; "operation_id": string; "proof": string; "scope": Scope; };
export type AuthChallenge = { "challenge_id": string; "expires_at": string; "methods": (SecondFactor)[]; "resend_after_seconds": number; };
export type AuthenticationStep = { "kind": "session"; "session": Session; } | { "challenge": AuthChallenge; "kind": "challenge"; "user": User; };
export type AvailableKeyPackage = { "device_id": string; "incarnation": string; "reference": string; "scope": Scope; "user_id": string; "wire": string; };
export type AvatarCommand = { "expected_revision": string; "operation_id": string; };
export type BeginEmailVerification = { "address": string; "context": ReauthenticationContext; "expected_version": string; "operation_id": string; "verification_id": string; "verification_version": string; };
export type BeginFactorSetup = { "operation_id": string; };
export type BeginReauthentication = { "challenge_id": string; "context"?: ReauthenticationContext | null; "operation_id": string; "password": string; "proof_version": string; };
export type Bot = { "avatar_file_id"?: string | null; "created_at": string; "description": string; "disabled": boolean; "live_keys": number; "owner": User; "scopes": (BotScope)[]; "user": User; };
export type BotKey = { "created_at": string; "expires_at"?: string | null; "hint": string; "id": string; "label": string; "last_used_at"?: string | null; };
export type BotKeyCreated = { "info": BotKey; "key": string; };
export type BotKeyList = { "keys": (BotKey)[]; };
export type BotList = { "bots": (Bot)[]; };
export type BotReference = { "direct_per_minute": number; "groups": (BotScopeRoutes)[]; "key_prefix": string; "sends_per_minute": number; };
export type BotRoute = { "also"?: (BotScope)[]; "method": string; "path": string; };
export type BotScope = "rooms:read" | "messages:write" | "files:write" | "reactions:write" | "rooms:join" | "users:read" | "dm:write";
export type BotScopeRoutes = { "routes": (BotRoute)[]; "scope"?: BotScope | null; };
export type BotsContract = { "bot": Bot; "bot_key": BotKey; "bot_key_created": BotKeyCreated; "bot_key_list": BotKeyList; "bot_list": BotList; "bot_reference": BotReference; "create_bot": CreateBot; "create_bot_key": CreateBotKey; "instance_settings": InstanceSettings; "update_bot": UpdateBot; "update_instance_settings": UpdateInstanceSettings; };
export type CallSummary = { "duration_seconds"?: number | null; "state": RingState; };
export type Capabilities = { "account_invitations"?: boolean; "account_recovery"?: boolean; "administration"?: boolean; "bots"?: boolean; "calls": boolean; "custom_emoji_admin"?: boolean; "custom_emojis"?: boolean; "deletion"?: boolean; "device_sessions"?: boolean; "direct_messages": boolean; "durable_sync": boolean; "e2ee": boolean; "editing"?: boolean; "email_factor_delivery"?: boolean; "email_factors"?: boolean; "email_recovery"?: boolean; "email_removal"?: boolean; "email_verification"?: boolean; "favorites"?: boolean; "fine_permissions"?: boolean; "idempotent_room_creation"?: boolean; "instance_icon"?: boolean; "link_previews"?: boolean; "pins"?: boolean; "presence"?: boolean; "private_rooms": boolean; "profile_avatars"?: boolean; "profiles"?: boolean; "push": boolean; "quotes"?: boolean; "reactions": boolean; "read_markers"?: boolean; "reauthentication"?: boolean; "reauthentication_retirement"?: boolean; "reports"?: boolean; "room_discovery"?: boolean; "room_info"?: boolean; "room_leave"?: boolean; "room_roles"?: boolean; "room_settings"?: boolean; "search"?: boolean; "second_factors"?: boolean; "session_rotation"?: boolean; "slash_commands"?: boolean; "snapshot_paging"?: boolean; "stars"?: boolean; "structured_cards"?: boolean; "text_messages": boolean; "threads": boolean; "typing"?: boolean; "uploads": boolean; "voice"?: boolean; "workflows"?: boolean; };
export type CardField = { "short"?: boolean; "title": string; "value": string; };
export type Change = { "data": Room; "type": "room_upsert"; } | { "data": Message; "type": "message_upsert"; } | { "data": { "room_id": string; }; "type": "room_removed"; };
export type ChangeEmailFactor = { "context": ReauthenticationContext; "email_version": string; "factor_version"?: string | null; "operation_id": string; };
export type ChangeRoomRole = { "expected_revision": string; "operation_id": string; "role": RoomRole; };
export type CommandList = { "commands": (SlashCommand)[]; };
export type CommitHistoryShare = { "scope": Scope; "share": string; };
export type CompleteUpload = { "content": MessageContent; "operation_id": string; "reply_to"?: string | null; };
export type ConfirmEmailVerification = { "code": string; "context": ReauthenticationContext; "operation_id": string; "verification_id": string; };
export type CreateBot = { "description"?: string; "display_name": string; "operation_id": string; "scopes"?: (BotScope)[]; "username": string; };
export type CreateBotKey = { "expires_in_days"?: number | null; "label": string; "operation_id": string; };
export type CreateEmoji = { "aliases"?: string; "operation_id": string; };
export type CreateRoom = { "name": string; "operation_id"?: string | null; "private": boolean; "voice"?: boolean; };
export type CreateWorkflow = { "bot_id": string; "description"?: string; "enabled"?: boolean; "name": string; "operation_id": string; "steps": (Step)[]; "trigger": Trigger; };
export type CustomEmoji = { "aliases": (string)[]; "bytes": string; "file_id": string; "id": string; "media_type": string; "name": string; "revision": string; "sha256": string; };
export type DeleteAdminUser = { "operation_id": string; "revision": string; };
export type DeleteMessage = { "expected_revision": string; "operation_id": string; };
export type DeliveryContent = { "data": GroupEvent; "kind": "group"; } | { "data": ApplicationMessage; "kind": "message"; };
export type DeliveryEvent = { "content": DeliveryContent; "position": string; };
export type DeliveryPage = { "after": string; "events": (DeliveryEvent)[]; "incarnation": string; "next"?: string | null; "room_id": string; "scope": Scope; "through": string; };
export type DesktopNotifications = "default" | "all" | "mention" | "nothing";
export type Device = { "certificate": string; "device_id": string; "expires_at": string; "incarnation": string; "revision": string; };
export type DeviceSession = { "created_at": string; "current": boolean; "expires_at": string; "id": string; "label": string; "last_seen_at": string; };
export type DirectMessage = { "user_id": string; };
export type Directory = { "devices": (Device)[]; "identity"?: Identity | null; "next_revocation"?: string | null; "revocations": (Revocation)[]; "scope": Scope; };
export type DisableFactor = { "factor_version": string; };
export type Discovery = { "api_path": string; "capabilities": Capabilities; "data_epoch": string; "icon_revision"?: string | null; "instance_id": string; "product": string; "protocol_versions": (number)[]; "server_version": string; };
export type Document = { "format": Format; "nodes": (Node)[]; };
export type EditMessage = { "content": MessageContent; "expected_revision": string; "operation_id": string; };
export type EmailDeliveryState = "queued" | "sending" | "deferred" | "accepted" | "exhausted";
export type EmailFactorChange = { "codes": (string)[]; "context": ReauthenticationContext; "email_version": string; "enabled": boolean; "factor_version": string; };
export type EmailRecoveryRequested = { "accepted": boolean; };
export type EmailRemovalReceipt = { "context": ReauthenticationContext; "verification_version": string; "version": string; };
export type EmailStatus = { "address"?: string | null; "context": ReauthenticationContext; "verification_version": string; "verified_at"?: string | null; "version": string; };
export type EmailVerificationStep = { "address": string; "delivery": EmailDeliveryState; "expected_version": string; "expires_at": string; "operation_id": string; "state": "pending"; "verification_id": string; "verification_version": string; } | { "address": string; "state": "verified"; "version": string; };
export type EmojiCatalog = { "items": (CustomEmoji)[]; "revision": string; };
export type EnableFactor = { "code": string; "operation_id": string; "setup_id": string; };
export type EncryptedFile = { "bytes": string; "filename": string; "id": string; "key": string; "media_type": string; "sha256": string; };
export type EncryptedKeyBackup = { "ciphertext": string; "crypto_identity": string; "format": string; "kdf": string; "revision": string; "user_id": string; };
export type Every = "hour" | "day" | "week";
export type FactorBackupCodes = { "codes": (string)[]; "factor_version"?: string | null; };
export type FactorEmailDelivery = { "delivery": EmailDeliveryState; "expires_at": string; "resend_after_seconds": number; };
export type FactorSetup = { "expires_at": string; "provisioning_uri": string; "secret": string; "setup_id": string; };
export type FactorStatus = { "backup_codes_remaining": number; "email": boolean; "factor_version"?: string | null; "totp": boolean; };
export type FileDescriptor = { "bytes": string; "encrypted": boolean; "filename"?: string | null; "id": string; "media_type": string; "room_id": string; "sha256": string; };
export type FinishFactor = { "challenge_id": string; "code": string; "method": SecondFactor; "next_token": string; "operation_id": string; };
export type FinishReauthentication = { "challenge_id": string; "code": string; "method": SecondFactor; "operation_id": string; };
export type FormAnswer = string | (string)[];
export type FormField = { "id": string; "kind": FormFieldKind; "label": string; "multiple"?: boolean; "options"?: (string)[]; "people"?: (string)[]; "required"?: boolean; };
export type FormFieldKind = "text" | "long_text" | "number" | "choice" | "person";
export type FormRecipient = "trigger_user" | "anyone";
export type Format = "native1";
export type GroupCancellation = { "device_id": string; "fingerprint": string; "incarnation": string; "operation_id": string; "room_id": string; "scope": Scope; };
export type GroupEvent = { "commit"?: string | null; "receipt": GroupReceipt; "transition": string; "welcome"?: GroupWelcome | null; };
export type GroupEventPage = { "events": (GroupEvent)[]; "next"?: string | null; };
export type GroupMember = { "access_version": string; "activation_version": string; "user_id": string; };
export type GroupReceipt = { "epoch": string; "fingerprint": string; "incarnation": string; "operation_id": string; "revision": string; "room_id": string; "scope": Scope; };
export type GroupRoster = { "authority_version": string; "group"?: GroupReceipt | null; "members": (GroupMember)[]; "room_id": string; "scope": Scope; };
export type GroupSettlement = { "data": GroupReceipt; "kind": "accepted"; } | { "data": GroupCancellation; "kind": "cancelled"; };
export type GroupState = { "needs_rekey": boolean; "receipt": GroupReceipt; "transition": string; "tree": string; };
export type GroupSubmission = { "commit"?: string | null; "operation_id": string; "scope": Scope; "transition": string; "tree": string; "welcomes": (GroupWelcome)[]; };
export type GroupWelcome = { "device_id": string; "incarnation": string; "key_package_ref": string; "payload": string; };
export type HistoryBackupPage = { "next"?: string | null; "period": string; "records": (string)[]; "start": string; };
export type HistoryBackupPeriod = { "checkpoint": string; "period": string; };
export type HistoryBackupPeriods = { "generation": string; "next"?: string | null; "periods": (HistoryBackupPeriod)[]; "scope": Scope; };
export type HistoryBackupReceipt = { "count": string; "period": string; };
export type HistoryKeyCancellation = { "device_id": string; "device_revision": string; "expected_revision"?: string | null; "generation": string; "incarnation": string; "operation_id": string; "package_digest": string; "root_fingerprint": string; "scope": Scope; };
export type HistoryKeyReceipt = { "device_id": string; "device_revision": string; "generation": string; "generation_revision": string; "incarnation": string; "operation_id": string; "package_digest": string; "root_fingerprint": string; "scope": Scope; };
export type HistoryKeySettlement = { "data": HistoryKeyReceipt; "kind": "accepted"; } | { "data": HistoryKeyCancellation; "kind": "cancelled"; };
export type HistoryKeyState = { "active"?: HistoryKeyVersion | null; "scope": Scope; };
export type HistoryKeyVersion = { "publication": string; "receipt": HistoryKeyReceipt; };
export type HistoryRecordsPage = { "next"?: string | null; "period": number; "records": (string)[]; "start": string; };
export type HistoryRecordsReceipt = { "count": string; "period": number; };
export type HistoryRequestEntry = { "committed": boolean; "device_id": string; "expires_at": string; "fingerprint": string; "request": string; "sharer_device_id"?: string | null; };
export type HistoryRequests = { "requests": (HistoryRequestEntry)[]; "scope": Scope; };
export type HistoryShareState = { "fingerprint": string; "scope": Scope; "share": string; "sharer_device_id": string; };
export type HttpHeader = { "name": string; "value": string; };
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type IconCommand = { "operation_id": string; };
export type Identity = { "fingerprint": string; "revision": string; "root": string; "user_id": string; };
export type InstanceIcon = { "revision"?: string | null; };
export type InstanceSettings = { "user_bots": boolean; };
export type IntegrationCard = { "author"?: string | null; "color"?: string | null; "fields"?: (CardField)[]; "text"?: string | null; "title"?: string | null; "url"?: string | null; };
export type JoinVoice = { "data_epoch": string; "e2ee"?: boolean; "membership_version": string; "ring"?: boolean; };
export type LeaveRoom = { "expected_revision": string; "operation_id": string; };
export type LinkPreview = { "description"?: string | null; "image"?: PreviewImage | null; "kind": PreviewKind; "site"?: string | null; "title"?: string | null; "url": string; };
export type LiveFrame = { "data": LiveState; "type": "live"; };
export type LiveRoom = { "direct_peer"?: User | null; "membership_version": string; "room_id": string; "typing": (Typist)[]; "voice"?: (VoiceParticipant)[]; };
export type LiveState = { "emoji_catalog_revision"?: string | null; "limited": boolean; "presence": (PresenceEntry)[]; "profiles"?: (ProfileStamp)[]; "rings"?: (VoiceRing)[]; "rooms": (LiveRoom)[]; "ttl_ms": number; };
export type Login = { "password": string; "username": string; };
export type MarkRead = { "reply_position": string; "root_position": string; };
export type MarkThreadRead = { "position": string; };
export type Message = { "author": User; "body"?: Document | null; "call"?: CallSummary | null; "cards"?: (IntegrationCard)[]; "created_at": string; "deleted"?: boolean; "edited_at"?: string | null; "files"?: (FileDescriptor)[]; "form"?: WorkflowForm | null; "id": string; "personal_mention"?: boolean | null; "personal_star"?: PersonalStar | null; "pinned"?: boolean; "position": string; "previews"?: (LinkPreview)[]; "quotes"?: (MessageQuote)[]; "reactions"?: (MessageReaction)[]; "reply_to"?: string | null; "revision": string; "room_id": string; "system"?: SystemMessage | null; "text": string; "thread"?: ThreadSummary | null; };
export type MessageContent = { "files": (string)[]; "kind": "plain"; "markdown": string; "mentions": (string)[]; "quotes": (QuoteReference)[]; } | { "format": string; "key_version": string; "kind": "encrypted"; "payload": string; };
export type MessagePage = { "has_more": boolean; "messages": (Message)[]; };
export type MessagePermissions = { "delete": boolean; "edit": boolean; "edit_until"?: string | null; "message_id": string; "pin": boolean; "react": boolean; "revision": string; "star": boolean; };
export type MessageQuote = { "excerpt"?: QuoteExcerpt | null; "reference": QuoteReference; "source_membership_version"?: string | null; "view_position"?: string; };
export type MessageReaction = { "emoji": string; "users": (User)[]; };
export type Node = { "kind": "text"; "text": string; } | { "children": (Node)[]; "kind": "paragraph"; } | { "children": (Node)[]; "kind": "bold"; } | { "children": (Node)[]; "kind": "italic"; } | { "children": (Node)[]; "kind": "strike"; } | { "kind": "inline_code"; "text": string; } | { "kind": "code_block"; "language": string; "text": string; } | { "children": (Node)[]; "kind": "heading"; "level": number; } | { "children": (Node)[]; "kind": "quote"; } | { "children": (Node)[]; "kind": "list"; "start"?: number | null; } | { "checked"?: boolean | null; "children": (Node)[]; "kind": "list_item"; } | { "children": (Node)[]; "href": string; "kind": "link"; } | { "kind": "mention"; "name": string; } | { "kind": "room_mention"; "name": string; } | { "kind": "emoji"; "shortcode": string; } | { "kind": "break"; } | { "kind": "rule"; };
export type OperationReceipt = { "device_id": string; "device_revision": string; "incarnation": string; "key_package_refs": (string)[]; "kind": string; "operation_id": string; "root_fingerprint": string; "scope": Scope; };
export type OwnProfile = { "email"?: string | null; "preferences": UserPreferences; "profile": UserProfile; };
export type ParityContract = { "accept_invitation"?: AcceptInvitation | null; "account_permissions": AccountPermissions; "auth_challenge": AuthChallenge; "authentication_step"?: AuthenticationStep | null; "begin_email_verification"?: BeginEmailVerification | null; "begin_factor_setup"?: BeginFactorSetup | null; "begin_reauthentication"?: BeginReauthentication | null; "change_email_factor"?: ChangeEmailFactor | null; "change_room_role"?: ChangeRoomRole | null; "complete_upload": CompleteUpload; "confirm_email_verification"?: ConfirmEmailVerification | null; "delete_message": DeleteMessage; "device_session"?: DeviceSession | null; "disable_factor"?: DisableFactor | null; "e2ee_application_receipt"?: ApplicationReceipt | null; "e2ee_application_settlement"?: ApplicationSettlement | null; "e2ee_application_submission"?: ApplicationSubmission | null; "e2ee_available_key_package"?: AvailableKeyPackage | null; "e2ee_commit_history_share"?: CommitHistoryShare | null; "e2ee_delivery_page"?: DeliveryPage | null; "e2ee_directory"?: Directory | null; "e2ee_group_events"?: GroupEventPage | null; "e2ee_group_roster"?: GroupRoster | null; "e2ee_group_settlement"?: GroupSettlement | null; "e2ee_group_state"?: GroupState | null; "e2ee_group_submission"?: GroupSubmission | null; "e2ee_history_backup_page"?: HistoryBackupPage | null; "e2ee_history_backup_periods"?: HistoryBackupPeriods | null; "e2ee_history_backup_receipt"?: HistoryBackupReceipt | null; "e2ee_history_key"?: HistoryKeyState | null; "e2ee_history_key_settlement"?: HistoryKeySettlement | null; "e2ee_history_records_page"?: HistoryRecordsPage | null; "e2ee_history_records_receipt"?: HistoryRecordsReceipt | null; "e2ee_history_requests"?: HistoryRequests | null; "e2ee_history_share"?: HistoryShareState | null; "e2ee_operation_receipt"?: OperationReceipt | null; "e2ee_publish_history_key"?: PublishHistoryKey | null; "e2ee_publish_history_request"?: PublishHistoryRequest | null; "e2ee_publish_key_packages"?: PublishKeyPackages | null; "e2ee_publish_root_backup"?: PublishRootBackup | null; "e2ee_register_device"?: RegisterDevice | null; "e2ee_revoke_device"?: RevokeDevice | null; "e2ee_root_backup"?: RootBackupState | null; "e2ee_root_backup_settlement"?: RootBackupSettlement | null; "e2ee_upload_history_backup"?: UploadHistoryBackup | null; "e2ee_upload_history_records"?: UploadHistoryRecords | null; "edit_message": EditMessage; "email_factor_change"?: EmailFactorChange | null; "email_recovery_requested"?: EmailRecoveryRequested | null; "email_removal_receipt"?: EmailRemovalReceipt | null; "email_status"?: EmailStatus | null; "email_verification_step"?: EmailVerificationStep | null; "enable_factor"?: EnableFactor | null; "factor_backup_codes"?: FactorBackupCodes | null; "factor_email_delivery"?: FactorEmailDelivery | null; "factor_setup"?: FactorSetup | null; "factor_status"?: FactorStatus | null; "file": FileDescriptor; "finish_factor"?: FinishFactor | null; "finish_reauthentication"?: FinishReauthentication | null; "key_backup": EncryptedKeyBackup; "leave_room"?: LeaveRoom | null; "mark": SetMark; "mark_read": MarkRead; "message_permissions": MessagePermissions; "preferences": UserPreferences; "prepare_upload": PrepareUpload; "profile": UserProfile; "public_device_key": PublicDeviceKey; "reaction": SetReaction; "read_state": ReadState; "reauthentication_grant"?: ReauthenticationGrant | null; "reauthentication_status"?: ReauthenticationStatus | null; "reauthentication_step"?: ReauthenticationStep | null; "recover_account"?: RecoverAccount | null; "regenerate_factor_backups"?: RegenerateFactorBackups | null; "remove_verified_email"?: RemoveVerifiedEmail | null; "rename_device"?: RenameDevice | null; "renew_session"?: RenewSession | null; "request_email_recovery"?: RequestEmailRecovery | null; "request_factor_email"?: RequestFactorEmail | null; "resume_email_removal"?: ResumeEmailRemoval | null; "resume_email_verification"?: ResumeEmailVerification | null; "resume_reauthentication"?: ResumeReauthentication | null; "retire_email_removal"?: RetireEmailRemoval | null; "retire_email_verification"?: RetireEmailVerification | null; "retire_reauthentication"?: RetireReauthentication | null; "room_command_receipt"?: RoomCommandReceipt | null; "room_details"?: RoomDetails | null; "room_favorite"?: SetRoomFavorite | null; "room_key_envelope": RoomKeyEnvelope; "room_members"?: RoomMemberPage | null; "room_permissions": RoomPermissions; "update_room"?: UpdateRoom | null; "upload": Upload; "verify_factor": VerifyFactor; };
export type PersonalStar = { "present": boolean; "revision": string; };
export type PrepareUpload = { "bytes": string; "encrypted": boolean; "filename"?: string | null; "media_type": string; "operation_id": string; "room_id": string; "sha256": string; };
export type PresenceEntry = { "status": PresenceStatus; "user": User; };
export type PresenceStatus = "online" | "away" | "busy" | "offline";
export type PreviewImage = { "bytes": string; "file_id": string; "height": number; "media_type": string; "sha256": string; "width": number; };
export type PreviewKind = "page" | "image";
export type ProfileReceipt = { "applied_revision": string; "operation_id": string; };
export type ProfileStamp = { "avatar_file_id"?: string | null; "revision": string; "status_text": string; "user": User; };
export type PublicDeviceKey = { "device_id": string; "fingerprint": string; "format": string; "public_key": string; "revision": string; "user_id": string; };
export type PublicRoom = { "joined": boolean; "room": Room; };
export type PublicRoomPage = { "next"?: string | null; "rooms": (PublicRoom)[]; };
export type PublishHistoryKey = { "operation_id": string; "publication": string; "scope": Scope; };
export type PublishHistoryRequest = { "request": string; "scope": Scope; };
export type PublishKeyPackages = { "device_revision": string; "operation_id": string; "packages": (string)[]; "scope": Scope; };
export type PublishRootBackup = { "operation_id": string; "publication": string; "scope": Scope; };
export type PushContent = { "data_epoch": string; "device_id": string; "instance_id": string; "message": Message; "notification_id": string; "room": Room; };
export type PushRegistration = { "data_epoch": string; "device_id": string; "instance_id": string; };
export type QuoteExcerpt = { "author": User; "created_at": string; "files"?: (FileDescriptor)[]; "membership_version": string; "quotes"?: (MessageQuote)[]; "references"?: (QuoteReference)[]; "revision": string; "text": string; };
export type QuoteReference = { "message_id": string; "revision": string; "room_id": string; };
export type ReadState = { "favorite": boolean; "favorite_revision"?: string | null; "group_mentions": string; "membership_version"?: string | null; "mentions": string; "reply_position": string; "revision": string; "room_id": string; "root_position": string; "unread_replies": string; "unread_roots": string; };
export type ReauthenticationContext = { "data_epoch": string; "device_id": string; "instance_id": string; "user_id": string; };
export type ReauthenticationGrant = { "authenticated_at": string; "data_epoch": string; "device_id": string; "expires_at": string; "factor_version": string; "instance_id": string; "proof_version": string; "user_id": string; };
export type ReauthenticationStatus = { "data_epoch": string; "device_id": string; "instance_id": string; "proof_version": string; "recent": boolean; "user_id": string; };
export type ReauthenticationStep = { "grant": ReauthenticationGrant; "kind": "granted"; } | { "challenge": AuthChallenge; "kind": "challenge"; };
export type RecoverAccount = { "new_password": string; "token": string; "username": string; };
export type RegenerateFactorBackups = { "factor_version": string; "operation_id": string; };
export type RegisterDevice = { "expected_device_revision"?: string | null; "expected_root_fingerprint"?: string | null; "grant": string; "operation_id": string; "request": string; "revoke_previous"?: string | null; "scope": Scope; };
export type RegisterPush = { "token": string; };
export type RemoveEmoji = { "expected_revision": string; "operation_id": string; };
export type RemoveVerifiedEmail = { "context": ReauthenticationContext; "expected_version": string; "operation_id": string; "verification_version": string; };
export type RenameDevice = { "label": string; };
export type RenewSession = { "next_token": string; "operation_id": string; };
export type ReportInput = { "operation_id": string; "reason": string; };
export type RequestEmailRecovery = { "data_epoch": string; "instance_id": string; "operation_id": string; "username": string; };
export type RequestFactorEmail = { "challenge_id": string; "delivery_id": string; "operation_id": string; };
export type ResumeEmailRemoval = { "context": ReauthenticationContext; "operation_id": string; };
export type ResumeEmailVerification = { "context": ReauthenticationContext; "operation_id": string; "verification_id": string; };
export type ResumeReauthentication = { "challenge_id": string; "operation_id": string; };
export type RetireEmailRemoval = { "context": ReauthenticationContext; "expected_version": string; "verification_version": string; };
export type RetireEmailVerification = { "context": ReauthenticationContext; "expected_version": string; "verification_version": string; };
export type RetireReauthentication = { "context": ReauthenticationContext; "proof_version": string; };
export type Revocation = { "position": string; "signed": string; };
export type RevokeDevice = { "device_revision": string; "incarnation": string; "operation_id": string; "scope": Scope; "signed": string; };
export type RingState = "ringing" | "answered" | "declined" | "missed" | "cancelled";
export type Room = { "encrypted"?: boolean; "id": string; "kind": RoomKind; "name": string; "read_state"?: ReadState | null; "revision": string; "voice"?: boolean; };
export type RoomCommandReceipt = { "applied_revision": string; "operation_id": string; "room_id": string; };
export type RoomDetails = { "announcement": string; "description": string; "member_count": number; "permissions": RoomPermissions; "read_only": boolean; "revision": string; "room": Room; "topic": string; "voice"?: boolean; };
export type RoomKeyEnvelope = { "ciphertext": string; "format": string; "key_version": string; "recipient_device_id": string; "recipient_user_id": string; "room_id": string; "sender_device_id": string; };
export type RoomKind = "public" | "private" | "direct";
export type RoomMember = { "disabled": boolean; "role": RoomRole; "user": User; };
export type RoomMemberPage = { "members": (RoomMember)[]; "next"?: string | null; "revision": string; "room_id": string; };
export type RoomPermissions = { "change_settings": boolean; "invite": boolean; "pin": boolean; "read": boolean; "remove_member": boolean; "revision": string; "role": RoomRole; "room_id": string; "send": boolean; "start_call": boolean; "upload": boolean; };
export type RoomRole = "owner" | "moderator" | "member";
export type RootBackupCancellation = { "backup_id": string; "device_id": string; "device_revision": string; "expected_revision"?: string | null; "incarnation": string; "operation_id": string; "packet_digest": string; "root_fingerprint": string; "scope": Scope; };
export type RootBackupReceipt = { "backup_id": string; "backup_revision": string; "device_id": string; "device_revision": string; "incarnation": string; "operation_id": string; "packet_digest": string; "root_fingerprint": string; "scope": Scope; };
export type RootBackupSettlement = { "data": RootBackupReceipt; "kind": "accepted"; } | { "data": RootBackupCancellation; "kind": "cancelled"; };
export type RootBackupState = { "active"?: RootBackupVersion | null; "scope": Scope; };
export type RootBackupVersion = { "publication": string; "receipt": RootBackupReceipt; };
export type RunCommand = { "command": string; "params": string; "room_id": string; };
export type RunStarted = { "run_id": string; };
export type RunState = "pending" | "waiting" | "done" | "failed" | "cancelled";
export type Scope = { "data_epoch": string; "instance_id": string; };
export type SearchMessages = { "before"?: string | null; "limit"?: number | null; "q": string; };
export type SearchPage = { "has_more": boolean; "membership_version": string; "messages": (Message)[]; };
export type SecondFactor = "totp" | "email" | "recovery_code";
export type SendMessage = { "cards"?: (IntegrationCard)[]; "files"?: (EncryptedFile)[]; "operation_id": string; "quotes"?: (QuoteReference)[]; "reply_to"?: string | null; "text": string; };
export type Session = { "expires_at": string; "token": string; "user": User; };
export type SetMark = { "operation_id": string; "present": boolean; };
export type SetPresence = { "status": PresenceStatus; };
export type SetReaction = { "emoji": string; "operation_id": string; "present": boolean; };
export type SetRoomFavorite = { "expected_revision": string; "operation_id": string; "present": boolean; };
export type SetTyping = { "active": boolean; "membership_version": string; "root_id"?: string | null; };
export type SlashCommand = { "client_side": boolean; "command": string; "description": string; "literal"?: boolean; "params": string; };
export type Snapshot = { "cursor": string; "messages": (Message)[]; "protocol_version": number; "rooms": (Room)[]; };
export type SnapshotPage = { "cursor"?: string | null; "messages": (Message)[]; "next"?: string | null; "page_index": number; "protocol_version": number; "rooms": (Room)[]; "snapshot_id": string; };
export type SocketTicket = { "expires_at": string; "ticket": string; };
export type Step = { "cards"?: (IntegrationCard)[]; "in_thread"?: boolean; "kind": "message"; "room": string; "save_as"?: string | null; "text": string; } | { "kind": "wait"; "seconds": number; } | { "body"?: string | null; "continue_on_error"?: boolean; "headers"?: (HttpHeader)[]; "kind": "http"; "method": HttpMethod; "save_as"?: string | null; "url": string; } | { "fields": (FormField)[]; "kind": "form"; "recipient": FormRecipient; "room": string; "save_as": string; "title": string; };
export type SyncBatch = { "changes": (Change)[]; "cursor": string; "has_more": boolean; "protocol_version": number; };
export type SystemMessage = { "kind": "call_started"; "meeting_id": string; } | { "kind": "room_created"; "name": string; } | { "kind": "room_renamed"; "name": string; } | { "kind": "topic_changed"; "topic": string; } | { "description": string; "kind": "description_changed"; } | { "announcement": string; "kind": "announcement_changed"; } | { "kind": "privacy_changed"; "private": boolean; } | { "kind": "read_only_changed"; "read_only": boolean; } | { "kind": "member_joined"; } | { "kind": "member_left"; } | { "kind": "member_added"; "user": User; } | { "kind": "member_removed"; "user": User; } | { "kind": "role_changed"; "previous_role": RoomRole; "role": RoomRole; "user": User; };
export type ThreadPage = { "has_more": boolean; "messages": (Message)[]; "read_state": ThreadReadState; "root": Message; };
export type ThreadReadState = { "membership_version": string; "position": string; "revision": string; "room_id": string; "root_id": string; "unread": string; };
export type ThreadSummary = { "last_reply_at"?: string | null; "replies": string; };
export type Trigger = { "kind": "command"; "name": string; } | { "days"?: (number)[]; "every": Every; "kind": "schedule"; "room": string; "time": string; "timezone": string; } | { "kind": "member_joined"; "room": string; } | { "emoji"?: string | null; "kind": "reaction_added"; "room": string; } | { "contains": string; "kind": "message_posted"; "room": string; } | { "kind": "webhook"; };
export type Typist = { "root_id"?: string | null; "user": User; };
export type UpdateAdminUser = { "admin"?: boolean | null; "disabled"?: boolean | null; "operation_id": string; "revision": string; };
export type UpdateBot = { "description"?: string | null; "display_name"?: string | null; "operation_id": string; "scopes"?: (BotScope)[] | null; };
export type UpdateInstanceSettings = { "operation_id": string; "user_bots"?: boolean | null; };
export type UpdatePreferences = { "clock_24h": boolean; "desktop_notifications": DesktopNotifications; "expected_revision": string; "language": string; "operation_id": string; "push_enabled": boolean; "push_mentions_only": boolean; };
export type UpdateProfile = { "bio": string; "display_name": string; "expected_revision": string; "operation_id": string; "status": PresenceStatus; "status_text": string; "username": string; };
export type UpdateRoom = { "announcement": string; "description": string; "expected_revision": string; "name": string; "operation_id": string; "private": boolean; "read_only": boolean; "topic": string; "voice"?: boolean | null; };
export type UpdateWorkflow = { "bot_id": string; "description"?: string; "enabled": boolean; "name": string; "operation_id": string; "revision": string; "steps": (Step)[]; "trigger": Trigger; };
export type Upload = { "expires_at": string; "file": FileDescriptor; "id": string; "message_id"?: string | null; "state": UploadState; };
export type UploadHistoryBackup = { "checkpoint": string; "records": (string)[]; "scope": Scope; "start": string; };
export type UploadHistoryRecords = { "period": number; "records": (string)[]; "scope": Scope; "start": string; };
export type UploadState = "prepared" | "ready" | "completed" | "cancelled" | "expired";
export type User = { "bot"?: boolean; "deleted"?: boolean; "display_name": string; "id": string; "username": string; };
export type UserPreferences = { "clock_24h": boolean; "desktop_notifications"?: DesktopNotifications; "language": string; "push_enabled": boolean; "push_mentions_only": boolean; "revision": string; };
export type UserProfile = { "avatar_file_id"?: string | null; "bio": string; "bot_owner"?: User | null; "revision": string; "status"?: PresenceStatus; "status_text": string; "user": User; };
export type VerifyFactor = { "challenge_id": string; "code": string; "method": SecondFactor; };
export type VoiceGrant = { "can_publish": boolean; "e2ee"?: boolean; "expires_at": string; "ring"?: VoiceRing | null; "room_id": string; "token": string; "url": string; };
export type VoiceParticipant = { "camera"?: boolean; "deafened": boolean; "muted": boolean; "screen"?: boolean; "user": User; };
export type VoiceRing = { "callee": User; "caller": User; "expires_in_ms": number; "id": string; "room_id": string; "state": RingState; };
export type WebhookSecret = { "path": string; };
export type Workflow = { "bot": User; "created_at": string; "description": string; "enabled": boolean; "has_webhook"?: boolean; "id": string; "last_run"?: WorkflowRun | null; "name": string; "next_fire_at"?: string | null; "owner": User; "revision": string; "steps": (Step)[]; "trigger": Trigger; "updated_at": string; };
export type WorkflowForm = { "answered_at"?: string | null; "answered_by"?: User | null; "expires_at": string; "fields": (FormField)[]; "people"?: (User)[]; "recipient"?: User | null; "title": string; };
export type WorkflowList = { "workflows": (Workflow)[]; };
export type WorkflowRun = { "created_at": string; "error"?: string | null; "id": string; "state": RunState; "step": number; "updated_at": string; };
export type WorkflowRunList = { "runs": (WorkflowRun)[]; };
export type WorkflowsContract = { "answer_form": AnswerForm; "create_workflow": CreateWorkflow; "run_started": RunStarted; "update_workflow": UpdateWorkflow; "webhook_secret": WebhookSecret; "workflow": Workflow; "workflow_form": WorkflowForm; "workflow_list": WorkflowList; "workflow_run_list": WorkflowRunList; };

export type NativeTypes = { AcceptInvitation: AcceptInvitation; AccountPermissions: AccountPermissions; AdminContract: AdminContract; AdminMessageCounts: AdminMessageCounts; AdminOperation: AdminOperation; AdminOverview: AdminOverview; AdminReport: AdminReport; AdminReportCounts: AdminReportCounts; AdminReportedMessage: AdminReportedMessage; AdminReportedMessagePage: AdminReportedMessagePage; AdminReportedUser: AdminReportedUser; AdminReportedUserPage: AdminReportedUserPage; AdminRoom: AdminRoom; AdminRoomCounts: AdminRoomCounts; AdminRoomPage: AdminRoomPage; AdminUploadCounts: AdminUploadCounts; AdminUser: AdminUser; AdminUserCounts: AdminUserCounts; AdminUserPage: AdminUserPage; AnswerForm: AnswerForm; AnswerRing: AnswerRing; ApiError: ApiError; ApplicationCancellation: ApplicationCancellation; ApplicationMessage: ApplicationMessage; ApplicationReceipt: ApplicationReceipt; ApplicationSettlement: ApplicationSettlement; ApplicationSubmission: ApplicationSubmission; AuthChallenge: AuthChallenge; AuthenticationStep: AuthenticationStep; AvailableKeyPackage: AvailableKeyPackage; AvatarCommand: AvatarCommand; BeginEmailVerification: BeginEmailVerification; BeginFactorSetup: BeginFactorSetup; BeginReauthentication: BeginReauthentication; Bot: Bot; BotKey: BotKey; BotKeyCreated: BotKeyCreated; BotKeyList: BotKeyList; BotList: BotList; BotReference: BotReference; BotRoute: BotRoute; BotScope: BotScope; BotScopeRoutes: BotScopeRoutes; BotsContract: BotsContract; CallSummary: CallSummary; Capabilities: Capabilities; CardField: CardField; Change: Change; ChangeEmailFactor: ChangeEmailFactor; ChangeRoomRole: ChangeRoomRole; CommandList: CommandList; CommitHistoryShare: CommitHistoryShare; CompleteUpload: CompleteUpload; ConfirmEmailVerification: ConfirmEmailVerification; CreateBot: CreateBot; CreateBotKey: CreateBotKey; CreateEmoji: CreateEmoji; CreateRoom: CreateRoom; CreateWorkflow: CreateWorkflow; CustomEmoji: CustomEmoji; DeleteAdminUser: DeleteAdminUser; DeleteMessage: DeleteMessage; DeliveryContent: DeliveryContent; DeliveryEvent: DeliveryEvent; DeliveryPage: DeliveryPage; DesktopNotifications: DesktopNotifications; Device: Device; DeviceSession: DeviceSession; DirectMessage: DirectMessage; Directory: Directory; DisableFactor: DisableFactor; Discovery: Discovery; Document: Document; EditMessage: EditMessage; EmailDeliveryState: EmailDeliveryState; EmailFactorChange: EmailFactorChange; EmailRecoveryRequested: EmailRecoveryRequested; EmailRemovalReceipt: EmailRemovalReceipt; EmailStatus: EmailStatus; EmailVerificationStep: EmailVerificationStep; EmojiCatalog: EmojiCatalog; EnableFactor: EnableFactor; EncryptedFile: EncryptedFile; EncryptedKeyBackup: EncryptedKeyBackup; Every: Every; FactorBackupCodes: FactorBackupCodes; FactorEmailDelivery: FactorEmailDelivery; FactorSetup: FactorSetup; FactorStatus: FactorStatus; FileDescriptor: FileDescriptor; FinishFactor: FinishFactor; FinishReauthentication: FinishReauthentication; FormAnswer: FormAnswer; FormField: FormField; FormFieldKind: FormFieldKind; FormRecipient: FormRecipient; Format: Format; GroupCancellation: GroupCancellation; GroupEvent: GroupEvent; GroupEventPage: GroupEventPage; GroupMember: GroupMember; GroupReceipt: GroupReceipt; GroupRoster: GroupRoster; GroupSettlement: GroupSettlement; GroupState: GroupState; GroupSubmission: GroupSubmission; GroupWelcome: GroupWelcome; HistoryBackupPage: HistoryBackupPage; HistoryBackupPeriod: HistoryBackupPeriod; HistoryBackupPeriods: HistoryBackupPeriods; HistoryBackupReceipt: HistoryBackupReceipt; HistoryKeyCancellation: HistoryKeyCancellation; HistoryKeyReceipt: HistoryKeyReceipt; HistoryKeySettlement: HistoryKeySettlement; HistoryKeyState: HistoryKeyState; HistoryKeyVersion: HistoryKeyVersion; HistoryRecordsPage: HistoryRecordsPage; HistoryRecordsReceipt: HistoryRecordsReceipt; HistoryRequestEntry: HistoryRequestEntry; HistoryRequests: HistoryRequests; HistoryShareState: HistoryShareState; HttpHeader: HttpHeader; HttpMethod: HttpMethod; IconCommand: IconCommand; Identity: Identity; InstanceIcon: InstanceIcon; InstanceSettings: InstanceSettings; IntegrationCard: IntegrationCard; JoinVoice: JoinVoice; LeaveRoom: LeaveRoom; LinkPreview: LinkPreview; LiveFrame: LiveFrame; LiveRoom: LiveRoom; LiveState: LiveState; Login: Login; MarkRead: MarkRead; MarkThreadRead: MarkThreadRead; Message: Message; MessageContent: MessageContent; MessagePage: MessagePage; MessagePermissions: MessagePermissions; MessageQuote: MessageQuote; MessageReaction: MessageReaction; Node: Node; OperationReceipt: OperationReceipt; OwnProfile: OwnProfile; ParityContract: ParityContract; PersonalStar: PersonalStar; PrepareUpload: PrepareUpload; PresenceEntry: PresenceEntry; PresenceStatus: PresenceStatus; PreviewImage: PreviewImage; PreviewKind: PreviewKind; ProfileReceipt: ProfileReceipt; ProfileStamp: ProfileStamp; PublicDeviceKey: PublicDeviceKey; PublicRoom: PublicRoom; PublicRoomPage: PublicRoomPage; PublishHistoryKey: PublishHistoryKey; PublishHistoryRequest: PublishHistoryRequest; PublishKeyPackages: PublishKeyPackages; PublishRootBackup: PublishRootBackup; PushContent: PushContent; PushRegistration: PushRegistration; QuoteExcerpt: QuoteExcerpt; QuoteReference: QuoteReference; ReadState: ReadState; ReauthenticationContext: ReauthenticationContext; ReauthenticationGrant: ReauthenticationGrant; ReauthenticationStatus: ReauthenticationStatus; ReauthenticationStep: ReauthenticationStep; RecoverAccount: RecoverAccount; RegenerateFactorBackups: RegenerateFactorBackups; RegisterDevice: RegisterDevice; RegisterPush: RegisterPush; RemoveEmoji: RemoveEmoji; RemoveVerifiedEmail: RemoveVerifiedEmail; RenameDevice: RenameDevice; RenewSession: RenewSession; ReportInput: ReportInput; RequestEmailRecovery: RequestEmailRecovery; RequestFactorEmail: RequestFactorEmail; ResumeEmailRemoval: ResumeEmailRemoval; ResumeEmailVerification: ResumeEmailVerification; ResumeReauthentication: ResumeReauthentication; RetireEmailRemoval: RetireEmailRemoval; RetireEmailVerification: RetireEmailVerification; RetireReauthentication: RetireReauthentication; Revocation: Revocation; RevokeDevice: RevokeDevice; RingState: RingState; Room: Room; RoomCommandReceipt: RoomCommandReceipt; RoomDetails: RoomDetails; RoomKeyEnvelope: RoomKeyEnvelope; RoomKind: RoomKind; RoomMember: RoomMember; RoomMemberPage: RoomMemberPage; RoomPermissions: RoomPermissions; RoomRole: RoomRole; RootBackupCancellation: RootBackupCancellation; RootBackupReceipt: RootBackupReceipt; RootBackupSettlement: RootBackupSettlement; RootBackupState: RootBackupState; RootBackupVersion: RootBackupVersion; RunCommand: RunCommand; RunStarted: RunStarted; RunState: RunState; Scope: Scope; SearchMessages: SearchMessages; SearchPage: SearchPage; SecondFactor: SecondFactor; SendMessage: SendMessage; Session: Session; SetMark: SetMark; SetPresence: SetPresence; SetReaction: SetReaction; SetRoomFavorite: SetRoomFavorite; SetTyping: SetTyping; SlashCommand: SlashCommand; Snapshot: Snapshot; SnapshotPage: SnapshotPage; SocketTicket: SocketTicket; Step: Step; SyncBatch: SyncBatch; SystemMessage: SystemMessage; ThreadPage: ThreadPage; ThreadReadState: ThreadReadState; ThreadSummary: ThreadSummary; Trigger: Trigger; Typist: Typist; UpdateAdminUser: UpdateAdminUser; UpdateBot: UpdateBot; UpdateInstanceSettings: UpdateInstanceSettings; UpdatePreferences: UpdatePreferences; UpdateProfile: UpdateProfile; UpdateRoom: UpdateRoom; UpdateWorkflow: UpdateWorkflow; Upload: Upload; UploadHistoryBackup: UploadHistoryBackup; UploadHistoryRecords: UploadHistoryRecords; UploadState: UploadState; User: User; UserPreferences: UserPreferences; UserProfile: UserProfile; VerifyFactor: VerifyFactor; VoiceGrant: VoiceGrant; VoiceParticipant: VoiceParticipant; VoiceRing: VoiceRing; WebhookSecret: WebhookSecret; Workflow: Workflow; WorkflowForm: WorkflowForm; WorkflowList: WorkflowList; WorkflowRun: WorkflowRun; WorkflowRunList: WorkflowRunList; WorkflowsContract: WorkflowsContract; };

export const nativeSchema = {
  "$defs": {
    "AcceptInvitation": {
      "additionalProperties": false,
      "description": "Creating an account does not authenticate it; normal login follows, including\nany required second factor. Invitation/password are transient secrets.",
      "properties": {
        "password": {
          "type": "string"
        },
        "token": {
          "type": "string"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "token",
        "username",
        "password"
      ],
      "type": "object"
    },
    "AccountPermissions": {
      "properties": {
        "create_bot": {
          "default": false,
          "description": "Administrators, or everyone when the instance allows bots (RFC 0003).",
          "type": "boolean"
        },
        "create_private_room": {
          "type": "boolean"
        },
        "create_public_room": {
          "type": "boolean"
        },
        "manage_accounts": {
          "type": "boolean"
        },
        "manage_instance": {
          "type": "boolean"
        }
      },
      "required": [
        "create_public_room",
        "create_private_room",
        "manage_accounts",
        "manage_instance"
      ],
      "type": "object"
    },
    "AdminContract": {
      "description": "Export root of the administration fixture.",
      "properties": {
        "create_emoji": {
          "$ref": "#/$defs/CreateEmoji"
        },
        "delete_user": {
          "$ref": "#/$defs/DeleteAdminUser"
        },
        "icon_command": {
          "$ref": "#/$defs/IconCommand"
        },
        "instance_icon": {
          "$ref": "#/$defs/InstanceIcon"
        },
        "operation": {
          "$ref": "#/$defs/AdminOperation"
        },
        "overview": {
          "$ref": "#/$defs/AdminOverview"
        },
        "remove_emoji": {
          "$ref": "#/$defs/RemoveEmoji"
        },
        "report": {
          "$ref": "#/$defs/ReportInput"
        },
        "reported_messages": {
          "$ref": "#/$defs/AdminReportedMessagePage"
        },
        "reported_users": {
          "$ref": "#/$defs/AdminReportedUserPage"
        },
        "room_page": {
          "$ref": "#/$defs/AdminRoomPage"
        },
        "update_user": {
          "$ref": "#/$defs/UpdateAdminUser"
        },
        "user_page": {
          "$ref": "#/$defs/AdminUserPage"
        }
      },
      "required": [
        "overview",
        "user_page",
        "update_user",
        "delete_user",
        "room_page",
        "reported_messages",
        "reported_users",
        "operation",
        "report",
        "create_emoji",
        "remove_emoji",
        "instance_icon",
        "icon_command"
      ],
      "type": "object"
    },
    "AdminMessageCounts": {
      "description": "Messages people wrote: system activity and tombstones are not counted.",
      "properties": {
        "direct": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "encrypted": {
          "description": "Opaque private messages, outside the three plaintext kinds.",
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "private": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "public": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "total": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "total",
        "public",
        "private",
        "direct",
        "encrypted"
      ],
      "type": "object"
    },
    "AdminOperation": {
      "additionalProperties": false,
      "description": "Dismissing reports or deleting a reported message.",
      "properties": {
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id"
      ],
      "type": "object"
    },
    "AdminOverview": {
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        },
        "messages": {
          "$ref": "#/$defs/AdminMessageCounts"
        },
        "migration_version": {
          "type": [
            "string",
            "null"
          ]
        },
        "postgres_version": {
          "type": "string"
        },
        "reports": {
          "$ref": "#/$defs/AdminReportCounts"
        },
        "rooms": {
          "$ref": "#/$defs/AdminRoomCounts"
        },
        "server_version": {
          "type": "string"
        },
        "started_at": {
          "description": "Start of this server process; the uptime is the distance to now.",
          "type": "string"
        },
        "uploads": {
          "$ref": "#/$defs/AdminUploadCounts"
        },
        "users": {
          "$ref": "#/$defs/AdminUserCounts"
        }
      },
      "required": [
        "server_version",
        "postgres_version",
        "instance_id",
        "data_epoch",
        "started_at",
        "users",
        "rooms",
        "messages",
        "uploads",
        "reports"
      ],
      "type": "object"
    },
    "AdminReport": {
      "properties": {
        "created_at": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        },
        "reporter": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "reporter",
        "reason",
        "created_at"
      ],
      "type": "object"
    },
    "AdminReportCounts": {
      "description": "Open reports only.",
      "properties": {
        "messages": {
          "description": "Reported messages, not reports.",
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "users": {
          "description": "Reported accounts, not reports.",
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "messages",
        "users"
      ],
      "type": "object"
    },
    "AdminReportedMessage": {
      "properties": {
        "author": {
          "$ref": "#/$defs/User"
        },
        "author_revision": {
          "description": "The author's account revision, to deactivate it directly; absent for a\ndeleted author.",
          "type": [
            "string",
            "null"
          ]
        },
        "created_at": {
          "type": "string"
        },
        "deleted": {
          "type": "boolean"
        },
        "latest_report_at": {
          "type": "string"
        },
        "message_id": {
          "type": "string"
        },
        "report_count": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "reports": {
          "description": "Newest first, at most 20.",
          "items": {
            "$ref": "#/$defs/AdminReport"
          },
          "type": "array"
        },
        "room_id": {
          "type": "string"
        },
        "room_kind": {
          "$ref": "#/$defs/RoomKind"
        },
        "room_name": {
          "type": "string"
        },
        "text": {
          "description": "The text as the newest report saw it, even after an edit or a deletion.",
          "type": "string"
        }
      },
      "required": [
        "message_id",
        "room_id",
        "room_kind",
        "room_name",
        "author",
        "text",
        "created_at",
        "deleted",
        "report_count",
        "latest_report_at",
        "reports"
      ],
      "type": "object"
    },
    "AdminReportedMessagePage": {
      "properties": {
        "items": {
          "items": {
            "$ref": "#/$defs/AdminReportedMessage"
          },
          "type": "array"
        },
        "next": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "items"
      ],
      "type": "object"
    },
    "AdminReportedUser": {
      "properties": {
        "latest_report_at": {
          "type": "string"
        },
        "report_count": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "reports": {
          "description": "Newest first, at most 20.",
          "items": {
            "$ref": "#/$defs/AdminReport"
          },
          "type": "array"
        },
        "user": {
          "$ref": "#/$defs/AdminUser"
        }
      },
      "required": [
        "user",
        "report_count",
        "latest_report_at",
        "reports"
      ],
      "type": "object"
    },
    "AdminReportedUserPage": {
      "properties": {
        "items": {
          "items": {
            "$ref": "#/$defs/AdminReportedUser"
          },
          "type": "array"
        },
        "next": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "items"
      ],
      "type": "object"
    },
    "AdminRoom": {
      "properties": {
        "created_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "direct_members": {
          "description": "The pair of a direct conversation, deleted accounts included; empty otherwise.",
          "items": {
            "$ref": "#/$defs/User"
          },
          "type": "array"
        },
        "encrypted": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "kind": {
          "$ref": "#/$defs/RoomKind"
        },
        "last_message_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "member_count": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "message_count": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "name": {
          "type": "string"
        },
        "read_only": {
          "type": "boolean"
        },
        "topic": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "id",
        "kind",
        "name",
        "member_count",
        "message_count",
        "read_only",
        "encrypted"
      ],
      "type": "object"
    },
    "AdminRoomCounts": {
      "properties": {
        "direct": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "encrypted": {
          "description": "Rooms with an MLS group, also counted under their kind.",
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "private": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "public": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "total": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "total",
        "public",
        "private",
        "direct",
        "encrypted"
      ],
      "type": "object"
    },
    "AdminRoomPage": {
      "properties": {
        "items": {
          "items": {
            "$ref": "#/$defs/AdminRoom"
          },
          "type": "array"
        },
        "next": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "items"
      ],
      "type": "object"
    },
    "AdminUploadCounts": {
      "properties": {
        "bytes": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "count": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "count",
        "bytes"
      ],
      "type": "object"
    },
    "AdminUser": {
      "properties": {
        "admin": {
          "type": "boolean"
        },
        "avatar_file_id": {
          "description": "The profile avatar (`/api/v1/avatars/{id}`); absent for a disabled account,\nwhose avatar is no longer served.",
          "type": [
            "string",
            "null"
          ]
        },
        "bot": {
          "default": false,
          "description": "A bot account (RFC 0003); absent from older servers.",
          "type": "boolean"
        },
        "created_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "disabled": {
          "type": "boolean"
        },
        "display_name": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "last_seen_at": {
          "description": "Latest activity of any of its devices, at a five-minute granularity.",
          "type": [
            "string",
            "null"
          ]
        },
        "revision": {
          "description": "Account authority version, expected back by every change.",
          "type": "string"
        },
        "status": {
          "$ref": "#/$defs/PresenceStatus"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "username",
        "display_name",
        "admin",
        "disabled",
        "status",
        "revision"
      ],
      "type": "object"
    },
    "AdminUserCounts": {
      "properties": {
        "active": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "admins": {
          "description": "Active administrators.",
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "away": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "busy": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "deactivated": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "offline": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "online": {
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        },
        "total": {
          "description": "Accounts, deleted ones excluded.",
          "format": "uint64",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "total",
        "active",
        "deactivated",
        "admins",
        "online",
        "away",
        "busy",
        "offline"
      ],
      "type": "object"
    },
    "AdminUserPage": {
      "properties": {
        "items": {
          "items": {
            "$ref": "#/$defs/AdminUser"
          },
          "type": "array"
        },
        "next": {
          "description": "Opaque cursor carrying the last sort key, stable across renames.",
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "items"
      ],
      "type": "object"
    },
    "AnswerForm": {
      "additionalProperties": false,
      "properties": {
        "answers": {
          "additionalProperties": {
            "$ref": "#/$defs/FormAnswer"
          },
          "description": "Field id to its value; a number is sent as its text, a `multiple`\nfield's answers as a list.",
          "type": "object"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "answers"
      ],
      "type": "object"
    },
    "AnswerRing": {
      "additionalProperties": false,
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "e2ee": {
          "type": "boolean"
        },
        "membership_version": {
          "type": "string"
        }
      },
      "required": [
        "membership_version",
        "data_epoch"
      ],
      "type": "object"
    },
    "ApiError": {
      "properties": {
        "code": {
          "type": "string"
        },
        "request_id": {
          "type": "string"
        }
      },
      "required": [
        "code",
        "request_id"
      ],
      "type": "object"
    },
    "ApplicationCancellation": {
      "additionalProperties": false,
      "description": "Durable personal abandonment of the exact original opaque intention.\nNo message ID/position: this is not a delivered message or a room event.",
      "properties": {
        "fingerprint": {
          "type": "string"
        },
        "header": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "room_id",
        "operation_id",
        "header",
        "fingerprint"
      ],
      "type": "object"
    },
    "ApplicationMessage": {
      "additionalProperties": false,
      "properties": {
        "ciphertext": {
          "type": "string"
        },
        "proof": {
          "type": "string"
        },
        "receipt": {
          "$ref": "#/$defs/ApplicationReceipt"
        }
      },
      "required": [
        "receipt",
        "proof",
        "ciphertext"
      ],
      "type": "object"
    },
    "ApplicationReceipt": {
      "additionalProperties": false,
      "properties": {
        "fingerprint": {
          "type": "string"
        },
        "header": {
          "description": "Canonical public Header JSON, base64url. Its u64 fields stay opaque to JS.",
          "type": "string"
        },
        "message_id": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "position": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "room_id",
        "operation_id",
        "header",
        "fingerprint",
        "message_id",
        "position"
      ],
      "type": "object"
    },
    "ApplicationSettlement": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/ApplicationReceipt"
            },
            "kind": {
              "const": "accepted",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/ApplicationCancellation"
            },
            "kind": {
              "const": "cancelled",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        }
      ]
    },
    "ApplicationSubmission": {
      "additionalProperties": false,
      "properties": {
        "ciphertext": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "proof": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "proof",
        "ciphertext"
      ],
      "type": "object"
    },
    "AuthChallenge": {
      "properties": {
        "challenge_id": {
          "type": "string"
        },
        "expires_at": {
          "type": "string"
        },
        "methods": {
          "items": {
            "$ref": "#/$defs/SecondFactor"
          },
          "type": "array"
        },
        "resend_after_seconds": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "challenge_id",
        "methods",
        "expires_at",
        "resend_after_seconds"
      ],
      "type": "object"
    },
    "AuthenticationStep": {
      "description": "Password-only sessions keep the legacy login wire format. This new endpoint\nreturns a challenge without minting any bearer when an account has a factor.",
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "session",
              "type": "string"
            },
            "session": {
              "$ref": "#/$defs/Session"
            }
          },
          "required": [
            "kind",
            "session"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "challenge": {
              "$ref": "#/$defs/AuthChallenge"
            },
            "kind": {
              "const": "challenge",
              "type": "string"
            },
            "user": {
              "$ref": "#/$defs/User"
            }
          },
          "required": [
            "kind",
            "challenge",
            "user"
          ],
          "type": "object"
        }
      ]
    },
    "AvailableKeyPackage": {
      "additionalProperties": false,
      "properties": {
        "device_id": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "reference": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "user_id": {
          "type": "string"
        },
        "wire": {
          "type": "string"
        }
      },
      "required": [
        "scope",
        "user_id",
        "device_id",
        "incarnation",
        "reference",
        "wire"
      ],
      "type": "object"
    },
    "AvatarCommand": {
      "additionalProperties": false,
      "description": "Query accompanying the raw PNG/JPEG body, or DELETE. No user-supplied file path.",
      "properties": {
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "expected_revision"
      ],
      "type": "object"
    },
    "BeginEmailVerification": {
      "additionalProperties": false,
      "properties": {
        "address": {
          "type": "string"
        },
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "expected_version": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "verification_id": {
          "type": "string"
        },
        "verification_version": {
          "type": "string"
        }
      },
      "required": [
        "address",
        "verification_id",
        "operation_id",
        "expected_version",
        "verification_version",
        "context"
      ],
      "type": "object"
    },
    "BeginFactorSetup": {
      "additionalProperties": false,
      "properties": {
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id"
      ],
      "type": "object"
    },
    "BeginReauthentication": {
      "additionalProperties": false,
      "description": "Persist challenge_id (32 CSPRNG bytes as lowercase hex) and operation_id in\nprivate storage before HTTP. Password/OTP are transient, never persisted.",
      "properties": {
        "challenge_id": {
          "type": "string"
        },
        "context": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReauthenticationContext"
            },
            {
              "type": "null"
            }
          ]
        },
        "operation_id": {
          "type": "string"
        },
        "password": {
          "type": "string"
        },
        "proof_version": {
          "type": "string"
        }
      },
      "required": [
        "password",
        "challenge_id",
        "operation_id",
        "proof_version"
      ],
      "type": "object"
    },
    "Bot": {
      "description": "A bot as its owner and the administrators see it.",
      "properties": {
        "avatar_file_id": {
          "default": null,
          "description": "Its photo (`/api/v1/avatars/{id}`), set by its owner or by itself.",
          "type": [
            "string",
            "null"
          ]
        },
        "created_at": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "disabled": {
          "description": "Deactivated by an administrator, or with its owner.",
          "type": "boolean"
        },
        "live_keys": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "owner": {
          "$ref": "#/$defs/User"
        },
        "scopes": {
          "items": {
            "$ref": "#/$defs/BotScope"
          },
          "type": "array"
        },
        "user": {
          "$ref": "#/$defs/User",
          "description": "The bot's account: `user.bot` is always true."
        }
      },
      "required": [
        "user",
        "owner",
        "description",
        "scopes",
        "created_at",
        "disabled",
        "live_keys"
      ],
      "type": "object"
    },
    "BotKey": {
      "description": "A key's public description; the key itself is shown once, at creation.",
      "properties": {
        "created_at": {
          "type": "string"
        },
        "expires_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "hint": {
          "description": "The key's last four characters, to recognise it.",
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "last_used_at": {
          "description": "At most a minute behind.",
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "id",
        "label",
        "hint",
        "created_at"
      ],
      "type": "object"
    },
    "BotKeyCreated": {
      "properties": {
        "info": {
          "$ref": "#/$defs/BotKey"
        },
        "key": {
          "type": "string"
        }
      },
      "required": [
        "key",
        "info"
      ],
      "type": "object"
    },
    "BotKeyList": {
      "properties": {
        "keys": {
          "items": {
            "$ref": "#/$defs/BotKey"
          },
          "type": "array"
        }
      },
      "required": [
        "keys"
      ],
      "type": "object"
    },
    "BotList": {
      "properties": {
        "bots": {
          "items": {
            "$ref": "#/$defs/Bot"
          },
          "type": "array"
        }
      },
      "required": [
        "bots"
      ],
      "type": "object"
    },
    "BotReference": {
      "description": "What a key can reach, read from the table the server enforces, so the apps\nshow their people the same API the gate admits. Every other route is closed.",
      "properties": {
        "direct_per_minute": {
          "description": "New direct conversations a minute per bot.",
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "groups": {
          "items": {
            "$ref": "#/$defs/BotScopeRoutes"
          },
          "type": "array"
        },
        "key_prefix": {
          "type": "string"
        },
        "sends_per_minute": {
          "description": "Sends (and replies) a minute per bot.",
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "key_prefix",
        "groups",
        "sends_per_minute",
        "direct_per_minute"
      ],
      "type": "object"
    },
    "BotRoute": {
      "description": "One route a key may call, as the server matches it (`{room}` is a parameter).",
      "properties": {
        "also": {
          "description": "Further scopes the route needs besides its group's.",
          "items": {
            "$ref": "#/$defs/BotScope"
          },
          "type": "array"
        },
        "method": {
          "type": "string"
        },
        "path": {
          "type": "string"
        }
      },
      "required": [
        "method",
        "path"
      ],
      "type": "object"
    },
    "BotScope": {
      "description": "What a key may do. Routes outside every scope are never open to a key.",
      "oneOf": [
        {
          "const": "rooms:read",
          "description": "Rooms it belongs to: list, details, members, history, threads, files, sync and socket.",
          "type": "string"
        },
        {
          "const": "messages:write",
          "description": "Send and reply; edit and delete its own messages; typing.",
          "type": "string"
        },
        {
          "const": "files:write",
          "description": "Upload files.",
          "type": "string"
        },
        {
          "const": "reactions:write",
          "description": "Add and remove reactions.",
          "type": "string"
        },
        {
          "const": "rooms:join",
          "description": "Browse public rooms, join one, leave a room.",
          "type": "string"
        },
        {
          "const": "users:read",
          "description": "User directory, lookup and profiles.",
          "type": "string"
        },
        {
          "const": "dm:write",
          "description": "Open a direct conversation.",
          "type": "string"
        }
      ]
    },
    "BotScopeRoutes": {
      "description": "The routes one scope opens; `scope` absent: open to every key.",
      "properties": {
        "routes": {
          "items": {
            "$ref": "#/$defs/BotRoute"
          },
          "type": "array"
        },
        "scope": {
          "anyOf": [
            {
              "$ref": "#/$defs/BotScope"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "routes"
      ],
      "type": "object"
    },
    "BotsContract": {
      "properties": {
        "bot": {
          "$ref": "#/$defs/Bot"
        },
        "bot_key": {
          "$ref": "#/$defs/BotKey"
        },
        "bot_key_created": {
          "$ref": "#/$defs/BotKeyCreated"
        },
        "bot_key_list": {
          "$ref": "#/$defs/BotKeyList"
        },
        "bot_list": {
          "$ref": "#/$defs/BotList"
        },
        "bot_reference": {
          "$ref": "#/$defs/BotReference"
        },
        "create_bot": {
          "$ref": "#/$defs/CreateBot"
        },
        "create_bot_key": {
          "$ref": "#/$defs/CreateBotKey"
        },
        "instance_settings": {
          "$ref": "#/$defs/InstanceSettings"
        },
        "update_bot": {
          "$ref": "#/$defs/UpdateBot"
        },
        "update_instance_settings": {
          "$ref": "#/$defs/UpdateInstanceSettings"
        }
      },
      "required": [
        "bot",
        "bot_list",
        "create_bot",
        "update_bot",
        "bot_key",
        "bot_key_list",
        "create_bot_key",
        "bot_key_created",
        "bot_reference",
        "instance_settings",
        "update_instance_settings"
      ],
      "type": "object"
    },
    "CallSummary": {
      "description": "The outcome carried by a direct call's `call_started` row.",
      "properties": {
        "duration_seconds": {
          "description": "Answered calls, once both sides left.",
          "format": "uint32",
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "state": {
          "$ref": "#/$defs/RingState"
        }
      },
      "required": [
        "state"
      ],
      "type": "object"
    },
    "Capabilities": {
      "properties": {
        "account_invitations": {
          "default": false,
          "type": "boolean"
        },
        "account_recovery": {
          "default": false,
          "type": "boolean"
        },
        "administration": {
          "default": false,
          "description": "The `/api/v1/admin/*` routes, for an account with `users.admin`.",
          "type": "boolean"
        },
        "bots": {
          "default": false,
          "description": "Bot accounts with API keys and scopes (RFC 0003).",
          "type": "boolean"
        },
        "calls": {
          "type": "boolean"
        },
        "custom_emoji_admin": {
          "default": false,
          "description": "An administrator adds and removes custom emoji over\n`/api/v1/admin/emoji/{name}`.",
          "type": "boolean"
        },
        "custom_emojis": {
          "default": false,
          "type": "boolean"
        },
        "deletion": {
          "default": false,
          "type": "boolean"
        },
        "device_sessions": {
          "default": false,
          "type": "boolean"
        },
        "direct_messages": {
          "type": "boolean"
        },
        "durable_sync": {
          "type": "boolean"
        },
        "e2ee": {
          "type": "boolean"
        },
        "editing": {
          "default": false,
          "type": "boolean"
        },
        "email_factor_delivery": {
          "default": false,
          "type": "boolean"
        },
        "email_factors": {
          "default": false,
          "type": "boolean"
        },
        "email_recovery": {
          "default": false,
          "type": "boolean"
        },
        "email_removal": {
          "default": false,
          "type": "boolean"
        },
        "email_verification": {
          "default": false,
          "type": "boolean"
        },
        "favorites": {
          "default": false,
          "type": "boolean"
        },
        "fine_permissions": {
          "default": false,
          "type": "boolean"
        },
        "idempotent_room_creation": {
          "default": false,
          "type": "boolean"
        },
        "instance_icon": {
          "default": false,
          "description": "The server has an icon of its own (`Discovery.icon_revision`), which\nan administrator sets over `/api/v1/admin/icon`.",
          "type": "boolean"
        },
        "link_previews": {
          "default": false,
          "type": "boolean"
        },
        "pins": {
          "default": false,
          "type": "boolean"
        },
        "presence": {
          "default": false,
          "type": "boolean"
        },
        "private_rooms": {
          "type": "boolean"
        },
        "profile_avatars": {
          "default": false,
          "type": "boolean"
        },
        "profiles": {
          "default": false,
          "type": "boolean"
        },
        "push": {
          "type": "boolean"
        },
        "quotes": {
          "default": false,
          "type": "boolean"
        },
        "reactions": {
          "type": "boolean"
        },
        "read_markers": {
          "default": false,
          "type": "boolean"
        },
        "reauthentication": {
          "default": false,
          "type": "boolean"
        },
        "reauthentication_retirement": {
          "default": false,
          "type": "boolean"
        },
        "reports": {
          "default": false,
          "description": "Members can report a message or an account to the administrators.",
          "type": "boolean"
        },
        "room_discovery": {
          "default": false,
          "type": "boolean"
        },
        "room_info": {
          "default": false,
          "type": "boolean"
        },
        "room_leave": {
          "default": false,
          "type": "boolean"
        },
        "room_roles": {
          "default": false,
          "type": "boolean"
        },
        "room_settings": {
          "default": false,
          "type": "boolean"
        },
        "search": {
          "default": false,
          "type": "boolean"
        },
        "second_factors": {
          "default": false,
          "type": "boolean"
        },
        "session_rotation": {
          "default": false,
          "type": "boolean"
        },
        "slash_commands": {
          "default": false,
          "type": "boolean"
        },
        "snapshot_paging": {
          "default": false,
          "type": "boolean"
        },
        "stars": {
          "default": false,
          "type": "boolean"
        },
        "structured_cards": {
          "default": false,
          "type": "boolean"
        },
        "text_messages": {
          "type": "boolean"
        },
        "threads": {
          "type": "boolean"
        },
        "typing": {
          "default": false,
          "type": "boolean"
        },
        "uploads": {
          "type": "boolean"
        },
        "voice": {
          "default": false,
          "description": "Voice sessions in every room, voice channels and ringing direct calls.",
          "type": "boolean"
        },
        "workflows": {
          "default": false,
          "description": "Workflows acting through bots (RFC 0004).",
          "type": "boolean"
        }
      },
      "required": [
        "text_messages",
        "private_rooms",
        "direct_messages",
        "durable_sync",
        "threads",
        "reactions",
        "uploads",
        "push",
        "e2ee",
        "calls"
      ],
      "type": "object"
    },
    "CardField": {
      "additionalProperties": false,
      "properties": {
        "short": {
          "default": false,
          "type": "boolean"
        },
        "title": {
          "type": "string"
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "title",
        "value"
      ],
      "type": "object"
    },
    "Change": {
      "oneOf": [
        {
          "properties": {
            "data": {
              "$ref": "#/$defs/Room"
            },
            "type": {
              "const": "room_upsert",
              "type": "string"
            }
          },
          "required": [
            "type",
            "data"
          ],
          "type": "object"
        },
        {
          "properties": {
            "data": {
              "$ref": "#/$defs/Message"
            },
            "type": {
              "const": "message_upsert",
              "type": "string"
            }
          },
          "required": [
            "type",
            "data"
          ],
          "type": "object"
        },
        {
          "properties": {
            "data": {
              "properties": {
                "room_id": {
                  "type": "string"
                }
              },
              "required": [
                "room_id"
              ],
              "type": "object"
            },
            "type": {
              "const": "room_removed",
              "type": "string"
            }
          },
          "required": [
            "type",
            "data"
          ],
          "type": "object"
        }
      ]
    },
    "ChangeEmailFactor": {
      "additionalProperties": false,
      "description": "Pin the displayed contact and installed-factor version before HTTP. The\noriginal operation is retained privately for receipt recovery.",
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "email_version": {
          "type": "string"
        },
        "factor_version": {
          "type": [
            "string",
            "null"
          ]
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "email_version",
        "context"
      ],
      "type": "object"
    },
    "ChangeRoomRole": {
      "additionalProperties": false,
      "properties": {
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "role": {
          "$ref": "#/$defs/RoomRole"
        }
      },
      "required": [
        "operation_id",
        "expected_revision",
        "role"
      ],
      "type": "object"
    },
    "CommandList": {
      "properties": {
        "commands": {
          "items": {
            "$ref": "#/$defs/SlashCommand"
          },
          "type": "array"
        }
      },
      "required": [
        "commands"
      ],
      "type": "object"
    },
    "CommitHistoryShare": {
      "additionalProperties": false,
      "properties": {
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "share": {
          "type": "string"
        }
      },
      "required": [
        "scope",
        "share"
      ],
      "type": "object"
    },
    "CompleteUpload": {
      "additionalProperties": false,
      "properties": {
        "content": {
          "$ref": "#/$defs/MessageContent"
        },
        "operation_id": {
          "type": "string"
        },
        "reply_to": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "operation_id",
        "content"
      ],
      "type": "object"
    },
    "ConfirmEmailVerification": {
      "additionalProperties": false,
      "properties": {
        "code": {
          "type": "string"
        },
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "operation_id": {
          "type": "string"
        },
        "verification_id": {
          "type": "string"
        }
      },
      "required": [
        "verification_id",
        "operation_id",
        "code",
        "context"
      ],
      "type": "object"
    },
    "CreateBot": {
      "additionalProperties": false,
      "properties": {
        "description": {
          "default": "",
          "type": "string"
        },
        "display_name": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "scopes": {
          "default": [],
          "items": {
            "$ref": "#/$defs/BotScope"
          },
          "type": "array"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "username",
        "display_name"
      ],
      "type": "object"
    },
    "CreateBotKey": {
      "additionalProperties": false,
      "description": "Needs a recent sign-in of the person creating it. Replaying the operation\nanswers `bot_key_replayed`: the key is never shown twice.",
      "properties": {
        "expires_in_days": {
          "default": null,
          "description": "None: the key never expires.",
          "format": "uint32",
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "label": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "label"
      ],
      "type": "object"
    },
    "CreateEmoji": {
      "additionalProperties": false,
      "description": "Query of `PUT /api/v1/admin/emoji/{name}`, whose body is the raw PNG, JPEG\nor GIF (at most 1 MiB). `aliases` is comma-separated, empty for none. A\nname already taken answers 409 `revision_conflict`, a code another emoji\nholds `emoji_code_conflict`, a standard emoji's code `emoji_name_reserved`.",
      "properties": {
        "aliases": {
          "default": "",
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id"
      ],
      "type": "object"
    },
    "CreateRoom": {
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
        },
        "operation_id": {
          "description": "Absent only for clients predating durable room creation.",
          "type": [
            "string",
            "null"
          ]
        },
        "private": {
          "type": "boolean"
        },
        "voice": {
          "description": "Sent only to a server announcing `voice`.",
          "type": "boolean"
        }
      },
      "required": [
        "name",
        "private"
      ],
      "type": "object"
    },
    "CreateWorkflow": {
      "additionalProperties": false,
      "properties": {
        "bot_id": {
          "type": "string"
        },
        "description": {
          "default": "",
          "type": "string"
        },
        "enabled": {
          "default": false,
          "type": "boolean"
        },
        "name": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "steps": {
          "items": {
            "$ref": "#/$defs/Step"
          },
          "type": "array"
        },
        "trigger": {
          "$ref": "#/$defs/Trigger"
        }
      },
      "required": [
        "operation_id",
        "name",
        "bot_id",
        "trigger",
        "steps"
      ],
      "type": "object"
    },
    "CustomEmoji": {
      "properties": {
        "aliases": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "bytes": {
          "type": "string"
        },
        "file_id": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "media_type": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "sha256": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "name",
        "aliases",
        "file_id",
        "sha256",
        "media_type",
        "bytes",
        "revision"
      ],
      "type": "object"
    },
    "DeleteAdminUser": {
      "additionalProperties": false,
      "description": "Tombstones the account; its messages stay, attributed to a deleted user.",
      "properties": {
        "operation_id": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "revision"
      ],
      "type": "object"
    },
    "DeleteMessage": {
      "additionalProperties": false,
      "properties": {
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "expected_revision"
      ],
      "type": "object"
    },
    "DeliveryContent": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/GroupEvent"
            },
            "kind": {
              "const": "group",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/ApplicationMessage"
            },
            "kind": {
              "const": "message",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        }
      ]
    },
    "DeliveryEvent": {
      "additionalProperties": false,
      "properties": {
        "content": {
          "$ref": "#/$defs/DeliveryContent"
        },
        "position": {
          "type": "string"
        }
      },
      "required": [
        "position",
        "content"
      ],
      "type": "object"
    },
    "DeliveryPage": {
      "additionalProperties": false,
      "properties": {
        "after": {
          "type": "string"
        },
        "events": {
          "items": {
            "$ref": "#/$defs/DeliveryEvent"
          },
          "type": "array"
        },
        "incarnation": {
          "type": "string"
        },
        "next": {
          "type": [
            "string",
            "null"
          ]
        },
        "room_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "through": {
          "description": "Fixed native position watermark; continue subsequent pages through it.",
          "type": "string"
        }
      },
      "required": [
        "scope",
        "room_id",
        "incarnation",
        "after",
        "through",
        "events"
      ],
      "type": "object"
    },
    "DesktopNotifications": {
      "enum": [
        "default",
        "all",
        "mention",
        "nothing"
      ],
      "type": "string"
    },
    "Device": {
      "additionalProperties": false,
      "properties": {
        "certificate": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "expires_at": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        }
      },
      "required": [
        "device_id",
        "incarnation",
        "certificate",
        "revision",
        "expires_at"
      ],
      "type": "object"
    },
    "DeviceSession": {
      "properties": {
        "created_at": {
          "type": "string"
        },
        "current": {
          "type": "boolean"
        },
        "expires_at": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "last_seen_at": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "label",
        "created_at",
        "last_seen_at",
        "expires_at",
        "current"
      ],
      "type": "object"
    },
    "DirectMessage": {
      "additionalProperties": false,
      "properties": {
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id"
      ],
      "type": "object"
    },
    "Directory": {
      "additionalProperties": false,
      "properties": {
        "devices": {
          "items": {
            "$ref": "#/$defs/Device"
          },
          "type": "array"
        },
        "identity": {
          "anyOf": [
            {
              "$ref": "#/$defs/Identity"
            },
            {
              "type": "null"
            }
          ]
        },
        "next_revocation": {
          "type": [
            "string",
            "null"
          ]
        },
        "revocations": {
          "items": {
            "$ref": "#/$defs/Revocation"
          },
          "type": "array"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "devices",
        "revocations"
      ],
      "type": "object"
    },
    "DisableFactor": {
      "additionalProperties": false,
      "properties": {
        "factor_version": {
          "type": "string"
        }
      },
      "required": [
        "factor_version"
      ],
      "type": "object"
    },
    "Discovery": {
      "properties": {
        "api_path": {
          "type": "string"
        },
        "capabilities": {
          "$ref": "#/$defs/Capabilities"
        },
        "data_epoch": {
          "type": "string"
        },
        "icon_revision": {
          "description": "The icon's revision when the server has one (`GET /api/v1/instance/icon?v=<it>`).",
          "type": [
            "string",
            "null"
          ]
        },
        "instance_id": {
          "type": "string"
        },
        "product": {
          "type": "string"
        },
        "protocol_versions": {
          "items": {
            "format": "uint32",
            "minimum": 0,
            "type": "integer"
          },
          "type": "array"
        },
        "server_version": {
          "type": "string"
        }
      },
      "required": [
        "product",
        "instance_id",
        "data_epoch",
        "server_version",
        "protocol_versions",
        "api_path",
        "capabilities"
      ],
      "type": "object"
    },
    "Document": {
      "properties": {
        "format": {
          "$ref": "#/$defs/Format"
        },
        "nodes": {
          "items": {
            "$ref": "#/$defs/Node"
          },
          "type": "array"
        }
      },
      "required": [
        "format",
        "nodes"
      ],
      "type": "object"
    },
    "EditMessage": {
      "additionalProperties": false,
      "properties": {
        "content": {
          "$ref": "#/$defs/MessageContent"
        },
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "expected_revision",
        "content"
      ],
      "type": "object"
    },
    "EmailDeliveryState": {
      "enum": [
        "queued",
        "sending",
        "deferred",
        "accepted",
        "exhausted"
      ],
      "type": "string"
    },
    "EmailFactorChange": {
      "description": "Codes are private presentation data; never log this receipt with Debug.",
      "properties": {
        "codes": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "email_version": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        },
        "factor_version": {
          "type": "string"
        }
      },
      "required": [
        "enabled",
        "codes",
        "factor_version",
        "email_version",
        "context"
      ],
      "type": "object"
    },
    "EmailRecoveryRequested": {
      "additionalProperties": false,
      "properties": {
        "accepted": {
          "type": "boolean"
        }
      },
      "required": [
        "accepted"
      ],
      "type": "object"
    },
    "EmailRemovalReceipt": {
      "description": "A removal receipt never returns the former private address or a credential.",
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "verification_version": {
          "type": "string"
        },
        "version": {
          "type": "string"
        }
      },
      "required": [
        "version",
        "verification_version",
        "context"
      ],
      "type": "object"
    },
    "EmailStatus": {
      "properties": {
        "address": {
          "type": [
            "string",
            "null"
          ]
        },
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "verification_version": {
          "type": "string"
        },
        "verified_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "version": {
          "type": "string"
        }
      },
      "required": [
        "version",
        "verification_version",
        "context"
      ],
      "type": "object"
    },
    "EmailVerificationStep": {
      "oneOf": [
        {
          "properties": {
            "address": {
              "type": "string"
            },
            "delivery": {
              "$ref": "#/$defs/EmailDeliveryState"
            },
            "expected_version": {
              "type": "string"
            },
            "expires_at": {
              "type": "string"
            },
            "operation_id": {
              "type": "string"
            },
            "state": {
              "const": "pending",
              "type": "string"
            },
            "verification_id": {
              "type": "string"
            },
            "verification_version": {
              "type": "string"
            }
          },
          "required": [
            "state",
            "verification_id",
            "operation_id",
            "address",
            "expires_at",
            "expected_version",
            "verification_version",
            "delivery"
          ],
          "type": "object"
        },
        {
          "properties": {
            "address": {
              "type": "string"
            },
            "state": {
              "const": "verified",
              "type": "string"
            },
            "version": {
              "type": "string"
            }
          },
          "required": [
            "state",
            "address",
            "version"
          ],
          "type": "object"
        }
      ]
    },
    "EmojiCatalog": {
      "properties": {
        "items": {
          "items": {
            "$ref": "#/$defs/CustomEmoji"
          },
          "type": "array"
        },
        "revision": {
          "type": "string"
        }
      },
      "required": [
        "revision",
        "items"
      ],
      "type": "object"
    },
    "EnableFactor": {
      "additionalProperties": false,
      "properties": {
        "code": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "setup_id": {
          "type": "string"
        }
      },
      "required": [
        "setup_id",
        "operation_id",
        "code"
      ],
      "type": "object"
    },
    "EncryptedFile": {
      "additionalProperties": false,
      "description": "A file of a private message (E2EE_FILES.md): only inside the encrypted\ndocument, never in a cleartext route.",
      "properties": {
        "bytes": {
          "description": "Plaintext size, decimal.",
          "type": "string"
        },
        "filename": {
          "type": "string"
        },
        "id": {
          "description": "The upload id, also the server's file id of the opaque object.",
          "type": "string"
        },
        "key": {
          "description": "The file key, 32 bytes in base64url without padding.",
          "type": "string"
        },
        "media_type": {
          "type": "string"
        },
        "sha256": {
          "description": "Plaintext SHA-256, lowercase hex.",
          "type": "string"
        }
      },
      "required": [
        "id",
        "key",
        "filename",
        "media_type",
        "bytes",
        "sha256"
      ],
      "type": "object"
    },
    "EncryptedKeyBackup": {
      "properties": {
        "ciphertext": {
          "type": "string"
        },
        "crypto_identity": {
          "description": "Legacy UID/salt and KDF parameters must survive an import unchanged.",
          "type": "string"
        },
        "format": {
          "type": "string"
        },
        "kdf": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id",
        "format",
        "revision",
        "ciphertext",
        "crypto_identity",
        "kdf"
      ],
      "type": "object"
    },
    "Every": {
      "enum": [
        "hour",
        "day",
        "week"
      ],
      "type": "string"
    },
    "FactorBackupCodes": {
      "properties": {
        "codes": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "factor_version": {
          "description": "Original committed revision, also carried by the encrypted receipt.",
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "codes"
      ],
      "type": "object"
    },
    "FactorEmailDelivery": {
      "properties": {
        "delivery": {
          "$ref": "#/$defs/EmailDeliveryState"
        },
        "expires_at": {
          "type": "string"
        },
        "resend_after_seconds": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "expires_at",
        "delivery",
        "resend_after_seconds"
      ],
      "type": "object"
    },
    "FactorSetup": {
      "properties": {
        "expires_at": {
          "type": "string"
        },
        "provisioning_uri": {
          "type": "string"
        },
        "secret": {
          "type": "string"
        },
        "setup_id": {
          "type": "string"
        }
      },
      "required": [
        "setup_id",
        "secret",
        "provisioning_uri",
        "expires_at"
      ],
      "type": "object"
    },
    "FactorStatus": {
      "properties": {
        "backup_codes_remaining": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "email": {
          "type": "boolean"
        },
        "factor_version": {
          "type": [
            "string",
            "null"
          ]
        },
        "totp": {
          "type": "boolean"
        }
      },
      "required": [
        "totp",
        "email",
        "backup_codes_remaining"
      ],
      "type": "object"
    },
    "FileDescriptor": {
      "properties": {
        "bytes": {
          "type": "string"
        },
        "encrypted": {
          "type": "boolean"
        },
        "filename": {
          "description": "Absent for encrypted files: the filename lives inside client ciphertext.",
          "type": [
            "string",
            "null"
          ]
        },
        "id": {
          "type": "string"
        },
        "media_type": {
          "description": "For ciphertext this is a declaration, not a verified media type.",
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "sha256": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "room_id",
        "bytes",
        "sha256",
        "media_type",
        "encrypted"
      ],
      "type": "object"
    },
    "FinishFactor": {
      "additionalProperties": false,
      "description": "Persist next_token in secure storage before submitting. A retry repeats the\nsame operation/candidate; it never creates a second session using a spent OTP.",
      "properties": {
        "challenge_id": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "method": {
          "$ref": "#/$defs/SecondFactor"
        },
        "next_token": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "challenge_id",
        "method",
        "code",
        "operation_id",
        "next_token"
      ],
      "type": "object"
    },
    "FinishReauthentication": {
      "additionalProperties": false,
      "properties": {
        "challenge_id": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "method": {
          "$ref": "#/$defs/SecondFactor"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "challenge_id",
        "operation_id",
        "method",
        "code"
      ],
      "type": "object"
    },
    "FormAnswer": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "items": {
            "type": "string"
          },
          "type": "array"
        }
      ],
      "description": "One answer, or the list a `multiple` field takes."
    },
    "FormField": {
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string"
        },
        "kind": {
          "$ref": "#/$defs/FormFieldKind"
        },
        "label": {
          "type": "string"
        },
        "multiple": {
          "description": "`choice` and `person` only: several answers (checkboxes) instead of one.",
          "type": "boolean"
        },
        "options": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "people": {
          "description": "`person` only: the user ids it offers; empty, any member of the form's\nroom who is not a bot.",
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "required": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "label",
        "kind"
      ],
      "type": "object"
    },
    "FormFieldKind": {
      "oneOf": [
        {
          "enum": [
            "text",
            "long_text",
            "number",
            "choice"
          ],
          "type": "string"
        },
        {
          "const": "person",
          "description": "Someone: one of `people`, or any member of the room. The answer is a user id.",
          "type": "string"
        }
      ]
    },
    "FormRecipient": {
      "oneOf": [
        {
          "const": "trigger_user",
          "description": "The person whose action started the run (a command, a join).",
          "type": "string"
        },
        {
          "const": "anyone",
          "description": "Any member of the room.",
          "type": "string"
        }
      ]
    },
    "Format": {
      "enum": [
        "native1"
      ],
      "type": "string"
    },
    "GroupCancellation": {
      "additionalProperties": false,
      "properties": {
        "device_id": {
          "type": "string"
        },
        "fingerprint": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "room_id",
        "incarnation",
        "operation_id",
        "device_id",
        "fingerprint"
      ],
      "type": "object"
    },
    "GroupEvent": {
      "additionalProperties": false,
      "properties": {
        "commit": {
          "type": [
            "string",
            "null"
          ]
        },
        "receipt": {
          "$ref": "#/$defs/GroupReceipt"
        },
        "transition": {
          "type": "string"
        },
        "welcome": {
          "anyOf": [
            {
              "$ref": "#/$defs/GroupWelcome"
            },
            {
              "type": "null"
            }
          ],
          "description": "Present only for this device's incarnation and current membership grant."
        }
      },
      "required": [
        "receipt",
        "transition"
      ],
      "type": "object"
    },
    "GroupEventPage": {
      "additionalProperties": false,
      "properties": {
        "events": {
          "items": {
            "$ref": "#/$defs/GroupEvent"
          },
          "type": "array"
        },
        "next": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "events"
      ],
      "type": "object"
    },
    "GroupMember": {
      "additionalProperties": false,
      "properties": {
        "access_version": {
          "type": "string"
        },
        "activation_version": {
          "type": "string"
        },
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id",
        "access_version",
        "activation_version"
      ],
      "type": "object"
    },
    "GroupReceipt": {
      "additionalProperties": false,
      "properties": {
        "epoch": {
          "type": "string"
        },
        "fingerprint": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "room_id",
        "incarnation",
        "operation_id",
        "revision",
        "epoch",
        "fingerprint"
      ],
      "type": "object"
    },
    "GroupRoster": {
      "additionalProperties": false,
      "description": "Current room authority/grants, independent from a submitted signed plan.\nThis is an observation: transition acceptance revalidates every version.",
      "properties": {
        "authority_version": {
          "type": "string"
        },
        "group": {
          "anyOf": [
            {
              "$ref": "#/$defs/GroupReceipt"
            },
            {
              "type": "null"
            }
          ],
          "description": "Public head metadata only; never a Welcome or private MLS material."
        },
        "members": {
          "items": {
            "$ref": "#/$defs/GroupMember"
          },
          "type": "array"
        },
        "room_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "room_id",
        "authority_version",
        "members"
      ],
      "type": "object"
    },
    "GroupSettlement": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/GroupReceipt"
            },
            "kind": {
              "const": "accepted",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/GroupCancellation"
            },
            "kind": {
              "const": "cancelled",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        }
      ]
    },
    "GroupState": {
      "additionalProperties": false,
      "properties": {
        "needs_rekey": {
          "type": "boolean"
        },
        "receipt": {
          "$ref": "#/$defs/GroupReceipt"
        },
        "transition": {
          "type": "string"
        },
        "tree": {
          "type": "string"
        }
      },
      "required": [
        "receipt",
        "needs_rekey",
        "transition",
        "tree"
      ],
      "type": "object"
    },
    "GroupSubmission": {
      "additionalProperties": false,
      "properties": {
        "commit": {
          "type": [
            "string",
            "null"
          ]
        },
        "operation_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "transition": {
          "type": "string"
        },
        "tree": {
          "type": "string"
        },
        "welcomes": {
          "items": {
            "$ref": "#/$defs/GroupWelcome"
          },
          "type": "array"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "transition",
        "tree",
        "welcomes"
      ],
      "type": "object"
    },
    "GroupWelcome": {
      "additionalProperties": false,
      "properties": {
        "device_id": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "key_package_ref": {
          "type": "string"
        },
        "payload": {
          "type": "string"
        }
      },
      "required": [
        "device_id",
        "incarnation",
        "key_package_ref",
        "payload"
      ],
      "type": "object"
    },
    "HistoryBackupPage": {
      "additionalProperties": false,
      "properties": {
        "next": {
          "type": [
            "string",
            "null"
          ]
        },
        "period": {
          "type": "string"
        },
        "records": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "start": {
          "type": "string"
        }
      },
      "required": [
        "period",
        "start",
        "records"
      ],
      "type": "object"
    },
    "HistoryBackupPeriod": {
      "additionalProperties": false,
      "description": "One backed-up period of a generation and its latest signed checkpoint.",
      "properties": {
        "checkpoint": {
          "type": "string"
        },
        "period": {
          "description": "Lowercase hex period id (rv_crypto_public::history_backup::Period::id).",
          "type": "string"
        }
      },
      "required": [
        "period",
        "checkpoint"
      ],
      "type": "object"
    },
    "HistoryBackupPeriods": {
      "additionalProperties": false,
      "properties": {
        "generation": {
          "type": "string"
        },
        "next": {
          "description": "Next page of periods, or none.",
          "type": [
            "string",
            "null"
          ]
        },
        "periods": {
          "items": {
            "$ref": "#/$defs/HistoryBackupPeriod"
          },
          "type": "array"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "generation",
        "periods"
      ],
      "type": "object"
    },
    "HistoryBackupReceipt": {
      "additionalProperties": false,
      "properties": {
        "count": {
          "description": "Ranks the server now holds for this period.",
          "type": "string"
        },
        "period": {
          "type": "string"
        }
      },
      "required": [
        "period",
        "count"
      ],
      "type": "object"
    },
    "HistoryKeyCancellation": {
      "additionalProperties": false,
      "properties": {
        "device_id": {
          "type": "string"
        },
        "device_revision": {
          "type": "string"
        },
        "expected_revision": {
          "type": [
            "string",
            "null"
          ]
        },
        "generation": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "package_digest": {
          "type": "string"
        },
        "root_fingerprint": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "device_id",
        "incarnation",
        "device_revision",
        "root_fingerprint",
        "generation",
        "package_digest"
      ],
      "type": "object"
    },
    "HistoryKeyReceipt": {
      "additionalProperties": false,
      "properties": {
        "device_id": {
          "type": "string"
        },
        "device_revision": {
          "type": "string"
        },
        "generation": {
          "type": "string"
        },
        "generation_revision": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "package_digest": {
          "type": "string"
        },
        "root_fingerprint": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "device_id",
        "incarnation",
        "device_revision",
        "root_fingerprint",
        "generation",
        "generation_revision",
        "package_digest"
      ],
      "type": "object"
    },
    "HistoryKeySettlement": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/HistoryKeyReceipt"
            },
            "kind": {
              "const": "accepted",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/HistoryKeyCancellation"
            },
            "kind": {
              "const": "cancelled",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        }
      ]
    },
    "HistoryKeyState": {
      "additionalProperties": false,
      "properties": {
        "active": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryKeyVersion"
            },
            {
              "type": "null"
            }
          ]
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope"
      ],
      "type": "object"
    },
    "HistoryKeyVersion": {
      "additionalProperties": false,
      "properties": {
        "publication": {
          "type": "string"
        },
        "receipt": {
          "$ref": "#/$defs/HistoryKeyReceipt"
        }
      },
      "required": [
        "publication",
        "receipt"
      ],
      "type": "object"
    },
    "HistoryRecordsPage": {
      "additionalProperties": false,
      "properties": {
        "next": {
          "description": "Start of the next page, or none at the end of the entry.",
          "type": [
            "string",
            "null"
          ]
        },
        "period": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "records": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "start": {
          "type": "string"
        }
      },
      "required": [
        "period",
        "start",
        "records"
      ],
      "type": "object"
    },
    "HistoryRecordsReceipt": {
      "additionalProperties": false,
      "properties": {
        "count": {
          "description": "Records the server now holds for this entry.",
          "type": "string"
        },
        "period": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "period",
        "count"
      ],
      "type": "object"
    },
    "HistoryRequestEntry": {
      "additionalProperties": false,
      "properties": {
        "committed": {
          "type": "boolean"
        },
        "device_id": {
          "type": "string"
        },
        "expires_at": {
          "type": "string"
        },
        "fingerprint": {
          "description": "Lowercase hex request fingerprint.",
          "type": "string"
        },
        "request": {
          "type": "string"
        },
        "sharer_device_id": {
          "description": "Device that claimed the share by uploading its first page.",
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "fingerprint",
        "device_id",
        "request",
        "expires_at",
        "committed"
      ],
      "type": "object"
    },
    "HistoryRequests": {
      "additionalProperties": false,
      "properties": {
        "requests": {
          "items": {
            "$ref": "#/$defs/HistoryRequestEntry"
          },
          "type": "array"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "requests"
      ],
      "type": "object"
    },
    "HistoryShareState": {
      "additionalProperties": false,
      "properties": {
        "fingerprint": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "share": {
          "type": "string"
        },
        "sharer_device_id": {
          "type": "string"
        }
      },
      "required": [
        "scope",
        "fingerprint",
        "sharer_device_id",
        "share"
      ],
      "type": "object"
    },
    "HttpHeader": {
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
        },
        "value": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "value"
      ],
      "type": "object"
    },
    "HttpMethod": {
      "enum": [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE"
      ],
      "type": "string"
    },
    "IconCommand": {
      "additionalProperties": false,
      "description": "Query of `PUT /api/v1/admin/icon` (raw PNG or JPEG body, 2 MiB at most)\nand `DELETE /api/v1/admin/icon`.",
      "properties": {
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id"
      ],
      "type": "object"
    },
    "Identity": {
      "additionalProperties": false,
      "properties": {
        "fingerprint": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "root": {
          "type": "string"
        },
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id",
        "root",
        "fingerprint",
        "revision"
      ],
      "type": "object"
    },
    "InstanceIcon": {
      "description": "The server's icon, as `PUT`/`DELETE /api/v1/admin/icon` answer it:\n`revision` is `None` without one. The image itself is public at\n`GET /api/v1/instance/icon` (PNG, square, 256 pixels at most).",
      "properties": {
        "revision": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "type": "object"
    },
    "InstanceSettings": {
      "description": "Instance-wide settings, administrators only.",
      "properties": {
        "user_bots": {
          "description": "Every account may create bots; administrators always may.",
          "type": "boolean"
        }
      },
      "required": [
        "user_bots"
      ],
      "type": "object"
    },
    "IntegrationCard": {
      "additionalProperties": false,
      "properties": {
        "author": {
          "type": [
            "string",
            "null"
          ]
        },
        "color": {
          "type": [
            "string",
            "null"
          ]
        },
        "fields": {
          "items": {
            "$ref": "#/$defs/CardField"
          },
          "type": "array"
        },
        "text": {
          "type": [
            "string",
            "null"
          ]
        },
        "title": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "type": "object"
    },
    "JoinVoice": {
      "additionalProperties": false,
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "e2ee": {
          "description": "The client encrypts its frames with the group's voice key. Required in\nan encrypted room, where a join without it is refused.",
          "type": "boolean"
        },
        "membership_version": {
          "type": "string"
        },
        "ring": {
          "description": "Direct rooms only: ring the other member. Ignored when a call already rings.",
          "type": "boolean"
        }
      },
      "required": [
        "membership_version",
        "data_epoch"
      ],
      "type": "object"
    },
    "LeaveRoom": {
      "additionalProperties": false,
      "properties": {
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "expected_revision"
      ],
      "type": "object"
    },
    "LinkPreview": {
      "properties": {
        "description": {
          "type": [
            "string",
            "null"
          ]
        },
        "image": {
          "anyOf": [
            {
              "$ref": "#/$defs/PreviewImage"
            },
            {
              "type": "null"
            }
          ]
        },
        "kind": {
          "$ref": "#/$defs/PreviewKind"
        },
        "site": {
          "type": [
            "string",
            "null"
          ]
        },
        "title": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "description": "Original link in the message, including its fragment. The final URL of\na redirect never replaces the author's navigation target.",
          "type": "string"
        }
      },
      "required": [
        "url",
        "kind"
      ],
      "type": "object"
    },
    "LiveFrame": {
      "oneOf": [
        {
          "properties": {
            "data": {
              "$ref": "#/$defs/LiveState"
            },
            "type": {
              "const": "live",
              "type": "string"
            }
          },
          "required": [
            "type",
            "data"
          ],
          "type": "object"
        }
      ]
    },
    "LiveRoom": {
      "properties": {
        "direct_peer": {
          "anyOf": [
            {
              "$ref": "#/$defs/User"
            },
            {
              "type": "null"
            }
          ]
        },
        "membership_version": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "typing": {
          "items": {
            "$ref": "#/$defs/Typist"
          },
          "type": "array"
        },
        "voice": {
          "description": "Accounts connected to this room's voice session.",
          "items": {
            "$ref": "#/$defs/VoiceParticipant"
          },
          "type": "array"
        }
      },
      "required": [
        "room_id",
        "membership_version",
        "typing"
      ],
      "type": "object"
    },
    "LiveState": {
      "properties": {
        "emoji_catalog_revision": {
          "description": "A refresh hint; the authenticated catalogue remains authoritative.",
          "type": [
            "string",
            "null"
          ]
        },
        "limited": {
          "description": "Above the bounded pilot capacity, forget observations rather than truncate them.",
          "type": "boolean"
        },
        "presence": {
          "items": {
            "$ref": "#/$defs/PresenceEntry"
          },
          "type": "array"
        },
        "profiles": {
          "items": {
            "$ref": "#/$defs/ProfileStamp"
          },
          "type": "array"
        },
        "rings": {
          "description": "Direct calls where the reader is caller or callee: ringing, or resolved\nin the last seconds so both sides see the outcome.",
          "items": {
            "$ref": "#/$defs/VoiceRing"
          },
          "type": "array"
        },
        "rooms": {
          "items": {
            "$ref": "#/$defs/LiveRoom"
          },
          "type": "array"
        },
        "ttl_ms": {
          "description": "Receiver-relative lifetime; no client wall clock participates in leases.",
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "ttl_ms",
        "limited",
        "presence",
        "rooms"
      ],
      "type": "object"
    },
    "Login": {
      "additionalProperties": false,
      "properties": {
        "password": {
          "type": "string"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "username",
        "password"
      ],
      "type": "object"
    },
    "MarkRead": {
      "additionalProperties": false,
      "properties": {
        "reply_position": {
          "type": "string"
        },
        "root_position": {
          "type": "string"
        }
      },
      "required": [
        "root_position",
        "reply_position"
      ],
      "type": "object"
    },
    "MarkThreadRead": {
      "additionalProperties": false,
      "properties": {
        "position": {
          "type": "string"
        }
      },
      "required": [
        "position"
      ],
      "type": "object"
    },
    "Message": {
      "properties": {
        "author": {
          "$ref": "#/$defs/User"
        },
        "body": {
          "anyOf": [
            {
              "$ref": "#/$defs/Document"
            },
            {
              "type": "null"
            }
          ],
          "description": "Optional canonical native presentation. Source remains authoritative;\nno Rocket.Chat tree, HTML markup, or authenticated resource URL."
        },
        "call": {
          "anyOf": [
            {
              "$ref": "#/$defs/CallSummary"
            },
            {
              "type": "null"
            }
          ],
          "description": "The outcome of a direct call, on its `call_started` row."
        },
        "cards": {
          "items": {
            "$ref": "#/$defs/IntegrationCard"
          },
          "type": "array"
        },
        "created_at": {
          "type": "string"
        },
        "deleted": {
          "type": "boolean"
        },
        "edited_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "files": {
          "items": {
            "$ref": "#/$defs/FileDescriptor"
          },
          "type": "array"
        },
        "form": {
          "anyOf": [
            {
              "$ref": "#/$defs/WorkflowForm"
            },
            {
              "type": "null"
            }
          ],
          "description": "A form a workflow asks (RFC 0004)."
        },
        "id": {
          "type": "string"
        },
        "personal_mention": {
          "description": "Captured mention eligibility for this reader, including the original\nrecipients of @here. Never persisted in a shared journal payload.",
          "type": [
            "boolean",
            "null"
          ]
        },
        "personal_star": {
          "anyOf": [
            {
              "$ref": "#/$defs/PersonalStar"
            },
            {
              "type": "null"
            }
          ],
          "description": "Present only in account-scoped reads or a journal event for its owner."
        },
        "pinned": {
          "type": "boolean"
        },
        "position": {
          "type": "string"
        },
        "previews": {
          "items": {
            "$ref": "#/$defs/LinkPreview"
          },
          "type": "array"
        },
        "quotes": {
          "description": "Typed references. Excerpts are resolved for this reader, never supplied\nby an author or persisted in a shared journal event.",
          "items": {
            "$ref": "#/$defs/MessageQuote"
          },
          "type": "array"
        },
        "reactions": {
          "items": {
            "$ref": "#/$defs/MessageReaction"
          },
          "type": "array"
        },
        "reply_to": {
          "description": "A reply belongs to the same room as its root. Replies cannot be roots.",
          "type": [
            "string",
            "null"
          ]
        },
        "revision": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "system": {
          "anyOf": [
            {
              "$ref": "#/$defs/SystemMessage"
            },
            {
              "type": "null"
            }
          ],
          "description": "Server-authored, structured room activity. Never accepted by SendMessage."
        },
        "text": {
          "type": "string"
        },
        "thread": {
          "anyOf": [
            {
              "$ref": "#/$defs/ThreadSummary"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id",
        "room_id",
        "author",
        "text",
        "created_at",
        "position",
        "revision"
      ],
      "type": "object"
    },
    "MessageContent": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "files": {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            "kind": {
              "const": "plain",
              "type": "string"
            },
            "markdown": {
              "type": "string"
            },
            "mentions": {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            "quotes": {
              "items": {
                "$ref": "#/$defs/QuoteReference"
              },
              "type": "array"
            }
          },
          "required": [
            "kind",
            "markdown",
            "mentions",
            "quotes",
            "files"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "format": {
              "type": "string"
            },
            "key_version": {
              "type": "string"
            },
            "kind": {
              "const": "encrypted",
              "type": "string"
            },
            "payload": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "format",
            "key_version",
            "payload"
          ],
          "type": "object"
        }
      ]
    },
    "MessagePage": {
      "properties": {
        "has_more": {
          "type": "boolean"
        },
        "messages": {
          "description": "Newest first. The next page uses the last message's position as `before`.",
          "items": {
            "$ref": "#/$defs/Message"
          },
          "type": "array"
        }
      },
      "required": [
        "messages",
        "has_more"
      ],
      "type": "object"
    },
    "MessagePermissions": {
      "properties": {
        "delete": {
          "type": "boolean"
        },
        "edit": {
          "type": "boolean"
        },
        "edit_until": {
          "description": "UTC deadline; None means no time limit, not permission to edit.",
          "type": [
            "string",
            "null"
          ]
        },
        "message_id": {
          "type": "string"
        },
        "pin": {
          "type": "boolean"
        },
        "react": {
          "type": "boolean"
        },
        "revision": {
          "type": "string"
        },
        "star": {
          "type": "boolean"
        }
      },
      "required": [
        "message_id",
        "revision",
        "edit",
        "delete",
        "react",
        "pin",
        "star"
      ],
      "type": "object"
    },
    "MessageQuote": {
      "properties": {
        "excerpt": {
          "anyOf": [
            {
              "$ref": "#/$defs/QuoteExcerpt"
            },
            {
              "type": "null"
            }
          ]
        },
        "reference": {
          "$ref": "#/$defs/QuoteReference"
        },
        "source_membership_version": {
          "type": [
            "string",
            "null"
          ]
        },
        "view_position": {
          "default": "0",
          "description": "Consistent read watermark, including unavailable resolutions. Zero from\nan older prototype must never authorize or restore a cached excerpt.",
          "type": "string"
        }
      },
      "required": [
        "reference"
      ],
      "type": "object"
    },
    "MessageReaction": {
      "properties": {
        "emoji": {
          "type": "string"
        },
        "users": {
          "items": {
            "$ref": "#/$defs/User"
          },
          "type": "array"
        }
      },
      "required": [
        "emoji",
        "users"
      ],
      "type": "object"
    },
    "Node": {
      "oneOf": [
        {
          "properties": {
            "kind": {
              "const": "text",
              "type": "string"
            },
            "text": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "text"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "paragraph",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "bold",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "italic",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "strike",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "kind": {
              "const": "inline_code",
              "type": "string"
            },
            "text": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "text"
          ],
          "type": "object"
        },
        {
          "properties": {
            "kind": {
              "const": "code_block",
              "type": "string"
            },
            "language": {
              "type": "string"
            },
            "text": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "text",
            "language"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "heading",
              "type": "string"
            },
            "level": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "kind",
            "level",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "quote",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "list",
              "type": "string"
            },
            "start": {
              "format": "uint32",
              "minimum": 0,
              "type": [
                "integer",
                "null"
              ]
            }
          },
          "required": [
            "kind",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "checked": {
              "type": [
                "boolean",
                "null"
              ]
            },
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "kind": {
              "const": "list_item",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "children": {
              "items": {
                "$ref": "#/$defs/Node"
              },
              "type": "array"
            },
            "href": {
              "type": "string"
            },
            "kind": {
              "const": "link",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "href",
            "children"
          ],
          "type": "object"
        },
        {
          "properties": {
            "kind": {
              "const": "mention",
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "name"
          ],
          "type": "object"
        },
        {
          "properties": {
            "kind": {
              "const": "room_mention",
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "name"
          ],
          "type": "object"
        },
        {
          "properties": {
            "kind": {
              "const": "emoji",
              "type": "string"
            },
            "shortcode": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "shortcode"
          ],
          "type": "object"
        },
        {
          "properties": {
            "kind": {
              "const": "break",
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "type": "object"
        },
        {
          "properties": {
            "kind": {
              "const": "rule",
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "type": "object"
        }
      ]
    },
    "OperationReceipt": {
      "additionalProperties": false,
      "properties": {
        "device_id": {
          "type": "string"
        },
        "device_revision": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "key_package_refs": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "kind": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "root_fingerprint": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "kind",
        "device_id",
        "incarnation",
        "device_revision",
        "root_fingerprint",
        "key_package_refs"
      ],
      "type": "object"
    },
    "OwnProfile": {
      "properties": {
        "email": {
          "description": "Verified contact, visible only to its owner. Changes use the email proof flow.",
          "type": [
            "string",
            "null"
          ]
        },
        "preferences": {
          "$ref": "#/$defs/UserPreferences"
        },
        "profile": {
          "$ref": "#/$defs/UserProfile"
        }
      },
      "required": [
        "profile",
        "preferences"
      ],
      "type": "object"
    },
    "ParityContract": {
      "description": "Export root for the J0 fixture. Crypto `format` is opaque until the dedicated\nspecification/review; these types make no algorithm or trust guarantee.",
      "properties": {
        "accept_invitation": {
          "anyOf": [
            {
              "$ref": "#/$defs/AcceptInvitation"
            },
            {
              "type": "null"
            }
          ]
        },
        "account_permissions": {
          "$ref": "#/$defs/AccountPermissions"
        },
        "auth_challenge": {
          "$ref": "#/$defs/AuthChallenge"
        },
        "authentication_step": {
          "anyOf": [
            {
              "$ref": "#/$defs/AuthenticationStep"
            },
            {
              "type": "null"
            }
          ]
        },
        "begin_email_verification": {
          "anyOf": [
            {
              "$ref": "#/$defs/BeginEmailVerification"
            },
            {
              "type": "null"
            }
          ]
        },
        "begin_factor_setup": {
          "anyOf": [
            {
              "$ref": "#/$defs/BeginFactorSetup"
            },
            {
              "type": "null"
            }
          ]
        },
        "begin_reauthentication": {
          "anyOf": [
            {
              "$ref": "#/$defs/BeginReauthentication"
            },
            {
              "type": "null"
            }
          ]
        },
        "change_email_factor": {
          "anyOf": [
            {
              "$ref": "#/$defs/ChangeEmailFactor"
            },
            {
              "type": "null"
            }
          ]
        },
        "change_room_role": {
          "anyOf": [
            {
              "$ref": "#/$defs/ChangeRoomRole"
            },
            {
              "type": "null"
            }
          ]
        },
        "complete_upload": {
          "$ref": "#/$defs/CompleteUpload"
        },
        "confirm_email_verification": {
          "anyOf": [
            {
              "$ref": "#/$defs/ConfirmEmailVerification"
            },
            {
              "type": "null"
            }
          ]
        },
        "delete_message": {
          "$ref": "#/$defs/DeleteMessage"
        },
        "device_session": {
          "anyOf": [
            {
              "$ref": "#/$defs/DeviceSession"
            },
            {
              "type": "null"
            }
          ]
        },
        "disable_factor": {
          "anyOf": [
            {
              "$ref": "#/$defs/DisableFactor"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_application_receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/ApplicationReceipt"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_application_settlement": {
          "anyOf": [
            {
              "$ref": "#/$defs/ApplicationSettlement"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_application_submission": {
          "anyOf": [
            {
              "$ref": "#/$defs/ApplicationSubmission"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_available_key_package": {
          "anyOf": [
            {
              "$ref": "#/$defs/AvailableKeyPackage"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_commit_history_share": {
          "anyOf": [
            {
              "$ref": "#/$defs/CommitHistoryShare"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_delivery_page": {
          "anyOf": [
            {
              "$ref": "#/$defs/DeliveryPage"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_directory": {
          "anyOf": [
            {
              "$ref": "#/$defs/Directory"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_group_events": {
          "anyOf": [
            {
              "$ref": "#/$defs/GroupEventPage"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_group_roster": {
          "anyOf": [
            {
              "$ref": "#/$defs/GroupRoster"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_group_settlement": {
          "anyOf": [
            {
              "$ref": "#/$defs/GroupSettlement"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_group_state": {
          "anyOf": [
            {
              "$ref": "#/$defs/GroupState"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_group_submission": {
          "anyOf": [
            {
              "$ref": "#/$defs/GroupSubmission"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_backup_page": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryBackupPage"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_backup_periods": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryBackupPeriods"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_backup_receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryBackupReceipt"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_key": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryKeyState"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_key_settlement": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryKeySettlement"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_records_page": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryRecordsPage"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_records_receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryRecordsReceipt"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_requests": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryRequests"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_history_share": {
          "anyOf": [
            {
              "$ref": "#/$defs/HistoryShareState"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_operation_receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/OperationReceipt"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_publish_history_key": {
          "anyOf": [
            {
              "$ref": "#/$defs/PublishHistoryKey"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_publish_history_request": {
          "anyOf": [
            {
              "$ref": "#/$defs/PublishHistoryRequest"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_publish_key_packages": {
          "anyOf": [
            {
              "$ref": "#/$defs/PublishKeyPackages"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_publish_root_backup": {
          "anyOf": [
            {
              "$ref": "#/$defs/PublishRootBackup"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_register_device": {
          "anyOf": [
            {
              "$ref": "#/$defs/RegisterDevice"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_revoke_device": {
          "anyOf": [
            {
              "$ref": "#/$defs/RevokeDevice"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_root_backup": {
          "anyOf": [
            {
              "$ref": "#/$defs/RootBackupState"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_root_backup_settlement": {
          "anyOf": [
            {
              "$ref": "#/$defs/RootBackupSettlement"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_upload_history_backup": {
          "anyOf": [
            {
              "$ref": "#/$defs/UploadHistoryBackup"
            },
            {
              "type": "null"
            }
          ]
        },
        "e2ee_upload_history_records": {
          "anyOf": [
            {
              "$ref": "#/$defs/UploadHistoryRecords"
            },
            {
              "type": "null"
            }
          ]
        },
        "edit_message": {
          "$ref": "#/$defs/EditMessage"
        },
        "email_factor_change": {
          "anyOf": [
            {
              "$ref": "#/$defs/EmailFactorChange"
            },
            {
              "type": "null"
            }
          ]
        },
        "email_recovery_requested": {
          "anyOf": [
            {
              "$ref": "#/$defs/EmailRecoveryRequested"
            },
            {
              "type": "null"
            }
          ]
        },
        "email_removal_receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/EmailRemovalReceipt"
            },
            {
              "type": "null"
            }
          ]
        },
        "email_status": {
          "anyOf": [
            {
              "$ref": "#/$defs/EmailStatus"
            },
            {
              "type": "null"
            }
          ]
        },
        "email_verification_step": {
          "anyOf": [
            {
              "$ref": "#/$defs/EmailVerificationStep"
            },
            {
              "type": "null"
            }
          ]
        },
        "enable_factor": {
          "anyOf": [
            {
              "$ref": "#/$defs/EnableFactor"
            },
            {
              "type": "null"
            }
          ]
        },
        "factor_backup_codes": {
          "anyOf": [
            {
              "$ref": "#/$defs/FactorBackupCodes"
            },
            {
              "type": "null"
            }
          ]
        },
        "factor_email_delivery": {
          "anyOf": [
            {
              "$ref": "#/$defs/FactorEmailDelivery"
            },
            {
              "type": "null"
            }
          ]
        },
        "factor_setup": {
          "anyOf": [
            {
              "$ref": "#/$defs/FactorSetup"
            },
            {
              "type": "null"
            }
          ]
        },
        "factor_status": {
          "anyOf": [
            {
              "$ref": "#/$defs/FactorStatus"
            },
            {
              "type": "null"
            }
          ]
        },
        "file": {
          "$ref": "#/$defs/FileDescriptor"
        },
        "finish_factor": {
          "anyOf": [
            {
              "$ref": "#/$defs/FinishFactor"
            },
            {
              "type": "null"
            }
          ]
        },
        "finish_reauthentication": {
          "anyOf": [
            {
              "$ref": "#/$defs/FinishReauthentication"
            },
            {
              "type": "null"
            }
          ]
        },
        "key_backup": {
          "$ref": "#/$defs/EncryptedKeyBackup"
        },
        "leave_room": {
          "anyOf": [
            {
              "$ref": "#/$defs/LeaveRoom"
            },
            {
              "type": "null"
            }
          ]
        },
        "mark": {
          "$ref": "#/$defs/SetMark"
        },
        "mark_read": {
          "$ref": "#/$defs/MarkRead"
        },
        "message_permissions": {
          "$ref": "#/$defs/MessagePermissions"
        },
        "preferences": {
          "$ref": "#/$defs/UserPreferences"
        },
        "prepare_upload": {
          "$ref": "#/$defs/PrepareUpload"
        },
        "profile": {
          "$ref": "#/$defs/UserProfile"
        },
        "public_device_key": {
          "$ref": "#/$defs/PublicDeviceKey"
        },
        "reaction": {
          "$ref": "#/$defs/SetReaction"
        },
        "read_state": {
          "$ref": "#/$defs/ReadState"
        },
        "reauthentication_grant": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReauthenticationGrant"
            },
            {
              "type": "null"
            }
          ]
        },
        "reauthentication_status": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReauthenticationStatus"
            },
            {
              "type": "null"
            }
          ]
        },
        "reauthentication_step": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReauthenticationStep"
            },
            {
              "type": "null"
            }
          ]
        },
        "recover_account": {
          "anyOf": [
            {
              "$ref": "#/$defs/RecoverAccount"
            },
            {
              "type": "null"
            }
          ]
        },
        "regenerate_factor_backups": {
          "anyOf": [
            {
              "$ref": "#/$defs/RegenerateFactorBackups"
            },
            {
              "type": "null"
            }
          ]
        },
        "remove_verified_email": {
          "anyOf": [
            {
              "$ref": "#/$defs/RemoveVerifiedEmail"
            },
            {
              "type": "null"
            }
          ]
        },
        "rename_device": {
          "anyOf": [
            {
              "$ref": "#/$defs/RenameDevice"
            },
            {
              "type": "null"
            }
          ]
        },
        "renew_session": {
          "anyOf": [
            {
              "$ref": "#/$defs/RenewSession"
            },
            {
              "type": "null"
            }
          ]
        },
        "request_email_recovery": {
          "anyOf": [
            {
              "$ref": "#/$defs/RequestEmailRecovery"
            },
            {
              "type": "null"
            }
          ]
        },
        "request_factor_email": {
          "anyOf": [
            {
              "$ref": "#/$defs/RequestFactorEmail"
            },
            {
              "type": "null"
            }
          ]
        },
        "resume_email_removal": {
          "anyOf": [
            {
              "$ref": "#/$defs/ResumeEmailRemoval"
            },
            {
              "type": "null"
            }
          ]
        },
        "resume_email_verification": {
          "anyOf": [
            {
              "$ref": "#/$defs/ResumeEmailVerification"
            },
            {
              "type": "null"
            }
          ]
        },
        "resume_reauthentication": {
          "anyOf": [
            {
              "$ref": "#/$defs/ResumeReauthentication"
            },
            {
              "type": "null"
            }
          ]
        },
        "retire_email_removal": {
          "anyOf": [
            {
              "$ref": "#/$defs/RetireEmailRemoval"
            },
            {
              "type": "null"
            }
          ]
        },
        "retire_email_verification": {
          "anyOf": [
            {
              "$ref": "#/$defs/RetireEmailVerification"
            },
            {
              "type": "null"
            }
          ]
        },
        "retire_reauthentication": {
          "anyOf": [
            {
              "$ref": "#/$defs/RetireReauthentication"
            },
            {
              "type": "null"
            }
          ]
        },
        "room_command_receipt": {
          "anyOf": [
            {
              "$ref": "#/$defs/RoomCommandReceipt"
            },
            {
              "type": "null"
            }
          ]
        },
        "room_details": {
          "anyOf": [
            {
              "$ref": "#/$defs/RoomDetails"
            },
            {
              "type": "null"
            }
          ]
        },
        "room_favorite": {
          "anyOf": [
            {
              "$ref": "#/$defs/SetRoomFavorite"
            },
            {
              "type": "null"
            }
          ]
        },
        "room_key_envelope": {
          "$ref": "#/$defs/RoomKeyEnvelope"
        },
        "room_members": {
          "anyOf": [
            {
              "$ref": "#/$defs/RoomMemberPage"
            },
            {
              "type": "null"
            }
          ]
        },
        "room_permissions": {
          "$ref": "#/$defs/RoomPermissions"
        },
        "update_room": {
          "anyOf": [
            {
              "$ref": "#/$defs/UpdateRoom"
            },
            {
              "type": "null"
            }
          ]
        },
        "upload": {
          "$ref": "#/$defs/Upload"
        },
        "verify_factor": {
          "$ref": "#/$defs/VerifyFactor"
        }
      },
      "required": [
        "auth_challenge",
        "verify_factor",
        "account_permissions",
        "room_permissions",
        "message_permissions",
        "read_state",
        "mark_read",
        "edit_message",
        "delete_message",
        "reaction",
        "mark",
        "profile",
        "preferences",
        "file",
        "prepare_upload",
        "complete_upload",
        "upload",
        "public_device_key",
        "key_backup",
        "room_key_envelope"
      ],
      "type": "object"
    },
    "PersonalStar": {
      "properties": {
        "present": {
          "type": "boolean"
        },
        "revision": {
          "description": "Independent private revision: starring never changes the public message.",
          "type": "string"
        }
      },
      "required": [
        "present",
        "revision"
      ],
      "type": "object"
    },
    "PrepareUpload": {
      "additionalProperties": false,
      "properties": {
        "bytes": {
          "type": "string"
        },
        "encrypted": {
          "type": "boolean"
        },
        "filename": {
          "type": [
            "string",
            "null"
          ]
        },
        "media_type": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "sha256": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "room_id",
        "bytes",
        "sha256",
        "media_type",
        "encrypted"
      ],
      "type": "object"
    },
    "PresenceEntry": {
      "properties": {
        "status": {
          "$ref": "#/$defs/PresenceStatus"
        },
        "user": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "user",
        "status"
      ],
      "type": "object"
    },
    "PresenceStatus": {
      "enum": [
        "online",
        "away",
        "busy",
        "offline"
      ],
      "type": "string"
    },
    "PreviewImage": {
      "properties": {
        "bytes": {
          "type": "string"
        },
        "file_id": {
          "type": "string"
        },
        "height": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "media_type": {
          "type": "string"
        },
        "sha256": {
          "type": "string"
        },
        "width": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "file_id",
        "sha256",
        "bytes",
        "width",
        "height",
        "media_type"
      ],
      "type": "object"
    },
    "PreviewKind": {
      "enum": [
        "page",
        "image"
      ],
      "type": "string"
    },
    "ProfileReceipt": {
      "description": "Replays return the original revision; clients refetch the current profile.",
      "properties": {
        "applied_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "applied_revision"
      ],
      "type": "object"
    },
    "ProfileStamp": {
      "description": "Bounded live invalidation; this never changes the durable room cursor.",
      "properties": {
        "avatar_file_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "revision": {
          "type": "string"
        },
        "status_text": {
          "type": "string"
        },
        "user": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "user",
        "revision",
        "status_text"
      ],
      "type": "object"
    },
    "PublicDeviceKey": {
      "properties": {
        "device_id": {
          "type": "string"
        },
        "fingerprint": {
          "type": "string"
        },
        "format": {
          "type": "string"
        },
        "public_key": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id",
        "device_id",
        "format",
        "public_key",
        "fingerprint",
        "revision"
      ],
      "type": "object"
    },
    "PublicRoom": {
      "properties": {
        "joined": {
          "type": "boolean"
        },
        "room": {
          "$ref": "#/$defs/Room"
        }
      },
      "required": [
        "room",
        "joined"
      ],
      "type": "object"
    },
    "PublicRoomPage": {
      "properties": {
        "next": {
          "type": [
            "string",
            "null"
          ]
        },
        "rooms": {
          "items": {
            "$ref": "#/$defs/PublicRoom"
          },
          "type": "array"
        }
      },
      "required": [
        "rooms"
      ],
      "type": "object"
    },
    "PublishHistoryKey": {
      "additionalProperties": false,
      "description": "A new history key generation (E2EE_HISTORY_BACKUP.md): the package sealed\nunder the history code, in a publication signed by the publishing device.",
      "properties": {
        "operation_id": {
          "type": "string"
        },
        "publication": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "publication"
      ],
      "type": "object"
    },
    "PublishHistoryRequest": {
      "additionalProperties": false,
      "description": "A new device's signed history request (E2EE_HISTORY.md). The share and its\nrecords are named by the request fingerprint.",
      "properties": {
        "request": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "request"
      ],
      "type": "object"
    },
    "PublishKeyPackages": {
      "additionalProperties": false,
      "properties": {
        "device_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "packages": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "device_revision",
        "packages"
      ],
      "type": "object"
    },
    "PublishRootBackup": {
      "additionalProperties": false,
      "properties": {
        "operation_id": {
          "type": "string"
        },
        "publication": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "publication"
      ],
      "type": "object"
    },
    "PushContent": {
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        },
        "message": {
          "$ref": "#/$defs/Message"
        },
        "notification_id": {
          "type": "string"
        },
        "room": {
          "$ref": "#/$defs/Room"
        }
      },
      "required": [
        "notification_id",
        "device_id",
        "instance_id",
        "data_epoch",
        "room",
        "message"
      ],
      "type": "object"
    },
    "PushRegistration": {
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        }
      },
      "required": [
        "device_id",
        "instance_id",
        "data_epoch"
      ],
      "type": "object"
    },
    "QuoteExcerpt": {
      "properties": {
        "author": {
          "$ref": "#/$defs/User"
        },
        "created_at": {
          "type": "string"
        },
        "files": {
          "description": "Files of the current source, readable only through its original room.",
          "items": {
            "$ref": "#/$defs/FileDescriptor"
          },
          "type": "array"
        },
        "membership_version": {
          "description": "Reader's current membership lifetime in the source room.",
          "type": "string"
        },
        "quotes": {
          "description": "Reader-resolved children. Presentation stops at two quote levels.",
          "items": {
            "$ref": "#/$defs/MessageQuote"
          },
          "type": "array"
        },
        "references": {
          "description": "Current source references, also present at the rendering depth limit.\nCaches keep these references separately from descendants' private text.",
          "items": {
            "$ref": "#/$defs/QuoteReference"
          },
          "type": "array"
        },
        "revision": {
          "description": "Current source revision, distinct from the author's observed revision.",
          "type": "string"
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "author",
        "text",
        "created_at",
        "revision",
        "membership_version"
      ],
      "type": "object"
    },
    "QuoteReference": {
      "additionalProperties": false,
      "properties": {
        "message_id": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        }
      },
      "required": [
        "room_id",
        "message_id",
        "revision"
      ],
      "type": "object"
    },
    "ReadState": {
      "properties": {
        "favorite": {
          "type": "boolean"
        },
        "favorite_revision": {
          "description": "Independent favorite version; reading or receiving a message does not change it.",
          "type": [
            "string",
            "null"
          ]
        },
        "group_mentions": {
          "type": "string"
        },
        "membership_version": {
          "description": "Membership lifetime nonce, used to purge a missed withdrawal / rejoin.",
          "type": [
            "string",
            "null"
          ]
        },
        "mentions": {
          "type": "string"
        },
        "reply_position": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "root_position": {
          "type": "string"
        },
        "unread_replies": {
          "type": "string"
        },
        "unread_roots": {
          "type": "string"
        }
      },
      "required": [
        "room_id",
        "revision",
        "root_position",
        "reply_position",
        "unread_roots",
        "unread_replies",
        "mentions",
        "group_mentions",
        "favorite"
      ],
      "type": "object"
    },
    "ReauthenticationContext": {
      "additionalProperties": false,
      "description": "Pin proof work to the authenticated account, family and server generation.",
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        },
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id",
        "device_id",
        "instance_id",
        "data_epoch"
      ],
      "type": "object"
    },
    "ReauthenticationGrant": {
      "description": "Metadata about proof on the current family; this is never a credential.",
      "properties": {
        "authenticated_at": {
          "type": "string"
        },
        "data_epoch": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "expires_at": {
          "type": "string"
        },
        "factor_version": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        },
        "proof_version": {
          "type": "string"
        },
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id",
        "device_id",
        "instance_id",
        "data_epoch",
        "factor_version",
        "proof_version",
        "authenticated_at",
        "expires_at"
      ],
      "type": "object"
    },
    "ReauthenticationStatus": {
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        },
        "proof_version": {
          "type": "string"
        },
        "recent": {
          "type": "boolean"
        },
        "user_id": {
          "type": "string"
        }
      },
      "required": [
        "user_id",
        "device_id",
        "instance_id",
        "data_epoch",
        "proof_version",
        "recent"
      ],
      "type": "object"
    },
    "ReauthenticationStep": {
      "oneOf": [
        {
          "properties": {
            "grant": {
              "$ref": "#/$defs/ReauthenticationGrant"
            },
            "kind": {
              "const": "granted",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "grant"
          ],
          "type": "object"
        },
        {
          "properties": {
            "challenge": {
              "$ref": "#/$defs/AuthChallenge"
            },
            "kind": {
              "const": "challenge",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "challenge"
          ],
          "type": "object"
        }
      ]
    },
    "RecoverAccount": {
      "additionalProperties": false,
      "description": "Operator code resets login credentials; it never recovers E2EE keys or\nauthenticates the account in place of its normal second-factor login.",
      "properties": {
        "new_password": {
          "type": "string"
        },
        "token": {
          "type": "string"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "token",
        "username",
        "new_password"
      ],
      "type": "object"
    },
    "RegenerateFactorBackups": {
      "additionalProperties": false,
      "description": "Persist the original operation/version privately before HTTP. A retry\nrecovers the same short-lived code bag on the initiating device.",
      "properties": {
        "factor_version": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "factor_version",
        "operation_id"
      ],
      "type": "object"
    },
    "RegisterDevice": {
      "additionalProperties": false,
      "properties": {
        "expected_device_revision": {
          "type": [
            "string",
            "null"
          ]
        },
        "expected_root_fingerprint": {
          "type": [
            "string",
            "null"
          ]
        },
        "grant": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "request": {
          "type": "string"
        },
        "revoke_previous": {
          "description": "Root-signed revocation of the previous incarnation, on replacement only.",
          "type": [
            "string",
            "null"
          ]
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "request",
        "grant"
      ],
      "type": "object"
    },
    "RegisterPush": {
      "additionalProperties": false,
      "properties": {
        "token": {
          "type": "string"
        }
      },
      "required": [
        "token"
      ],
      "type": "object"
    },
    "RemoveEmoji": {
      "additionalProperties": false,
      "description": "Query of `DELETE /api/v1/admin/emoji/{name}`: the catalogue entry's revision.",
      "properties": {
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "expected_revision"
      ],
      "type": "object"
    },
    "RemoveVerifiedEmail": {
      "additionalProperties": false,
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "expected_version": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "verification_version": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "expected_version",
        "verification_version",
        "context"
      ],
      "type": "object"
    },
    "RenameDevice": {
      "additionalProperties": false,
      "properties": {
        "label": {
          "type": "string"
        }
      },
      "required": [
        "label"
      ],
      "type": "object"
    },
    "RenewSession": {
      "additionalProperties": false,
      "description": "The next bearer is generated securely and durably saved by the client before\nsubmission. Neither this value nor a Session may be logged with Debug.",
      "properties": {
        "next_token": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "next_token"
      ],
      "type": "object"
    },
    "ReportInput": {
      "additionalProperties": false,
      "description": "A member's report of a message or an account. Reporting the same target\nagain keeps one open report and replaces its reason.",
      "properties": {
        "operation_id": {
          "type": "string"
        },
        "reason": {
          "description": "Trimmed, 1 to 1,000 characters.",
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "reason"
      ],
      "type": "object"
    },
    "RequestEmailRecovery": {
      "additionalProperties": false,
      "description": "Anonymous delivery request. Save the random operation before HTTP. No\naddress, UID, delivery status or recovery credential is returned publicly.",
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "username",
        "instance_id",
        "data_epoch"
      ],
      "type": "object"
    },
    "RequestFactorEmail": {
      "additionalProperties": false,
      "description": "A new delivery candidate means an explicit resend. Recovery repeats the\nsame candidate/operation and does not send, mint a code or extend the OTP.",
      "properties": {
        "challenge_id": {
          "type": "string"
        },
        "delivery_id": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "challenge_id",
        "delivery_id",
        "operation_id"
      ],
      "type": "object"
    },
    "ResumeEmailRemoval": {
      "additionalProperties": false,
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "context"
      ],
      "type": "object"
    },
    "ResumeEmailVerification": {
      "additionalProperties": false,
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "operation_id": {
          "type": "string"
        },
        "verification_id": {
          "type": "string"
        }
      },
      "required": [
        "verification_id",
        "operation_id",
        "context"
      ],
      "type": "object"
    },
    "ResumeReauthentication": {
      "additionalProperties": false,
      "properties": {
        "challenge_id": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        }
      },
      "required": [
        "challenge_id",
        "operation_id"
      ],
      "type": "object"
    },
    "RetireEmailRemoval": {
      "additionalProperties": false,
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "expected_version": {
          "type": "string"
        },
        "verification_version": {
          "type": "string"
        }
      },
      "required": [
        "expected_version",
        "verification_version",
        "context"
      ],
      "type": "object"
    },
    "RetireEmailVerification": {
      "additionalProperties": false,
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "expected_version": {
          "type": "string"
        },
        "verification_version": {
          "type": "string"
        }
      },
      "required": [
        "expected_version",
        "verification_version",
        "context"
      ],
      "type": "object"
    },
    "RetireReauthentication": {
      "additionalProperties": false,
      "properties": {
        "context": {
          "$ref": "#/$defs/ReauthenticationContext"
        },
        "proof_version": {
          "type": "string"
        }
      },
      "required": [
        "context",
        "proof_version"
      ],
      "type": "object"
    },
    "Revocation": {
      "additionalProperties": false,
      "properties": {
        "position": {
          "type": "string"
        },
        "signed": {
          "type": "string"
        }
      },
      "required": [
        "position",
        "signed"
      ],
      "type": "object"
    },
    "RevokeDevice": {
      "additionalProperties": false,
      "properties": {
        "device_revision": {
          "description": "Exact registered revision and incarnation of the sending controller.",
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "signed": {
          "description": "Root-signed target device/incarnation; contains no secret material.",
          "type": "string"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "device_revision",
        "incarnation",
        "signed"
      ],
      "type": "object"
    },
    "RingState": {
      "oneOf": [
        {
          "enum": [
            "ringing",
            "answered",
            "declined"
          ],
          "type": "string"
        },
        {
          "const": "missed",
          "description": "Nobody answered before the ring expired.",
          "type": "string"
        },
        {
          "const": "cancelled",
          "description": "The caller left before an answer.",
          "type": "string"
        }
      ]
    },
    "Room": {
      "properties": {
        "encrypted": {
          "description": "An MLS group exists. This metadata grants no key or group admission.",
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "kind": {
          "$ref": "#/$defs/RoomKind"
        },
        "name": {
          "type": "string"
        },
        "read_state": {
          "anyOf": [
            {
              "$ref": "#/$defs/ReadState"
            },
            {
              "type": "null"
            }
          ],
          "description": "Account-scoped state; absent from public journal payloads and old servers."
        },
        "revision": {
          "type": "string"
        },
        "voice": {
          "description": "A voice channel: selecting it joins its voice session. Never a direct room.",
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "name",
        "kind",
        "revision"
      ],
      "type": "object"
    },
    "RoomCommandReceipt": {
      "properties": {
        "applied_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "room_id",
        "applied_revision"
      ],
      "type": "object"
    },
    "RoomDetails": {
      "properties": {
        "announcement": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "member_count": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "permissions": {
          "$ref": "#/$defs/RoomPermissions"
        },
        "read_only": {
          "type": "boolean"
        },
        "revision": {
          "description": "Opaque settings / roster revision, independent from message activity.",
          "type": "string"
        },
        "room": {
          "$ref": "#/$defs/Room"
        },
        "topic": {
          "type": "string"
        },
        "voice": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "room",
        "revision",
        "topic",
        "description",
        "announcement",
        "read_only",
        "member_count",
        "permissions"
      ],
      "type": "object"
    },
    "RoomKeyEnvelope": {
      "properties": {
        "ciphertext": {
          "type": "string"
        },
        "format": {
          "type": "string"
        },
        "key_version": {
          "type": "string"
        },
        "recipient_device_id": {
          "type": "string"
        },
        "recipient_user_id": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "sender_device_id": {
          "type": "string"
        }
      },
      "required": [
        "room_id",
        "key_version",
        "recipient_user_id",
        "recipient_device_id",
        "sender_device_id",
        "format",
        "ciphertext"
      ],
      "type": "object"
    },
    "RoomKind": {
      "enum": [
        "public",
        "private",
        "direct"
      ],
      "type": "string"
    },
    "RoomMember": {
      "properties": {
        "disabled": {
          "type": "boolean"
        },
        "role": {
          "$ref": "#/$defs/RoomRole"
        },
        "user": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "user",
        "role",
        "disabled"
      ],
      "type": "object"
    },
    "RoomMemberPage": {
      "properties": {
        "members": {
          "items": {
            "$ref": "#/$defs/RoomMember"
          },
          "type": "array"
        },
        "next": {
          "type": [
            "string",
            "null"
          ]
        },
        "revision": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        }
      },
      "required": [
        "room_id",
        "revision",
        "members"
      ],
      "type": "object"
    },
    "RoomPermissions": {
      "properties": {
        "change_settings": {
          "type": "boolean"
        },
        "invite": {
          "type": "boolean"
        },
        "pin": {
          "type": "boolean"
        },
        "read": {
          "type": "boolean"
        },
        "remove_member": {
          "type": "boolean"
        },
        "revision": {
          "type": "string"
        },
        "role": {
          "$ref": "#/$defs/RoomRole"
        },
        "room_id": {
          "type": "string"
        },
        "send": {
          "type": "boolean"
        },
        "start_call": {
          "type": "boolean"
        },
        "upload": {
          "type": "boolean"
        }
      },
      "required": [
        "room_id",
        "revision",
        "role",
        "read",
        "send",
        "invite",
        "remove_member",
        "change_settings",
        "pin",
        "upload",
        "start_call"
      ],
      "type": "object"
    },
    "RoomRole": {
      "enum": [
        "owner",
        "moderator",
        "member"
      ],
      "type": "string"
    },
    "RootBackupCancellation": {
      "additionalProperties": false,
      "properties": {
        "backup_id": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "device_revision": {
          "type": "string"
        },
        "expected_revision": {
          "type": [
            "string",
            "null"
          ]
        },
        "incarnation": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "packet_digest": {
          "type": "string"
        },
        "root_fingerprint": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "device_id",
        "incarnation",
        "device_revision",
        "root_fingerprint",
        "backup_id",
        "packet_digest"
      ],
      "type": "object"
    },
    "RootBackupReceipt": {
      "additionalProperties": false,
      "properties": {
        "backup_id": {
          "type": "string"
        },
        "backup_revision": {
          "type": "string"
        },
        "device_id": {
          "type": "string"
        },
        "device_revision": {
          "type": "string"
        },
        "incarnation": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "packet_digest": {
          "type": "string"
        },
        "root_fingerprint": {
          "type": "string"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope",
        "operation_id",
        "device_id",
        "incarnation",
        "device_revision",
        "root_fingerprint",
        "backup_id",
        "backup_revision",
        "packet_digest"
      ],
      "type": "object"
    },
    "RootBackupSettlement": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/RootBackupReceipt"
            },
            "kind": {
              "const": "accepted",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/$defs/RootBackupCancellation"
            },
            "kind": {
              "const": "cancelled",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "data"
          ],
          "type": "object"
        }
      ]
    },
    "RootBackupState": {
      "additionalProperties": false,
      "properties": {
        "active": {
          "anyOf": [
            {
              "$ref": "#/$defs/RootBackupVersion"
            },
            {
              "type": "null"
            }
          ]
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        }
      },
      "required": [
        "scope"
      ],
      "type": "object"
    },
    "RootBackupVersion": {
      "additionalProperties": false,
      "properties": {
        "publication": {
          "type": "string"
        },
        "receipt": {
          "$ref": "#/$defs/RootBackupReceipt"
        }
      },
      "required": [
        "publication",
        "receipt"
      ],
      "type": "object"
    },
    "RunCommand": {
      "additionalProperties": false,
      "properties": {
        "command": {
          "type": "string"
        },
        "params": {
          "description": "Everything after the name, trimmed.",
          "type": "string"
        },
        "room_id": {
          "type": "string"
        }
      },
      "required": [
        "room_id",
        "command",
        "params"
      ],
      "type": "object"
    },
    "RunStarted": {
      "properties": {
        "run_id": {
          "type": "string"
        }
      },
      "required": [
        "run_id"
      ],
      "type": "object"
    },
    "RunState": {
      "enum": [
        "pending",
        "waiting",
        "done",
        "failed",
        "cancelled"
      ],
      "type": "string"
    },
    "Scope": {
      "additionalProperties": false,
      "properties": {
        "data_epoch": {
          "type": "string"
        },
        "instance_id": {
          "type": "string"
        }
      },
      "required": [
        "instance_id",
        "data_epoch"
      ],
      "type": "object"
    },
    "SearchMessages": {
      "additionalProperties": false,
      "properties": {
        "before": {
          "type": [
            "string",
            "null"
          ]
        },
        "limit": {
          "format": "uint16",
          "maximum": 65535,
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "q": {
          "type": "string"
        }
      },
      "required": [
        "q"
      ],
      "type": "object"
    },
    "SearchPage": {
      "properties": {
        "has_more": {
          "type": "boolean"
        },
        "membership_version": {
          "type": "string"
        },
        "messages": {
          "items": {
            "$ref": "#/$defs/Message"
          },
          "type": "array"
        }
      },
      "required": [
        "membership_version",
        "messages",
        "has_more"
      ],
      "type": "object"
    },
    "SecondFactor": {
      "enum": [
        "totp",
        "email",
        "recovery_code"
      ],
      "type": "string"
    },
    "SendMessage": {
      "additionalProperties": false,
      "properties": {
        "cards": {
          "items": {
            "$ref": "#/$defs/IntegrationCard"
          },
          "type": "array"
        },
        "files": {
          "description": "Encrypted files of a private message only (E2EE_FILES.md).",
          "items": {
            "$ref": "#/$defs/EncryptedFile"
          },
          "type": "array"
        },
        "operation_id": {
          "type": "string"
        },
        "quotes": {
          "items": {
            "$ref": "#/$defs/QuoteReference"
          },
          "type": "array"
        },
        "reply_to": {
          "type": [
            "string",
            "null"
          ]
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "text"
      ],
      "type": "object"
    },
    "Session": {
      "properties": {
        "expires_at": {
          "type": "string"
        },
        "token": {
          "type": "string"
        },
        "user": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "token",
        "expires_at",
        "user"
      ],
      "type": "object"
    },
    "SetMark": {
      "additionalProperties": false,
      "properties": {
        "operation_id": {
          "type": "string"
        },
        "present": {
          "type": "boolean"
        }
      },
      "required": [
        "operation_id",
        "present"
      ],
      "type": "object"
    },
    "SetPresence": {
      "properties": {
        "status": {
          "$ref": "#/$defs/PresenceStatus"
        }
      },
      "required": [
        "status"
      ],
      "type": "object"
    },
    "SetReaction": {
      "additionalProperties": false,
      "properties": {
        "emoji": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "present": {
          "type": "boolean"
        }
      },
      "required": [
        "operation_id",
        "emoji",
        "present"
      ],
      "type": "object"
    },
    "SetRoomFavorite": {
      "additionalProperties": false,
      "properties": {
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "present": {
          "type": "boolean"
        }
      },
      "required": [
        "operation_id",
        "expected_revision",
        "present"
      ],
      "type": "object"
    },
    "SetTyping": {
      "properties": {
        "active": {
          "type": "boolean"
        },
        "membership_version": {
          "type": "string"
        },
        "root_id": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "active",
        "membership_version"
      ],
      "type": "object"
    },
    "SlashCommand": {
      "properties": {
        "client_side": {
          "description": "Written by the client (`decorate`), never sent to `commands/run`.",
          "type": "boolean"
        },
        "command": {
          "description": "The name typed after `/`.",
          "type": "string"
        },
        "description": {
          "description": "i18n key of the description (`Slash_Shrug_Description`).",
          "type": "string"
        },
        "literal": {
          "description": "The description is plain text to show as is (a workflow's name), not a key.",
          "type": "boolean"
        },
        "params": {
          "description": "i18n key of what follows the name (`Slash_Topic_Params`), or literal\ntext (`@username`), as Rocket.Chat's `commands.list` gives it.",
          "type": "string"
        }
      },
      "required": [
        "command",
        "params",
        "description",
        "client_side"
      ],
      "type": "object"
    },
    "Snapshot": {
      "properties": {
        "cursor": {
          "type": "string"
        },
        "messages": {
          "items": {
            "$ref": "#/$defs/Message"
          },
          "type": "array"
        },
        "protocol_version": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "rooms": {
          "items": {
            "$ref": "#/$defs/Room"
          },
          "type": "array"
        }
      },
      "required": [
        "protocol_version",
        "rooms",
        "messages",
        "cursor"
      ],
      "type": "object"
    },
    "SnapshotPage": {
      "properties": {
        "cursor": {
          "description": "Only the last page publishes the fixed watermark's replay cursor.",
          "type": [
            "string",
            "null"
          ]
        },
        "messages": {
          "items": {
            "$ref": "#/$defs/Message"
          },
          "type": "array"
        },
        "next": {
          "description": "Opaque page token, authenticated and bound to the same account/generation.",
          "type": [
            "string",
            "null"
          ]
        },
        "page_index": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "protocol_version": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "rooms": {
          "items": {
            "$ref": "#/$defs/Room"
          },
          "type": "array"
        },
        "snapshot_id": {
          "type": "string"
        }
      },
      "required": [
        "protocol_version",
        "snapshot_id",
        "page_index",
        "rooms",
        "messages"
      ],
      "type": "object"
    },
    "SocketTicket": {
      "properties": {
        "expires_at": {
          "type": "string"
        },
        "ticket": {
          "type": "string"
        }
      },
      "required": [
        "ticket",
        "expires_at"
      ],
      "type": "object"
    },
    "Step": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "cards": {
              "items": {
                "$ref": "#/$defs/IntegrationCard"
              },
              "type": "array"
            },
            "in_thread": {
              "type": "boolean"
            },
            "kind": {
              "const": "message",
              "type": "string"
            },
            "room": {
              "type": "string"
            },
            "save_as": {
              "type": [
                "string",
                "null"
              ]
            },
            "text": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "room",
            "text"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "wait",
              "type": "string"
            },
            "seconds": {
              "format": "uint64",
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "kind",
            "seconds"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "body": {
              "type": [
                "string",
                "null"
              ]
            },
            "continue_on_error": {
              "type": "boolean"
            },
            "headers": {
              "items": {
                "$ref": "#/$defs/HttpHeader"
              },
              "type": "array"
            },
            "kind": {
              "const": "http",
              "type": "string"
            },
            "method": {
              "$ref": "#/$defs/HttpMethod"
            },
            "save_as": {
              "type": [
                "string",
                "null"
              ]
            },
            "url": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "method",
            "url"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "fields": {
              "items": {
                "$ref": "#/$defs/FormField"
              },
              "type": "array"
            },
            "kind": {
              "const": "form",
              "type": "string"
            },
            "recipient": {
              "$ref": "#/$defs/FormRecipient"
            },
            "room": {
              "type": "string"
            },
            "save_as": {
              "type": "string"
            },
            "title": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "room",
            "recipient",
            "title",
            "fields",
            "save_as"
          ],
          "type": "object"
        }
      ]
    },
    "SyncBatch": {
      "properties": {
        "changes": {
          "items": {
            "$ref": "#/$defs/Change"
          },
          "type": "array"
        },
        "cursor": {
          "description": "Opaque and bound to the authenticated account and data generation.",
          "type": "string"
        },
        "has_more": {
          "type": "boolean"
        },
        "protocol_version": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "protocol_version",
        "changes",
        "cursor",
        "has_more"
      ],
      "type": "object"
    },
    "SystemMessage": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "call_started",
              "type": "string"
            },
            "meeting_id": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "meeting_id"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "room_created",
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "name"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "room_renamed",
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "name"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "topic_changed",
              "type": "string"
            },
            "topic": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "topic"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "description": {
              "type": "string"
            },
            "kind": {
              "const": "description_changed",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "description"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "announcement": {
              "type": "string"
            },
            "kind": {
              "const": "announcement_changed",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "announcement"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "privacy_changed",
              "type": "string"
            },
            "private": {
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "private"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "read_only_changed",
              "type": "string"
            },
            "read_only": {
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "read_only"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "member_joined",
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "member_left",
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "member_added",
              "type": "string"
            },
            "user": {
              "$ref": "#/$defs/User"
            }
          },
          "required": [
            "kind",
            "user"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "member_removed",
              "type": "string"
            },
            "user": {
              "$ref": "#/$defs/User"
            }
          },
          "required": [
            "kind",
            "user"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "role_changed",
              "type": "string"
            },
            "previous_role": {
              "$ref": "#/$defs/RoomRole"
            },
            "role": {
              "$ref": "#/$defs/RoomRole"
            },
            "user": {
              "$ref": "#/$defs/User"
            }
          },
          "required": [
            "kind",
            "user",
            "previous_role",
            "role"
          ],
          "type": "object"
        }
      ]
    },
    "ThreadPage": {
      "properties": {
        "has_more": {
          "type": "boolean"
        },
        "messages": {
          "description": "Newest first, paged by immutable message position.",
          "items": {
            "$ref": "#/$defs/Message"
          },
          "type": "array"
        },
        "read_state": {
          "$ref": "#/$defs/ThreadReadState"
        },
        "root": {
          "$ref": "#/$defs/Message"
        }
      },
      "required": [
        "root",
        "messages",
        "has_more",
        "read_state"
      ],
      "type": "object"
    },
    "ThreadReadState": {
      "properties": {
        "membership_version": {
          "type": "string"
        },
        "position": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "root_id": {
          "type": "string"
        },
        "unread": {
          "type": "string"
        }
      },
      "required": [
        "root_id",
        "room_id",
        "membership_version",
        "position",
        "revision",
        "unread"
      ],
      "type": "object"
    },
    "ThreadSummary": {
      "properties": {
        "last_reply_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "replies": {
          "type": "string"
        }
      },
      "required": [
        "replies"
      ],
      "type": "object"
    },
    "Trigger": {
      "description": "What starts a run.",
      "oneOf": [
        {
          "additionalProperties": false,
          "description": "`/name text` in a room where the workflow's bot is a member.",
          "properties": {
            "kind": {
              "const": "command",
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "name"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "description": "At `time` in `timezone` (IANA), every hour (minutes only), every day,\nor on the given ISO weekdays (1 Monday .. 7 Sunday).",
          "properties": {
            "days": {
              "items": {
                "format": "uint8",
                "maximum": 255,
                "minimum": 0,
                "type": "integer"
              },
              "type": "array"
            },
            "every": {
              "$ref": "#/$defs/Every"
            },
            "kind": {
              "const": "schedule",
              "type": "string"
            },
            "room": {
              "type": "string"
            },
            "time": {
              "type": "string"
            },
            "timezone": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "every",
            "time",
            "timezone",
            "room"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "description": "Someone (never a bot) joins or is added to the room.",
          "properties": {
            "kind": {
              "const": "member_joined",
              "type": "string"
            },
            "room": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "room"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "description": "A person (never a bot) adds a reaction to a message of the room: any\nemoji, or only `emoji` (a shortcode or a custom emoji's name).",
          "properties": {
            "emoji": {
              "type": [
                "string",
                "null"
              ]
            },
            "kind": {
              "const": "reaction_added",
              "type": "string"
            },
            "room": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "room"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "description": "A person (never a bot) posts a message whose text contains `contains`,\nignoring case. Edits never fire it.",
          "properties": {
            "contains": {
              "type": "string"
            },
            "kind": {
              "const": "message_posted",
              "type": "string"
            },
            "room": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "room",
            "contains"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "description": "`POST /api/v1/hooks/{workflow}/{secret}` with a JSON body.",
          "properties": {
            "kind": {
              "const": "webhook",
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "type": "object"
        }
      ]
    },
    "Typist": {
      "properties": {
        "root_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "user": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "user"
      ],
      "type": "object"
    },
    "UpdateAdminUser": {
      "additionalProperties": false,
      "description": "Absent fields are kept. My own admin right and activation cannot be changed.",
      "properties": {
        "admin": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "disabled": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "operation_id": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "revision"
      ],
      "type": "object"
    },
    "UpdateBot": {
      "additionalProperties": false,
      "description": "Absent fields keep their value. The photo has its own route,\n`PUT`/`DELETE /api/v1/bots/{id}/avatar`; the bot may also edit its own\nprofile with its key through `/me`.",
      "properties": {
        "description": {
          "default": null,
          "type": [
            "string",
            "null"
          ]
        },
        "display_name": {
          "default": null,
          "type": [
            "string",
            "null"
          ]
        },
        "operation_id": {
          "type": "string"
        },
        "scopes": {
          "default": null,
          "items": {
            "$ref": "#/$defs/BotScope"
          },
          "type": [
            "array",
            "null"
          ]
        }
      },
      "required": [
        "operation_id"
      ],
      "type": "object"
    },
    "UpdateInstanceSettings": {
      "additionalProperties": false,
      "properties": {
        "operation_id": {
          "type": "string"
        },
        "user_bots": {
          "default": null,
          "type": [
            "boolean",
            "null"
          ]
        }
      },
      "required": [
        "operation_id"
      ],
      "type": "object"
    },
    "UpdatePreferences": {
      "additionalProperties": false,
      "properties": {
        "clock_24h": {
          "type": "boolean"
        },
        "desktop_notifications": {
          "$ref": "#/$defs/DesktopNotifications"
        },
        "expected_revision": {
          "type": "string"
        },
        "language": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "push_enabled": {
          "type": "boolean"
        },
        "push_mentions_only": {
          "type": "boolean"
        }
      },
      "required": [
        "operation_id",
        "expected_revision",
        "language",
        "clock_24h",
        "push_enabled",
        "push_mentions_only",
        "desktop_notifications"
      ],
      "type": "object"
    },
    "UpdateProfile": {
      "additionalProperties": false,
      "properties": {
        "bio": {
          "type": "string"
        },
        "display_name": {
          "type": "string"
        },
        "expected_revision": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "status": {
          "$ref": "#/$defs/PresenceStatus"
        },
        "status_text": {
          "type": "string"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "operation_id",
        "expected_revision",
        "username",
        "display_name",
        "bio",
        "status",
        "status_text"
      ],
      "type": "object"
    },
    "UpdateRoom": {
      "additionalProperties": false,
      "properties": {
        "announcement": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "expected_revision": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "private": {
          "type": "boolean"
        },
        "read_only": {
          "type": "boolean"
        },
        "topic": {
          "type": "string"
        },
        "voice": {
          "description": "None leaves the flag unchanged; sent only to a server announcing `voice`.",
          "type": [
            "boolean",
            "null"
          ]
        }
      },
      "required": [
        "operation_id",
        "expected_revision",
        "name",
        "private",
        "topic",
        "description",
        "announcement",
        "read_only"
      ],
      "type": "object"
    },
    "UpdateWorkflow": {
      "additionalProperties": false,
      "description": "The whole definition at the expected revision.",
      "properties": {
        "bot_id": {
          "type": "string"
        },
        "description": {
          "default": "",
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        },
        "name": {
          "type": "string"
        },
        "operation_id": {
          "type": "string"
        },
        "revision": {
          "type": "string"
        },
        "steps": {
          "items": {
            "$ref": "#/$defs/Step"
          },
          "type": "array"
        },
        "trigger": {
          "$ref": "#/$defs/Trigger"
        }
      },
      "required": [
        "operation_id",
        "revision",
        "name",
        "bot_id",
        "trigger",
        "steps",
        "enabled"
      ],
      "type": "object"
    },
    "Upload": {
      "properties": {
        "expires_at": {
          "type": "string"
        },
        "file": {
          "$ref": "#/$defs/FileDescriptor"
        },
        "id": {
          "type": "string"
        },
        "message_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "state": {
          "$ref": "#/$defs/UploadState"
        }
      },
      "required": [
        "id",
        "file",
        "state",
        "expires_at"
      ],
      "type": "object"
    },
    "UploadHistoryBackup": {
      "additionalProperties": false,
      "description": "Records of ranks `start + 1 ..= start + records.len()` of one period and\nthe checkpoint signed after them: at most 200 records and 4 MiB.",
      "properties": {
        "checkpoint": {
          "type": "string"
        },
        "records": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "start": {
          "type": "string"
        }
      },
      "required": [
        "scope",
        "start",
        "records",
        "checkpoint"
      ],
      "type": "object"
    },
    "UploadHistoryRecords": {
      "additionalProperties": false,
      "description": "Records of ranks `start + 1 ..= start + records.len()` of one manifest\nentry: at most 200 records and 4 MiB.",
      "properties": {
        "period": {
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "records": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "start": {
          "type": "string"
        }
      },
      "required": [
        "scope",
        "period",
        "start",
        "records"
      ],
      "type": "object"
    },
    "UploadState": {
      "enum": [
        "prepared",
        "ready",
        "completed",
        "cancelled",
        "expired"
      ],
      "type": "string"
    },
    "User": {
      "properties": {
        "bot": {
          "description": "A bot account (RFC 0003), owned by a person and acting with API keys.",
          "type": "boolean"
        },
        "deleted": {
          "description": "A tombstoned account: its messages stay, shown as a deleted user. Its\nusername is a reserved `deleted-` placeholder and its display name empty.",
          "type": "boolean"
        },
        "display_name": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "username": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "username",
        "display_name"
      ],
      "type": "object"
    },
    "UserPreferences": {
      "properties": {
        "clock_24h": {
          "type": "boolean"
        },
        "desktop_notifications": {
          "$ref": "#/$defs/DesktopNotifications",
          "default": "default"
        },
        "language": {
          "type": "string"
        },
        "push_enabled": {
          "type": "boolean"
        },
        "push_mentions_only": {
          "type": "boolean"
        },
        "revision": {
          "type": "string"
        }
      },
      "required": [
        "revision",
        "language",
        "clock_24h",
        "push_enabled",
        "push_mentions_only"
      ],
      "type": "object"
    },
    "UserProfile": {
      "properties": {
        "avatar_file_id": {
          "description": "Protected resource ID, never an arbitrary URL carrying credentials.",
          "type": [
            "string",
            "null"
          ]
        },
        "bio": {
          "type": "string"
        },
        "bot_owner": {
          "anyOf": [
            {
              "$ref": "#/$defs/User"
            },
            {
              "type": "null"
            }
          ],
          "description": "The person who owns this bot; absent for a person."
        },
        "revision": {
          "type": "string"
        },
        "status": {
          "$ref": "#/$defs/PresenceStatus",
          "default": "online"
        },
        "status_text": {
          "type": "string"
        },
        "user": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "user",
        "revision",
        "bio",
        "status_text"
      ],
      "type": "object"
    },
    "VerifyFactor": {
      "additionalProperties": false,
      "properties": {
        "challenge_id": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "method": {
          "$ref": "#/$defs/SecondFactor"
        }
      },
      "required": [
        "challenge_id",
        "method",
        "code"
      ],
      "type": "object"
    },
    "VoiceGrant": {
      "properties": {
        "can_publish": {
          "description": "False in a read-only room for a plain member: listening only.",
          "type": "boolean"
        },
        "e2ee": {
          "description": "The room is encrypted: the client must encrypt and decrypt every frame\nwith the group's voice key, or leave.",
          "type": "boolean"
        },
        "expires_at": {
          "type": "string"
        },
        "ring": {
          "anyOf": [
            {
              "$ref": "#/$defs/VoiceRing"
            },
            {
              "type": "null"
            }
          ],
          "description": "The ring this join started or answered."
        },
        "room_id": {
          "type": "string"
        },
        "token": {
          "type": "string"
        },
        "url": {
          "description": "LiveKit signalling origin (`wss://` in production).",
          "type": "string"
        }
      },
      "required": [
        "room_id",
        "url",
        "token",
        "expires_at",
        "can_publish"
      ],
      "type": "object"
    },
    "VoiceParticipant": {
      "description": "One account connected to a room's voice session, as the SFU last reported it.",
      "properties": {
        "camera": {
          "description": "Publishing an unmuted camera.",
          "type": "boolean"
        },
        "deafened": {
          "type": "boolean"
        },
        "muted": {
          "type": "boolean"
        },
        "screen": {
          "description": "Holds the room's screen share (one per room, `POST /api/v1/voice/screen`).",
          "type": "boolean"
        },
        "user": {
          "$ref": "#/$defs/User"
        }
      },
      "required": [
        "user",
        "muted",
        "deafened"
      ],
      "type": "object"
    },
    "VoiceRing": {
      "properties": {
        "callee": {
          "$ref": "#/$defs/User"
        },
        "caller": {
          "$ref": "#/$defs/User"
        },
        "expires_in_ms": {
          "description": "Receiver-relative time left while ringing; zero once resolved.",
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "id": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "state": {
          "$ref": "#/$defs/RingState"
        }
      },
      "required": [
        "id",
        "room_id",
        "caller",
        "callee",
        "state",
        "expires_in_ms"
      ],
      "type": "object"
    },
    "WebhookSecret": {
      "description": "The only answer that carries the webhook secret.",
      "properties": {
        "path": {
          "description": "`/api/v1/hooks/{workflow}/{secret}`, to put after the server address.",
          "type": "string"
        }
      },
      "required": [
        "path"
      ],
      "type": "object"
    },
    "Workflow": {
      "description": "A workflow as its owner and the administrators see it.",
      "properties": {
        "bot": {
          "$ref": "#/$defs/User"
        },
        "created_at": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        },
        "has_webhook": {
          "default": false,
          "description": "Whether a webhook secret exists; the secret itself is shown once.",
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "last_run": {
          "anyOf": [
            {
              "$ref": "#/$defs/WorkflowRun"
            },
            {
              "type": "null"
            }
          ]
        },
        "name": {
          "type": "string"
        },
        "next_fire_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "owner": {
          "$ref": "#/$defs/User"
        },
        "revision": {
          "type": "string"
        },
        "steps": {
          "items": {
            "$ref": "#/$defs/Step"
          },
          "type": "array"
        },
        "trigger": {
          "$ref": "#/$defs/Trigger"
        },
        "updated_at": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "owner",
        "bot",
        "name",
        "description",
        "enabled",
        "trigger",
        "steps",
        "revision",
        "created_at",
        "updated_at"
      ],
      "type": "object"
    },
    "WorkflowForm": {
      "description": "A form a workflow posted, carried by its message.",
      "properties": {
        "answered_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "answered_by": {
          "anyOf": [
            {
              "$ref": "#/$defs/User"
            },
            {
              "type": "null"
            }
          ]
        },
        "expires_at": {
          "description": "Past it the form takes no answer.",
          "type": "string"
        },
        "fields": {
          "items": {
            "$ref": "#/$defs/FormField"
          },
          "type": "array"
        },
        "people": {
          "description": "The people the `person` fields name, to show them.",
          "items": {
            "$ref": "#/$defs/User"
          },
          "type": "array"
        },
        "recipient": {
          "anyOf": [
            {
              "$ref": "#/$defs/User"
            },
            {
              "type": "null"
            }
          ],
          "description": "Only this person may answer; absent: any member of the room."
        },
        "title": {
          "type": "string"
        }
      },
      "required": [
        "title",
        "fields",
        "expires_at"
      ],
      "type": "object"
    },
    "WorkflowList": {
      "properties": {
        "workflows": {
          "items": {
            "$ref": "#/$defs/Workflow"
          },
          "type": "array"
        }
      },
      "required": [
        "workflows"
      ],
      "type": "object"
    },
    "WorkflowRun": {
      "properties": {
        "created_at": {
          "type": "string"
        },
        "error": {
          "type": [
            "string",
            "null"
          ]
        },
        "id": {
          "type": "string"
        },
        "state": {
          "$ref": "#/$defs/RunState"
        },
        "step": {
          "description": "The step about to run, or the last one run.",
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "updated_at": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "state",
        "step",
        "created_at",
        "updated_at"
      ],
      "type": "object"
    },
    "WorkflowRunList": {
      "properties": {
        "runs": {
          "items": {
            "$ref": "#/$defs/WorkflowRun"
          },
          "type": "array"
        }
      },
      "required": [
        "runs"
      ],
      "type": "object"
    },
    "WorkflowsContract": {
      "properties": {
        "answer_form": {
          "$ref": "#/$defs/AnswerForm"
        },
        "create_workflow": {
          "$ref": "#/$defs/CreateWorkflow"
        },
        "run_started": {
          "$ref": "#/$defs/RunStarted"
        },
        "update_workflow": {
          "$ref": "#/$defs/UpdateWorkflow"
        },
        "webhook_secret": {
          "$ref": "#/$defs/WebhookSecret"
        },
        "workflow": {
          "$ref": "#/$defs/Workflow"
        },
        "workflow_form": {
          "$ref": "#/$defs/WorkflowForm"
        },
        "workflow_list": {
          "$ref": "#/$defs/WorkflowList"
        },
        "workflow_run_list": {
          "$ref": "#/$defs/WorkflowRunList"
        }
      },
      "required": [
        "workflow",
        "workflow_list",
        "create_workflow",
        "update_workflow",
        "workflow_run_list",
        "webhook_secret",
        "run_started",
        "workflow_form",
        "answer_form"
      ],
      "type": "object"
    }
  },
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Single schema root, also used by the TypeScript binding generator.",
  "properties": {
    "administration": {
      "$ref": "#/$defs/AdminContract"
    },
    "answer_ring": {
      "$ref": "#/$defs/AnswerRing"
    },
    "avatar_command": {
      "$ref": "#/$defs/AvatarCommand"
    },
    "bots": {
      "$ref": "#/$defs/BotsContract"
    },
    "command_list": {
      "$ref": "#/$defs/CommandList"
    },
    "create_room": {
      "$ref": "#/$defs/CreateRoom"
    },
    "direct_message": {
      "$ref": "#/$defs/DirectMessage"
    },
    "discovery": {
      "$ref": "#/$defs/Discovery"
    },
    "emoji_catalog": {
      "$ref": "#/$defs/EmojiCatalog"
    },
    "error": {
      "$ref": "#/$defs/ApiError"
    },
    "join_voice": {
      "$ref": "#/$defs/JoinVoice"
    },
    "live_frame": {
      "$ref": "#/$defs/LiveFrame"
    },
    "login": {
      "$ref": "#/$defs/Login"
    },
    "mark_thread_read": {
      "$ref": "#/$defs/MarkThreadRead"
    },
    "message": {
      "$ref": "#/$defs/Message"
    },
    "message_page": {
      "$ref": "#/$defs/MessagePage"
    },
    "own_profile": {
      "$ref": "#/$defs/OwnProfile"
    },
    "parity": {
      "$ref": "#/$defs/ParityContract"
    },
    "profile_receipt": {
      "$ref": "#/$defs/ProfileReceipt"
    },
    "public_room_page": {
      "$ref": "#/$defs/PublicRoomPage"
    },
    "push_content": {
      "$ref": "#/$defs/PushContent"
    },
    "push_registration": {
      "$ref": "#/$defs/PushRegistration"
    },
    "register_push": {
      "$ref": "#/$defs/RegisterPush"
    },
    "room": {
      "$ref": "#/$defs/Room"
    },
    "run_command": {
      "$ref": "#/$defs/RunCommand"
    },
    "search_messages": {
      "$ref": "#/$defs/SearchMessages"
    },
    "search_page": {
      "$ref": "#/$defs/SearchPage"
    },
    "send_message": {
      "$ref": "#/$defs/SendMessage"
    },
    "session": {
      "$ref": "#/$defs/Session"
    },
    "set_presence": {
      "$ref": "#/$defs/SetPresence"
    },
    "set_typing": {
      "$ref": "#/$defs/SetTyping"
    },
    "snapshot": {
      "$ref": "#/$defs/Snapshot"
    },
    "snapshot_page": {
      "$ref": "#/$defs/SnapshotPage"
    },
    "socket_ticket": {
      "$ref": "#/$defs/SocketTicket"
    },
    "sync_batch": {
      "$ref": "#/$defs/SyncBatch"
    },
    "thread_page": {
      "$ref": "#/$defs/ThreadPage"
    },
    "update_preferences": {
      "$ref": "#/$defs/UpdatePreferences"
    },
    "update_profile": {
      "$ref": "#/$defs/UpdateProfile"
    },
    "voice_grant": {
      "$ref": "#/$defs/VoiceGrant"
    },
    "voice_ring": {
      "$ref": "#/$defs/VoiceRing"
    },
    "workflows": {
      "$ref": "#/$defs/WorkflowsContract"
    }
  },
  "required": [
    "register_push",
    "push_registration",
    "push_content",
    "emoji_catalog",
    "own_profile",
    "update_profile",
    "update_preferences",
    "avatar_command",
    "profile_receipt",
    "search_messages",
    "search_page",
    "live_frame",
    "join_voice",
    "answer_ring",
    "voice_grant",
    "voice_ring",
    "set_presence",
    "set_typing",
    "discovery",
    "login",
    "session",
    "room",
    "create_room",
    "public_room_page",
    "direct_message",
    "send_message",
    "message",
    "message_page",
    "thread_page",
    "mark_thread_read",
    "snapshot",
    "snapshot_page",
    "sync_batch",
    "socket_ticket",
    "error",
    "command_list",
    "run_command",
    "administration",
    "bots",
    "workflows",
    "parity"
  ],
  "title": "Contract",
  "type": "object"
} as const;
