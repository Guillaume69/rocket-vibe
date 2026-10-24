//! Builders and `..` patterns in this crate are positive controls. Struct literals
//! (including update syntax from a valid builder result) are intentionally forbidden.
//! Every newly protected DTO is checked independently, so restoring one literal
//! cannot hide behind another's failure. Nightly verifies error codes as well.
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::bot::MessageContext;
//! fn literal(value: MessageContext) { let _ = MessageContext { ..value }; }
//! ```
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::EventCreationParams;
//! fn literal(value: EventCreationParams) { let _ = EventCreationParams { ..value }; }
//! ```
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::NewsletterMetadata;
//! fn literal(value: NewsletterMetadata) { let _ = NewsletterMetadata { ..value }; }
//! ```
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::NewsletterAdminProfile;
//! fn literal(value: NewsletterAdminProfile) { let _ = NewsletterAdminProfile { ..value }; }
//! ```
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::NewsletterAdminInfo;
//! fn literal(value: NewsletterAdminInfo) { let _ = NewsletterAdminInfo { ..value }; }
//! ```
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::NewsletterFollower;
//! fn literal(value: NewsletterFollower) { let _ = NewsletterFollower { ..value }; }
//! ```
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::NewsletterReactionCount;
//! fn literal(value: NewsletterReactionCount) { let _ = NewsletterReactionCount { ..value }; }
//! ```
//!
//! Already non-exhaustive history/tally outputs now have supported mock builders:
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::NewsletterPollVote;
//! fn literal(value: NewsletterPollVote) { let _ = NewsletterPollVote { ..value }; }
//! ```
//!
//! ```compile_fail,E0639
//! use whatsapp_rust::NewsletterMessage;
//! fn literal(value: NewsletterMessage) { let _ = NewsletterMessage { ..value }; }
//! ```
//!
//! Exhaustive external patterns must add `..`, rather than list today's fields.
//!
//! ```compile_fail,E0638
//! use whatsapp_rust::bot::MessageContext;
//! fn pattern(value: MessageContext) {
//!     let MessageContext { message, info, client, ephemeral_expiration, comment_target } = value;
//! }
//! ```
//!
//! ```compile_fail,E0638
//! use whatsapp_rust::EventCreationParams;
//! fn pattern(value: EventCreationParams) {
//!     let EventCreationParams { name, description, start_time, end_time, join_link, location, is_scheduled_call, extra_guests_allowed } = value;
//! }
//! ```
//!
//! ```compile_fail,E0638
//! use whatsapp_rust::NewsletterMetadata;
//! fn pattern(value: NewsletterMetadata) {
//!     let NewsletterMetadata { jid, name, description, subscriber_count, verification, state, picture_url, preview_url, invite_code, role, creation_time, muted, follower_activity_muted } = value;
//! }
//! ```
//!
//! ```compile_fail,E0638
//! use whatsapp_rust::NewsletterAdminProfile;
//! fn pattern(value: NewsletterAdminProfile) {
//!     let NewsletterAdminProfile { id, name, picture_id, picture_direct_path } = value;
//! }
//! ```
//!
//! ```compile_fail,E0638
//! use whatsapp_rust::NewsletterAdminInfo;
//! fn pattern(value: NewsletterAdminInfo) {
//!     let NewsletterAdminInfo { admin_count, admin_profile, admin_profiles_enabled } = value;
//! }
//! ```
//!
//! ```compile_fail,E0638
//! use whatsapp_rust::NewsletterFollower;
//! fn pattern(value: NewsletterFollower) {
//!     let NewsletterFollower { jid, phone_jid, display_name, username, role, follow_time, admin_profile } = value;
//! }
//! ```
//!
//! ```compile_fail,E0638
//! use whatsapp_rust::NewsletterReactionCount;
//! fn pattern(value: NewsletterReactionCount) {
//!     let NewsletterReactionCount { code, count } = value;
//! }
//! ```
//!
//! There is no valid all-default event; the builder requires a name. Whitespace-only
//! names remain rejected by `Events::create` before any send.
//!
//! ```compile_fail,E0599
//! use whatsapp_rust::EventCreationParams;
//! let _ = EventCreationParams::default();
//! ```
//!
//! ```compile_fail,E0277
//! use whatsapp_rust::EventCreationParams;
//! let _ = EventCreationParams::builder().build();
//! ```
