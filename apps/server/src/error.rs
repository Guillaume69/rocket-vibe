use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use rv_protocol::ApiError;

#[derive(Debug)]
pub struct Error {
    pub status: StatusCode,
    pub code: &'static str,
    pub(crate) retry_after: Option<u64>,
}
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code,
            retry_after: None,
        }
    }
    pub fn throttled(code: &'static str, seconds: u64) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code,
            retry_after: Some(seconds.max(1)),
        }
    }
    pub fn invalid() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request")
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "session_rejected")
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "permission_denied")
    }
    pub fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found")
    }
    pub fn conflict() -> Self {
        Self::new(StatusCode::CONFLICT, "operation_conflict")
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let body = ApiError {
            code: self.code.into(),
            request_id: crate::auth::random_token(),
        };
        let mut response = (self.status, Json(body)).into_response();
        if let Some(seconds) = self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, seconds.into());
        }
        response
    }
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        // Database diagnostics stay server-side; never serialize SQL or credentials.
        tracing::error!(error = %error, "database operation failed");
        Self::internal()
    }
}
