use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("Analyst authorization is required to record human feedback")]
    AnalystAuthRequired,
    #[error("{0}")]
    ProviderUnavailable(String),
    #[error("{0}")]
    RateLimited(String),
    #[error("storage error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) | Self::Json(_) => "INVALID_ARGUMENTS",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict(_) => "CONFLICT",
            Self::AnalystAuthRequired => "ANALYST_AUTH_REQUIRED",
            Self::ProviderUnavailable(_) => "PROVIDER_UNAVAILABLE",
            Self::RateLimited(_) => "RATE_LIMITED",
            Self::Http(_) => "PROVIDER_ERROR",
            _ => "INTERNAL_ERROR",
        }
    }
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Validation(_) | Self::Json(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::AnalystAuthRequired => StatusCode::FORBIDDEN,
            Self::ProviderUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Http(_) => StatusCode::BAD_GATEWAY,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = self.status();
        let message = match &self {
            Self::Database(_) | Self::Io(_) | Self::Internal(_) | Self::Http(_) => {
                tracing::error!(error = %self, "tool operation failed");
                if matches!(&self, Self::Http(_)) {
                    "Provider request failed".to_owned()
                } else {
                    "Internal operation failed; inspect service logs".to_owned()
                }
            }
            _ => self.to_string(),
        };
        (
            status,
            Json(json!({"error":{"code":self.code(),"message":message}})),
        )
            .into_response()
    }
}
