//! Same file controls and media records as the legacy provider, with native authority.
use crate::{MediaData, Upload, model::RvError, native::NativeChat, on_tokio};
use rv_core::native;
fn error(e: native::Error) -> RvError {
    native::rest_error(e).into()
}
#[uniffi::export]
impl NativeChat {
    pub fn preview_current(&self, path: String) -> bool {
        self.session.preview_current(&path)
    }
    pub fn preview_scope(&self, path: String) -> Option<String> {
        self.session.preview_scope(&path)
    }
    pub async fn preview_media(&self, path: String) -> Result<MediaData, RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            s.preview_media(&path).await.map(|m| MediaData {
                bytes: m.bytes,
                content_type: m.content_type,
                placeholder: false,
            })
        })
        .await
        .map_err(error)
    }
    pub fn file_current(&self, path: String) -> bool {
        self.session.file_current(&path)
    }
    pub async fn media(&self, path: String) -> Result<MediaData, RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            s.file_media(&path).await.map(|m| MediaData {
                bytes: m.bytes,
                content_type: m.content_type,
                placeholder: false,
            })
        })
        .await
        .map_err(error)
    }
    pub async fn download(&self, path: String, destination: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            if path.starts_with("rv-preview:") {
                s.download_preview(&path, std::path::Path::new(&destination)).await
            } else {
                s.download_file(&path, std::path::Path::new(&destination)).await
            }
        })
        .await
        .map_err(error)
    }
    pub async fn local_file(&self, path: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.local_file(&path).await.map(|p| p.to_string_lossy().into_owned()) })
            .await
            .map_err(error)
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn attach(
        &self,
        rid: String,
        path: String,
        name: String,
        mime: String,
        caption: Option<String>,
        temporary: bool,
        membership: String,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        let refused = mime.clone();
        on_tokio(async move {
            s.attach_file(&rid, std::path::Path::new(&path), &name, &mime, caption.as_deref(), temporary, &membership)
                .await
        })
        .await
        .map_err(|e| match e.code() {
            "too-large:100" => RvError::local("too-large:100"),
            "type-not-allowed" => RvError::local(format!("type-not-allowed:{refused}")),
            _ => error(e),
        })
    }
    pub fn uploads(&self, rid: String) -> Result<Vec<Upload>, RvError> {
        self.session
            .file_uploads(&rid)
            .map(|rows| {
                rows.into_iter()
                    .map(|u| Upload {
                        progress: self.session.upload_progress(&u.id),
                        failed: u.status == "failed",
                        retrying: false,
                        id: u.id,
                        name: u.name,
                        mime: u.mime,
                    })
                    .collect()
            })
            .map_err(error)
    }
    pub async fn retry_upload(&self, id: String) -> Result<(), RvError> {
        self.session.retry_file(&id).map_err(error)
    }
    pub fn discard_upload(&self, id: String) -> Result<(), RvError> {
        self.session.discard_file(&id).map_err(error)
    }
}
