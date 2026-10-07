//! In-app administration and member reports (`/api/v1/admin/*`, `report`
//! routes). Every call needs the server's capability; the routes answer 403
//! `permission_denied` to an account without `users.admin`.
use super::{Error, NativeSession, room_operation_id};
use rv_protocol::admin::*;

/// Items asked per page of an administration list.
const PAGE: u32 = 50;

impl NativeSession {
    /// The server offers the administration routes.
    pub fn administration_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.administration)
    }
    /// The server takes members' reports of messages and accounts.
    pub fn reports_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.reports)
    }
    fn admin_access(&self) -> Result<(), Error> {
        self.ready()?;
        if !self.administration_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    fn report_access(&self) -> Result<(), Error> {
        self.ready()?;
        if !self.reports_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    /// Whether I may open the administration: the server offers it and my
    /// account manages accounts or the instance.
    pub async fn administrator(&self) -> Result<bool, Error> {
        if !self.administration_supported() {
            return Ok(false);
        }
        self.ready()?;
        let permissions = self.client.account_permissions().await?;
        self.ready()?;
        Ok(permissions.manage_accounts || permissions.manage_instance)
    }
    pub async fn admin_overview(&self) -> Result<AdminOverview, Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        let overview = self.client.admin_overview().await?;
        self.ready()?;
        Ok(overview)
    }
    /// Accounts by username; `q` filters on username or display name.
    pub async fn admin_users(&self, after: Option<&str>, q: Option<&str>) -> Result<AdminUserPage, Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        let page = self.client.admin_users(after, Some(PAGE), q.filter(|q| !q.is_empty())).await?;
        self.ready()?;
        Ok(page)
    }
    /// Sets the admin right and/or the deactivation of an account at `revision`.
    pub async fn update_admin_user(
        &self,
        id: &str,
        revision: &str,
        admin: Option<bool>,
        disabled: Option<bool>,
    ) -> Result<AdminUser, Error> {
        self.admin_access()?;
        if id == self.info.user_id {
            return Err(Error::Protocol("self_administration"));
        }
        self.refresh_credentials().await?;
        let input = UpdateAdminUser { operation_id: room_operation_id(), revision: revision.into(), admin, disabled };
        let user = self.client.update_admin_user(id, &input).await?;
        self.ready()?;
        Ok(user)
    }
    /// Tombstones the account; its messages stay, shown as a deleted user.
    pub async fn delete_admin_user(&self, id: &str, revision: &str) -> Result<(), Error> {
        self.admin_access()?;
        if id == self.info.user_id {
            return Err(Error::Protocol("self_administration"));
        }
        self.refresh_credentials().await?;
        let input = DeleteAdminUser { operation_id: room_operation_id(), revision: revision.into() };
        self.client.delete_admin_user(id, &input).await?;
        self.ready()
    }
    pub async fn admin_rooms(&self, after: Option<&str>, q: Option<&str>) -> Result<AdminRoomPage, Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        let page = self.client.admin_rooms(after, Some(PAGE), q.filter(|q| !q.is_empty())).await?;
        self.ready()?;
        Ok(page)
    }
    pub async fn admin_reported_messages(&self, after: Option<&str>) -> Result<AdminReportedMessagePage, Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        let page = self.client.admin_reported_messages(after, Some(PAGE)).await?;
        self.ready()?;
        Ok(page)
    }
    pub async fn admin_reported_users(&self, after: Option<&str>) -> Result<AdminReportedUserPage, Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        let page = self.client.admin_reported_users(after, Some(PAGE)).await?;
        self.ready()?;
        Ok(page)
    }
    pub async fn dismiss_message_reports(&self, message: &str) -> Result<(), Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        self.client.dismiss_message_reports(message, &AdminOperation { operation_id: room_operation_id() }).await?;
        self.ready()
    }
    /// Deletes a reported message like its author would, and closes its reports.
    pub async fn delete_reported_message(&self, message: &str) -> Result<(), Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        self.client.delete_reported_message(message, &AdminOperation { operation_id: room_operation_id() }).await?;
        self.ready()
    }
    pub async fn dismiss_user_reports(&self, user: &str) -> Result<(), Error> {
        self.admin_access()?;
        self.refresh_credentials().await?;
        self.client.dismiss_user_reports(user, &AdminOperation { operation_id: room_operation_id() }).await?;
        self.ready()
    }
    /// Reports a message of a room I read; `reason` is trimmed, 1 to 1,000 characters.
    pub async fn report_message(&self, message: &str, reason: &str) -> Result<(), Error> {
        self.report_access()?;
        let reason = crate::admin::valid_reason(reason).ok_or(Error::Protocol("invalid_reason"))?;
        self.refresh_credentials().await?;
        self.client.report_message(message, &ReportInput { operation_id: room_operation_id(), reason }).await?;
        self.ready()
    }
    pub async fn report_user(&self, user: &str, reason: &str) -> Result<(), Error> {
        self.report_access()?;
        if user == self.info.user_id {
            return Err(Error::Protocol("self_report"));
        }
        let reason = crate::admin::valid_reason(reason).ok_or(Error::Protocol("invalid_reason"))?;
        self.refresh_credentials().await?;
        self.client.report_user(user, &ReportInput { operation_id: room_operation_id(), reason }).await?;
        self.ready()
    }
}
