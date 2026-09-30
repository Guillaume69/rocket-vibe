// Generated from crates/rv-protocol. Run scripts/generate-native-protocol.mjs.
export type ApiError = { "code": string; "request_id": string; };
export type Capabilities = { "calls": boolean; "direct_messages": boolean; "durable_sync": boolean; "e2ee": boolean; "private_rooms": boolean; "push": boolean; "reactions": boolean; "text_messages": boolean; "threads": boolean; "uploads": boolean; };
export type Change = { "data": Room; "type": "room_upsert"; } | { "data": Message; "type": "message_upsert"; } | { "data": { "room_id": string; }; "type": "room_removed"; };
export type CreateRoom = { "name": string; "private": boolean; };
export type DirectMessage = { "user_id": string; };
export type Discovery = { "api_path": string; "capabilities": Capabilities; "data_epoch": string; "instance_id": string; "product": string; "protocol_versions": (number)[]; "server_version": string; };
export type Login = { "password": string; "username": string; };
export type Message = { "author": User; "created_at": string; "id": string; "position": string; "revision": string; "room_id": string; "text": string; };
export type MessagePage = { "has_more": boolean; "messages": (Message)[]; };
export type Room = { "id": string; "kind": RoomKind; "name": string; "revision": string; };
export type RoomKind = "public" | "private" | "direct";
export type SendMessage = { "operation_id": string; "text": string; };
export type Session = { "expires_at": string; "token": string; "user": User; };
export type Snapshot = { "cursor": string; "messages": (Message)[]; "protocol_version": number; "rooms": (Room)[]; };
export type SocketTicket = { "expires_at": string; "ticket": string; };
export type SyncBatch = { "changes": (Change)[]; "cursor": string; "has_more": boolean; "protocol_version": number; };
export type User = { "display_name": string; "id": string; "username": string; };

export type NativeTypes = { ApiError: ApiError; Capabilities: Capabilities; Change: Change; CreateRoom: CreateRoom; DirectMessage: DirectMessage; Discovery: Discovery; Login: Login; Message: Message; MessagePage: MessagePage; Room: Room; RoomKind: RoomKind; SendMessage: SendMessage; Session: Session; Snapshot: Snapshot; SocketTicket: SocketTicket; SyncBatch: SyncBatch; User: User; };

export const nativeSchema = {
  "$defs": {
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
    "Capabilities": {
      "properties": {
        "calls": {
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
        "private_rooms": {
          "type": "boolean"
        },
        "push": {
          "type": "boolean"
        },
        "reactions": {
          "type": "boolean"
        },
        "text_messages": {
          "type": "boolean"
        },
        "threads": {
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
    "CreateRoom": {
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
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
    "RoomKind": {
      "enum": [
        "public",
        "private",
        "direct"
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
    "direct_message",
    "send_message",
    "message",
    "message_page",
    "snapshot",
    "sync_batch",
    "socket_ticket",
    "error"
  ],
  "title": "Contract",
  "type": "object"
} as const;
