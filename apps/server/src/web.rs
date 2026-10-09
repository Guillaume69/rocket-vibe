//! The browser client ships inside the server binary. Only explicit UI routes
//! receive HTML; missing API endpoints and missing assets retain a 404.
use axum::{
    Router,
    body::Body,
    extract::Path,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
include!(concat!(env!("OUT_DIR"), "/web-assets.rs"));
pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/", get(index))
        .route("/sw.js", get(worker))
        .route("/manifest.webmanifest", get(manifest))
        .route("/room/{room}", get(index))
        .route("/assets/{*path}", get(asset))
}
async fn worker() -> Response {
    serve("/sw.js", false)
}
async fn manifest() -> Response {
    serve("/manifest.webmanifest", false)
}
async fn index() -> Response {
    serve("/index.html", false)
}
async fn asset(Path(path): Path<String>) -> Response {
    serve(&format!("/assets/{path}"), true)
}
fn serve(path: &str, immutable: bool) -> Response {
    let Some((_, bytes)) = ASSETS.iter().find(|(name, _)| *name == path) else {
        return crate::error::Error::missing().into_response();
    };
    let mime = match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "ttf" => "font/ttf",
        "woff2" => "font/woff2",
        "svg" => "image/svg+xml",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    };
    let mut response = Response::new(Body::from(*bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, mime.parse().expect("static MIME"));
    headers.insert(
        header::CACHE_CONTROL,
        if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-store"
        }
        .parse()
        .expect("static cache policy"),
    );
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "same-origin".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https: wss: ws://localhost:* ws://127.0.0.1:*; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.dailymotion.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'".parse().unwrap());
    response
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;
    #[tokio::test]
    async fn serves_root_and_room_navigation_without_database_or_node() {
        for path in ["/", "/room/a-room"] {
            let response = router::<()>()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            let html = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            let html = std::str::from_utf8(&html).unwrap();
            assert!(html.contains("/assets/"));
            assert!(!html.contains("/src/main.ts"));
        }
    }
    #[tokio::test]
    async fn missing_api_and_asset_are_never_successful_html() {
        for path in ["/api/v1/missing", "/assets/missing.js", "/some-secret.txt"] {
            let response = router::<()>()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }
    #[tokio::test]
    async fn packaged_scripts_and_fonts_have_correct_mime_and_immutable_cache() {
        for (name, _) in ASSETS.iter().filter(|(name, _)| {
            name.starts_with("/assets/") && (name.ends_with(".js") || name.ends_with(".ttf"))
        }) {
            let response = router::<()>()
                .oneshot(Request::builder().uri(*name).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable"
            );
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                if name.ends_with(".js") {
                    "text/javascript; charset=utf-8"
                } else {
                    "font/ttf"
                }
            );
        }
    }
}
