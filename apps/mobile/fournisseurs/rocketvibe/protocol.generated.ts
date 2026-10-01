// Generated from crates/rv-protocol. Run scripts/generate-native-protocol.mjs.
export type AcceptInvitation = { "password": string; "token": string; "username": string; };
export type AccountPermissions = { "create_private_room": boolean; "create_public_room": boolean; "manage_accounts": boolean; "manage_instance": boolean; };
export type ApiError = { "code": string; "request_id": string; };
export type AuthChallenge = { "challenge_id": string; "expires_at": string; "methods": (SecondFactor)[]; "resend_after_seconds": number; };
export type AuthenticationStep = { "kind": "session"; "session": Session; } | { "challenge": AuthChallenge; "kind": "challenge"; "user": User; };
export type BeginEmailVerification = { "address": string; "context": ReauthenticationContext; "expected_version": string; "operation_id": string; "verification_id": string; "verification_version": string; };
export type BeginFactorSetup = { "operation_id": string; };
export type BeginReauthentication = { "challenge_id": string; "context"?: ReauthenticationContext | null; "operation_id": string; "password": string; "proof_version": string; };
export type Capabilities = { "account_invitations"?: boolean; "account_recovery"?: boolean; "calls": boolean; "custom_emojis"?: boolean; "deletion"?: boolean; "device_sessions"?: boolean; "direct_messages": boolean; "durable_sync": boolean; "e2ee": boolean; "editing"?: boolean; "email_removal"?: boolean; "email_verification"?: boolean; "favorites"?: boolean; "fine_permissions"?: boolean; "idempotent_room_creation"?: boolean; "pins"?: boolean; "presence"?: boolean; "private_rooms": boolean; "profiles"?: boolean; "push": boolean; "quotes"?: boolean; "reactions": boolean; "read_markers"?: boolean; "reauthentication"?: boolean; "reauthentication_retirement"?: boolean; "room_discovery"?: boolean; "room_info"?: boolean; "search"?: boolean; "second_factors"?: boolean; "session_rotation"?: boolean; "snapshot_paging"?: boolean; "stars"?: boolean; "text_messages": boolean; "threads": boolean; "typing"?: boolean; "uploads": boolean; };
export type Change = { "data": Room; "type": "room_upsert"; } | { "data": Message; "type": "message_upsert"; } | { "data": { "room_id": string; }; "type": "room_removed"; };
export type CompleteUpload = { "content": MessageContent; "operation_id": string; "reply_to"?: string | null; };
export type ConfirmEmailVerification = { "code": string; "context": ReauthenticationContext; "operation_id": string; "verification_id": string; };
export type CreateRoom = { "name": string; "operation_id"?: string | null; "private": boolean; };
export type DeleteMessage = { "expected_revision": string; "operation_id": string; };
export type DeviceSession = { "created_at": string; "current": boolean; "expires_at": string; "id": string; "label": string; "last_seen_at": string; };
export type DirectMessage = { "user_id": string; };
export type DisableFactor = { "factor_version": string; };
export type Discovery = { "api_path": string; "capabilities": Capabilities; "data_epoch": string; "instance_id": string; "product": string; "protocol_versions": (number)[]; "server_version": string; };
export type EditMessage = { "content": MessageContent; "expected_revision": string; "operation_id": string; };
export type EmailDeliveryState = "queued" | "sending" | "deferred" | "accepted" | "exhausted";
export type EmailRemovalReceipt = { "context": ReauthenticationContext; "verification_version": string; "version": string; };
export type EmailStatus = { "address"?: string | null; "context": ReauthenticationContext; "verification_version": string; "verified_at"?: string | null; "version": string; };
export type EmailVerificationStep = { "address": string; "delivery": EmailDeliveryState; "expected_version": string; "expires_at": string; "operation_id": string; "state": "pending"; "verification_id": string; "verification_version": string; } | { "address": string; "state": "verified"; "version": string; };
export type EnableFactor = { "code": string; "operation_id": string; "setup_id": string; };
export type EncryptedKeyBackup = { "ciphertext": string; "crypto_identity": string; "format": string; "kdf": string; "revision": string; "user_id": string; };
export type FactorBackupCodes = { "codes": (string)[]; "factor_version"?: string | null; };
export type FactorSetup = { "expires_at": string; "provisioning_uri": string; "secret": string; "setup_id": string; };
export type FactorStatus = { "backup_codes_remaining": number; "email": boolean; "factor_version"?: string | null; "totp": boolean; };
export type FileDescriptor = { "bytes": string; "encrypted": boolean; "filename"?: string | null; "id": string; "media_type": string; "room_id": string; "sha256": string; };
export type FinishFactor = { "challenge_id": string; "code": string; "method": SecondFactor; "next_token": string; "operation_id": string; };
export type FinishReauthentication = { "challenge_id": string; "code": string; "method": SecondFactor; "operation_id": string; };
export type Login = { "password": string; "username": string; };
export type MarkRead = { "reply_position": string; "root_position": string; };
export type Message = { "author": User; "created_at": string; "deleted"?: boolean; "edited_at"?: string | null; "id": string; "personal_star"?: PersonalStar | null; "pinned"?: boolean; "position": string; "reactions"?: (MessageReaction)[]; "revision": string; "room_id": string; "text": string; };
export type MessageContent = { "files": (string)[]; "kind": "plain"; "markdown": string; "mentions": (string)[]; "quotes": (QuoteReference)[]; } | { "format": string; "key_version": string; "kind": "encrypted"; "payload": string; };
export type MessagePage = { "has_more": boolean; "messages": (Message)[]; };
export type MessagePermissions = { "delete": boolean; "edit": boolean; "edit_until"?: string | null; "message_id": string; "pin": boolean; "react": boolean; "revision": string; "star": boolean; };
export type MessageReaction = { "emoji": string; "users": (User)[]; };
export type ParityContract = { "accept_invitation"?: AcceptInvitation | null; "account_permissions": AccountPermissions; "auth_challenge": AuthChallenge; "authentication_step"?: AuthenticationStep | null; "begin_email_verification"?: BeginEmailVerification | null; "begin_factor_setup"?: BeginFactorSetup | null; "begin_reauthentication"?: BeginReauthentication | null; "complete_upload": CompleteUpload; "confirm_email_verification"?: ConfirmEmailVerification | null; "delete_message": DeleteMessage; "device_session"?: DeviceSession | null; "disable_factor"?: DisableFactor | null; "edit_message": EditMessage; "email_removal_receipt"?: EmailRemovalReceipt | null; "email_status"?: EmailStatus | null; "email_verification_step"?: EmailVerificationStep | null; "enable_factor"?: EnableFactor | null; "factor_backup_codes"?: FactorBackupCodes | null; "factor_setup"?: FactorSetup | null; "factor_status"?: FactorStatus | null; "file": FileDescriptor; "finish_factor"?: FinishFactor | null; "finish_reauthentication"?: FinishReauthentication | null; "key_backup": EncryptedKeyBackup; "mark": SetMark; "mark_read": MarkRead; "message_permissions": MessagePermissions; "preferences": UserPreferences; "prepare_upload": PrepareUpload; "profile": UserProfile; "public_device_key": PublicDeviceKey; "reaction": SetReaction; "read_state": ReadState; "reauthentication_grant"?: ReauthenticationGrant | null; "reauthentication_status"?: ReauthenticationStatus | null; "reauthentication_step"?: ReauthenticationStep | null; "recover_account"?: RecoverAccount | null; "regenerate_factor_backups"?: RegenerateFactorBackups | null; "remove_verified_email"?: RemoveVerifiedEmail | null; "rename_device"?: RenameDevice | null; "renew_session"?: RenewSession | null; "resume_email_removal"?: ResumeEmailRemoval | null; "resume_email_verification"?: ResumeEmailVerification | null; "resume_reauthentication"?: ResumeReauthentication | null; "retire_email_removal"?: RetireEmailRemoval | null; "retire_email_verification"?: RetireEmailVerification | null; "retire_reauthentication"?: RetireReauthentication | null; "room_key_envelope": RoomKeyEnvelope; "room_permissions": RoomPermissions; "verify_factor": VerifyFactor; };
export type PersonalStar = { "present": boolean; "revision": string; };
export type PrepareUpload = { "bytes": string; "encrypted": boolean; "filename"?: string | null; "media_type": string; "operation_id": string; "room_id": string; "sha256": string; };
export type PublicDeviceKey = { "device_id": string; "fingerprint": string; "format": string; "public_key": string; "revision": string; "user_id": string; };
export type PublicRoom = { "joined": boolean; "room": Room; };
export type PublicRoomPage = { "next"?: string | null; "rooms": (PublicRoom)[]; };
export type QuoteReference = { "message_id": string; "revision": string; "room_id": string; };
export type ReadState = { "favorite": boolean; "group_mentions": string; "mentions": string; "reply_position": string; "revision": string; "room_id": string; "root_position": string; "unread_replies": string; "unread_roots": string; };
export type ReauthenticationContext = { "data_epoch": string; "device_id": string; "instance_id": string; "user_id": string; };
export type ReauthenticationGrant = { "authenticated_at": string; "data_epoch": string; "device_id": string; "expires_at": string; "factor_version": string; "instance_id": string; "proof_version": string; "user_id": string; };
export type ReauthenticationStatus = { "data_epoch": string; "device_id": string; "instance_id": string; "proof_version": string; "recent": boolean; "user_id": string; };
export type ReauthenticationStep = { "grant": ReauthenticationGrant; "kind": "granted"; } | { "challenge": AuthChallenge; "kind": "challenge"; };
export type RecoverAccount = { "new_password": string; "token": string; "username": string; };
export type RegenerateFactorBackups = { "factor_version": string; "operation_id": string; };
export type RemoveVerifiedEmail = { "context": ReauthenticationContext; "expected_version": string; "operation_id": string; "verification_version": string; };
export type RenameDevice = { "label": string; };
export type RenewSession = { "next_token": string; "operation_id": string; };
export type ResumeEmailRemoval = { "context": ReauthenticationContext; "operation_id": string; };
export type ResumeEmailVerification = { "context": ReauthenticationContext; "operation_id": string; "verification_id": string; };
export type ResumeReauthentication = { "challenge_id": string; "operation_id": string; };
export type RetireEmailRemoval = { "context": ReauthenticationContext; "expected_version": string; "verification_version": string; };
export type RetireEmailVerification = { "context": ReauthenticationContext; "expected_version": string; "verification_version": string; };
export type RetireReauthentication = { "context": ReauthenticationContext; "proof_version": string; };
export type Room = { "id": string; "kind": RoomKind; "name": string; "revision": string; };
export type RoomKeyEnvelope = { "ciphertext": string; "format": string; "key_version": string; "recipient_device_id": string; "recipient_user_id": string; "room_id": string; "sender_device_id": string; };
export type RoomKind = "public" | "private" | "direct";
export type RoomPermissions = { "change_settings": boolean; "invite": boolean; "pin": boolean; "read": boolean; "remove_member": boolean; "revision": string; "role": RoomRole; "room_id": string; "send": boolean; "start_call": boolean; "upload": boolean; };
export type RoomRole = "owner" | "moderator" | "member";
export type SecondFactor = "totp" | "email" | "recovery_code";
export type SendMessage = { "operation_id": string; "text": string; };
export type Session = { "expires_at": string; "token": string; "user": User; };
export type SetMark = { "operation_id": string; "present": boolean; };
export type SetReaction = { "emoji": string; "operation_id": string; "present": boolean; };
export type Snapshot = { "cursor": string; "messages": (Message)[]; "protocol_version": number; "rooms": (Room)[]; };
export type SnapshotPage = { "cursor"?: string | null; "messages": (Message)[]; "next"?: string | null; "page_index": number; "protocol_version": number; "rooms": (Room)[]; "snapshot_id": string; };
export type SocketTicket = { "expires_at": string; "ticket": string; };
export type SyncBatch = { "changes": (Change)[]; "cursor": string; "has_more": boolean; "protocol_version": number; };
export type User = { "display_name": string; "id": string; "username": string; };
export type UserPreferences = { "clock_24h": boolean; "language": string; "push_enabled": boolean; "push_mentions_only": boolean; "revision": string; };
export type UserProfile = { "avatar_file_id"?: string | null; "bio": string; "revision": string; "status_text": string; "user": User; };
export type VerifyFactor = { "challenge_id": string; "code": string; "method": SecondFactor; };

