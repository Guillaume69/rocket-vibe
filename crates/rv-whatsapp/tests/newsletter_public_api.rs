use whatsapp_rust::NewsletterPollVote as RootNewsletterPollVote;
use whatsapp_rust::features::NewsletterPollVote as FeatureNewsletterPollVote;

#[test]
fn newsletter_poll_vote_is_public_at_both_import_paths() {
    let _: Option<RootNewsletterPollVote> = None;
    let _: Option<FeatureNewsletterPollVote> = None;
}
