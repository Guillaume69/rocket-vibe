// Generated from crates/rv-protocol. Run scripts/generate-native-protocol.mjs.
export type AccountPermissions = { "create_private_room": boolean; "create_public_room": boolean; "manage_accounts": boolean; "manage_instance": boolean; };
export type ApiError = { "code": string; "request_id": string; };
export type AuthChallenge = { "challenge_id": string; "expires_at": string; "methods": (SecondFactor)[]; "resend_after_seconds": number; };
export type Capabilities = { "calls": boolean; "custom_emojis"?: boolean; "deletion"?: boolean; "direct_messages": boolean; "durable_sync": boolean; "e2ee": boolean; "editing"?: boolean; "favorites"?: boolean; "idempotent_room_creation"?: boolean; "pins"?: boolean; "presence"?: boolean; "private_rooms": boolean; "profiles"?: boolean; "push": boolean; "quotes"?: boolean; "reactions": boolean; "read_markers"?: boolean; "room_discovery"?: boolean; "room_info"?: boolean; "search"?: boolean; "snapshot_paging"?: boolean; "stars"?: boolean; "text_messages": boolean; "threads": boolean; "typing"?: boolean; "uploads": boolean; };
export type Change = { "data": Room; "type": "room_upsert"; } | { "data": Message; "type": "message_upsert"; } | { "data": { "room_id": string; }; "type": "room_removed"; };
export type CompleteUpload = { "content": MessageContent; "operation_id": string; "reply_to"?: string | null; };
export type CreateRoom = { "name": string; "operation_id"?: string | null; "private": boolean; };
export type DeleteMessage = { "expected_revision": string; "operation_id": string; };
export type DirectMessage = { "user_id": string; };
export type Discovery = { "api_path": string; "capabilities": Capabilities; "data_epoch": string; "instance_id": string; "product": string; "protocol_versions": (number)[]; "server_version": string; };
export type EditMessage = { "content": MessageContent; "expected_revision": string; "operation_id": string; };
export type EncryptedKeyBackup = { "ciphertext": string; "crypto_identity": string; "format": string; "kdf": string; "revision": string; "user_id": string; };
export type FileDescriptor = { "bytes": string; "encrypted": boolean; "filename"?: string | null; "id": string; "media_type": string; "room_id": string; "sha256": string; };
export type Login = { "password": string; "username": string; };
export type MarkRead = { "reply_position": string; "root_position": string; };
export type Message = { "author": User; "created_at": string; "id": string; "position": string; "revision": string; "room_id": string; "text": string; };
export type MessageContent = { "files": (string)[]; "kind": "plain"; "markdown": string; "mentions": (string)[]; "quotes": (QuoteReference)[]; } | { "format": string; "key_version": string; "kind": "encrypted"; "payload": string; };
export type MessagePage = { "has_more": boolean; "messages": (Message)[]; };
export type MessagePermissions = { "delete": boolean; "edit": boolean; "edit_until"?: string | null; "message_id": string; "pin": boolean; "react": boolean; "revision": string; "star": boolean; };
export type ParityContract = { "account_permissions": AccountPermissions; "auth_challenge": AuthChallenge; "complete_upload": CompleteUpload; "delete_message": DeleteMessage; "edit_message": EditMessage; "file": FileDescriptor; "key_backup": EncryptedKeyBackup; "mark": SetMark; "mark_read": MarkRead; "message_permissions": MessagePermissions; "preferences": UserPreferences; "prepare_upload": PrepareUpload; "profile": UserProfile; "public_device_key": PublicDeviceKey; "reaction": SetReaction; "read_state": ReadState; "room_key_envelope": RoomKeyEnvelope; "room_permissions": RoomPermissions; "verify_factor": VerifyFactor; };
export type PrepareUpload = { "bytes": string; "encrypted": boolean; "filename"?: string | null; "media_type": string; "operation_id": string; "room_id": string; "sha256": string; };
export type PublicDeviceKey = { "device_id": string; "fingerprint": string; "format": string; "public_key": string; "revision": string; "user_id": string; };
export type PublicRoom = { "joined": boolean; "room": Room; };
export type PublicRoomPage = { "next"?: string | null; "rooms": (PublicRoom)[]; };
export type QuoteReference = { "message_id": string; "revision": string; "room_id": string; };
export type ReadState = { "favorite": boolean; "group_mentions": string; "mentions": string; "reply_position": string; "revision": string; "room_id": string; "root_position": string; "unread_replies": string; "unread_roots": string; };
export type Room = { "id": string; "kind": RoomKind; "name": string; "revision": string; };
export type RoomKeyEnvelope = { "ciphertext": string; "format": string; "key_version": string; "recipient_device_id": string; "recipient_user_id": string; "room_id": string; "sender_device_id": string; };
export type RoomKind = "public" | "private" | "direct";
export type RoomPermissions = { "change_settings": boolean; "invite": boolean; "pin": boolean; "read": boolean; "remove_member": boolean; "revision": string; "role": RoomRole; "room_id": string; "send": boolean; "start_call": boolean; "upload": boolean; };
export type RoomRole = "owner" | "moderator" | "member";
export type SecondFactor = "totp" | "email" | "recovery_code";
export type SendMessage = { "operation_id": string; "text": string; };
export type Session = { "expires_at": string; "token": string; "user": User; };
export type SetMark = { "present": boolean; };
export type SetReaction = { "emoji": string; "present": boolean; };
export type Snapshot = { "cursor": string; "messages": (Message)[]; "protocol_version": number; "rooms": (Room)[]; };
export type SnapshotPage = { "cursor"?: string | null; "messages": (Message)[]; "next"?: string | null; "page_index": number; "protocol_version": number; "rooms": (Room)[]; "snapshot_id": string; };
export type SocketTicket = { "expires_at": string; "ticket": string; };
export type SyncBatch = { "changes": (Change)[]; "cursor": string; "has_more": boolean; "protocol_version": number; };
export type User = { "display_name": string; "id": string; "username": string; };
export type UserPreferences = { "clock_24h": boolean; "language": string; "push_enabled": boolean; "push_mentions_only": boolean; "revision": string; };
export type UserProfile = { "avatar_file_id"?: string | null; "bio": string; "revision": string; "status_text": string; "user": User; };
export type VerifyFactor = { "challenge_id": string; "code": string; "method": SecondFactor; };