export type NativeTypes = { AcceptInvitation: AcceptInvitation; AccountPermissions: AccountPermissions; ApiError: ApiError; AuthChallenge: AuthChallenge; AuthenticationStep: AuthenticationStep; BeginEmailVerification: BeginEmailVerification; BeginFactorSetup: BeginFactorSetup; BeginReauthentication: BeginReauthentication; Capabilities: Capabilities; Change: Change; CompleteUpload: CompleteUpload; ConfirmEmailVerification: ConfirmEmailVerification; CreateRoom: CreateRoom; DeleteMessage: DeleteMessage; DeviceSession: DeviceSession; DirectMessage: DirectMessage; DisableFactor: DisableFactor; Discovery: Discovery; EditMessage: EditMessage; EmailDeliveryState: EmailDeliveryState; EmailRemovalReceipt: EmailRemovalReceipt; EmailStatus: EmailStatus; EmailVerificationStep: EmailVerificationStep; EnableFactor: EnableFactor; EncryptedKeyBackup: EncryptedKeyBackup; FactorBackupCodes: FactorBackupCodes; FactorSetup: FactorSetup; FactorStatus: FactorStatus; FileDescriptor: FileDescriptor; FinishFactor: FinishFactor; FinishReauthentication: FinishReauthentication; Login: Login; MarkRead: MarkRead; Message: Message; MessageContent: MessageContent; MessagePage: MessagePage; MessagePermissions: MessagePermissions; MessageReaction: MessageReaction; ParityContract: ParityContract; PersonalStar: PersonalStar; PrepareUpload: PrepareUpload; PublicDeviceKey: PublicDeviceKey; PublicRoom: PublicRoom; PublicRoomPage: PublicRoomPage; QuoteReference: QuoteReference; ReadState: ReadState; ReauthenticationContext: ReauthenticationContext; ReauthenticationGrant: ReauthenticationGrant; ReauthenticationStatus: ReauthenticationStatus; ReauthenticationStep: ReauthenticationStep; RecoverAccount: RecoverAccount; RegenerateFactorBackups: RegenerateFactorBackups; RemoveVerifiedEmail: RemoveVerifiedEmail; RenameDevice: RenameDevice; RenewSession: RenewSession; ResumeEmailRemoval: ResumeEmailRemoval; ResumeEmailVerification: ResumeEmailVerification; ResumeReauthentication: ResumeReauthentication; RetireEmailRemoval: RetireEmailRemoval; RetireEmailVerification: RetireEmailVerification; RetireReauthentication: RetireReauthentication; Room: Room; RoomKeyEnvelope: RoomKeyEnvelope; RoomKind: RoomKind; RoomPermissions: RoomPermissions; RoomRole: RoomRole; SecondFactor: SecondFactor; SendMessage: SendMessage; Session: Session; SetMark: SetMark; SetReaction: SetReaction; Snapshot: Snapshot; SnapshotPage: SnapshotPage; SocketTicket: SocketTicket; SyncBatch: SyncBatch; User: User; UserPreferences: UserPreferences; UserProfile: UserProfile; VerifyFactor: VerifyFactor; };

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
        "calls": {
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
        "room_discovery": {
          "default": false,
          "type": "boolean"
        },
        "room_info": {
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
        "snapshot_paging": {
          "default": false,
          "type": "boolean"
        },
        "stars": {
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
        }
      },
      "required": [
        "name",
        "private"
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
    "Message": {
      "properties": {
        "author": {
          "$ref": "#/$defs/User"
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
        "id": {
          "type": "string"
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
        "reactions": {
          "items": {
            "$ref": "#/$defs/MessageReaction"
          },
          "type": "array"
        },
        "revision": {
          "type": "string"
        },
        "room_id": {
          "type": "string"
        },
        "text": {
          "type": "string"
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
        "edit_message": {
          "$ref": "#/$defs/EditMessage"
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
        "room_key_envelope": {
          "$ref": "#/$defs/RoomKeyEnvelope"
        },
        "room_permissions": {
          "$ref": "#/$defs/RoomPermissions"
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
    "QuoteReference": {
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
        "group_mentions": {
          "type": "string"
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
    "Room": {
      "properties": {
        "id": {
          "type": "string"
        },
        "kind": {
          "$ref": "#/$defs/RoomKind"
        },
        "name": {
          "type": "string"
        },
        "revision": {
          "type": "string"
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
        "operation_id": {
          "type": "string"
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
    "User": {
      "properties": {
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
    }
  },
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Single schema root, also used by the TypeScript binding generator.",
  "properties": {
    "create_room": {
      "$ref": "#/$defs/CreateRoom"
    },
    "direct_message": {
      "$ref": "#/$defs/DirectMessage"
    },
    "discovery": {
      "$ref": "#/$defs/Discovery"
    },
    "error": {
      "$ref": "#/$defs/ApiError"
    },
    "login": {
      "$ref": "#/$defs/Login"
    },
    "message": {
      "$ref": "#/$defs/Message"
    },
    "message_page": {
      "$ref": "#/$defs/MessagePage"
    },
    "parity": {
      "$ref": "#/$defs/ParityContract"
    },
    "public_room_page": {
      "$ref": "#/$defs/PublicRoomPage"
    },
    "room": {
      "$ref": "#/$defs/Room"
    },
    "send_message": {
      "$ref": "#/$defs/SendMessage"
    },
    "session": {
      "$ref": "#/$defs/Session"
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
    }
  },
  "required": [
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
    "snapshot",
    "snapshot_page",
    "sync_batch",
    "socket_ticket",
    "error",
    "parity"
  ],
  "title": "Contract",
  "type": "object"
} as const;
