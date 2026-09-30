use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rv_protocol::ApiError;

#[derive(Debug)]
pub struct Error(pub StatusCode, pub &'static str);
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn invalid() -> Self {
        Self(StatusCode::BAD_REQUEST, "invalid_request")
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "session_rejected")
    }
    pub fn forbidden() -> Self {
        Self(StatusCode::FORBIDDEN, "permission_denied")
    }
    pub fn missing() -> Self {
        Self(StatusCode::NOT_FOUND, "not_found")
    }
    pub fn conflict() -> Self {
        Self(StatusCode::CONFLICT, "operation_conflict")
    }
    pub fn internal() -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let body = ApiError {
            code: self.1.into(),
            request_id: crate::auth::random_token(),
        };
        (self.0, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        // Database diagnostics stay server-side; never serialize SQL or credentials.
        tracing::error!(error = %error, "database operation failed");
        Self::internal()
    }
}
