-- Operator commands are separate from member permissions and chat history.
CREATE TABLE operator_commands (
    operation_id text PRIMARY KEY,
    data_epoch text NOT NULL,
    command_hash text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operator_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    database_role text NOT NULL DEFAULT current_user,
    data_epoch text NOT NULL,
    action text NOT NULL CHECK (octet_length(action)<=64),
    operation_id text,
    subject text NOT NULL CHECK (octet_length(subject)<=128),
    details jsonb NOT NULL CHECK (octet_length(details::text)<=32768)
);