export type NativeTypes = { AccountPermissions: AccountPermissions; ApiError: ApiError; AuthChallenge: AuthChallenge; Capabilities: Capabilities; Change: Change; CompleteUpload: CompleteUpload; CreateRoom: CreateRoom; DeleteMessage: DeleteMessage; DirectMessage: DirectMessage; Discovery: Discovery; EditMessage: EditMessage; EncryptedKeyBackup: EncryptedKeyBackup; FileDescriptor: FileDescriptor; Login: Login; MarkRead: MarkRead; Message: Message; MessageContent: MessageContent; MessagePage: MessagePage; MessagePermissions: MessagePermissions; ParityContract: ParityContract; PrepareUpload: PrepareUpload; PublicDeviceKey: PublicDeviceKey; PublicRoom: PublicRoom; PublicRoomPage: PublicRoomPage; QuoteReference: QuoteReference; ReadState: ReadState; Room: Room; RoomKeyEnvelope: RoomKeyEnvelope; RoomKind: RoomKind; RoomPermissions: RoomPermissions; RoomRole: RoomRole; SecondFactor: SecondFactor; SendMessage: SendMessage; Session: Session; SetMark: SetMark; SetReaction: SetReaction; Snapshot: Snapshot; SnapshotPage: SnapshotPage; SocketTicket: SocketTicket; SyncBatch: SyncBatch; User: User; UserPreferences: UserPreferences; UserProfile: UserProfile; VerifyFactor: VerifyFactor; };

export const nativeSchema = {
  "$defs": {
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
    "Capabilities": {
      "properties": {
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
        "favorites": {
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
        "id": {
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
    "ParityContract": {
      "description": "Export root for the J0 fixture. Crypto `format` is opaque until the dedicated\nspecification/review; these types make no algorithm or trust guarantee.",
      "properties": {
        "account_permissions": {
          "$ref": "#/$defs/AccountPermissions"
        },
        "auth_challenge": {
          "$ref": "#/$defs/AuthChallenge"
        },
        "complete_upload": {
          "$ref": "#/$defs/CompleteUpload"
        },
        "delete_message": {
          "$ref": "#/$defs/DeleteMessage"
        },
        "edit_message": {
          "$ref": "#/$defs/EditMessage"
        },
        "file": {
          "$ref": "#/$defs/FileDescriptor"
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
        "present": {
          "type": "boolean"
        }
      },
      "required": [
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
        "present": {
          "type": "boolean"
        }
      },
      "required": [
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
