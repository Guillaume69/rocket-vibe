use super::*;
use crate::{email, reauthentication};
use hmac::{Hmac, Mac};
use rv_protocol::parity::{
    AuthenticationStep, BeginReauthentication, DisableFactor, FinishReauthentication,
    ReauthenticationStep, RemoveVerifiedEmail,
};
use sha1::Sha1;
use sqlx::PgPool;

const PASSWORD: &str = "email-profile-test-password";
const EMAIL_PROFILE: &str = "email-profile";

#[sqlx::test(migrations = false)]
async fn migration_preserves_existing_totp_cipher_backup_bag_and_full_login_provenance(
    pool: PgPool,
) {
    let all = sqlx::migrate!();
    // Use the real recorded/checksummed catalog up to the preceding schema.
    let preceding = sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(
            all.iter().filter(|m| m.version < 19).cloned().collect(),
        ),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    preceding.run(&pool).await.unwrap();
    sqlx::query("INSERT INTO instance(singleton,instance_id,data_epoch) VALUES(true,'legacy-instance','legacy-epoch')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO users(id,username,display_name,password_hash) VALUES('legacy-user','owner','Legacy owner','unusable')")
        .execute(&pool).await.unwrap();
    let key = AuthKey::from_hex(&"37".repeat(32)).unwrap();
    let cipher = key
        .seal(
            b"12345678901234567890",
            &factor_crypto::aad("legacy-instance", "legacy-user", "legacy-profile", "totp"),
        )
        .unwrap();
    sqlx::query("INSERT INTO user_factors(user_id,version,totp_cipher,last_totp_counter) VALUES('legacy-user','legacy-profile',$1,321)")
        .bind(&cipher).execute(&pool).await.unwrap();
    let _ = backup(&pool, "legacy-user").await;
    let consumed = backup(&pool, "legacy-user").await;
    sqlx::query("UPDATE factor_backup_codes SET consumed_at=clock_timestamp() WHERE token_hash=$1")
        .bind(auth::hash_token(&consumed))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO session_devices(id,user_id,login_factor_id) VALUES('legacy-device','legacy-user','legacy-profile')")
        .execute(&pool).await.unwrap();
    let token = auth::random_token();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES($1,'legacy-user','legacy-device',clock_timestamp()+interval '30 days')")
        .bind(auth::hash_token(&token)).execute(&pool).await.unwrap();
    let old_authority: (String, String) = sqlx::query_as(
        "SELECT factor_version,activation_version FROM users WHERE id='legacy-user'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let old_bag: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT token_hash,consumed_at FROM factor_backup_codes ORDER BY token_hash",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    let app = App::from_pool_with_auth_key(pool.clone(), Some(key))
        .await
        .unwrap();
    let profile: (String,Vec<u8>,i64) = sqlx::query_as("SELECT version,totp_cipher,last_totp_counter FROM user_factors WHERE user_id='legacy-user'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(profile, ("legacy-profile".into(), cipher, 321));
    let new_bag: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT token_hash,consumed_at FROM factor_backup_codes ORDER BY token_hash",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(new_bag, old_bag);
    let authority: (String, String) = sqlx::query_as(
        "SELECT factor_version,activation_version FROM users WHERE id='legacy-user'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(authority, old_authority);
    let account = auth::authenticate(&app, &auth::hash_token(&token))
        .await
        .unwrap();
    let status = super::super::status(&app, &account).await.unwrap();
    assert!(status.totp && !status.email);
    assert_eq!(status.backup_codes_remaining, 1);
    assert_eq!(
        status.factor_version.as_deref(),
        Some(old_authority.0.as_str())
    );
    assert!(
        reauthentication::status(&app, &account)
            .await
            .unwrap()
            .recent,
        "Existing TOTP full-login identity remains valid after the migration"
    );
}

async fn fixture(pool: &PgPool) -> (App, Session, String) {
    let app = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    let user = auth::create_user(&app, "owner", PASSWORD.into(), false)
        .await
        .unwrap();
    let old = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    let instance: String = sqlx::query_scalar("SELECT instance_id FROM instance WHERE singleton")
        .fetch_one(pool)
        .await
        .unwrap();
    let contact: String = sqlx::query_scalar("SELECT email_version FROM users WHERE id=$1")
        .bind(&user.id)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,'owner@example.test',clock_timestamp())")
        .bind(&user.id).execute(pool).await.unwrap();
    // Seed an enrollment which is not exposed by any production route yet.
    // Its actual authentication/proof/backup paths are exercised below.
    let cipher = key(&app)
        .unwrap()
        .seal(
            EMAIL_KEY_CHECK,
            &email_aad(&instance, &user.id, EMAIL_PROFILE, &contact),
        )
        .unwrap();
    sqlx::query("INSERT INTO user_email_factors(user_id,version,email_version,key_check_cipher) VALUES($1,$2,$3,$4)")
        .bind(&user.id).bind(EMAIL_PROFILE).bind(contact).bind(cipher).execute(pool).await.unwrap();
    sqlx::query("UPDATE users SET factor_version=$2 WHERE id=$1")
        .bind(&user.id)
        .bind(auth::random_token())
        .execute(pool)
        .await
        .unwrap();
    (app, old, instance)
}
async fn fresh_account(app: &App, session: &Session) -> Account {
    auth::authenticate(app, &auth::hash_token(&session.token))
        .await
        .unwrap()
}
async fn backup(pool: &PgPool, user: &str) -> String {
    let code = auth::random_token()[..32].to_owned();
    sqlx::query("INSERT INTO factor_backup_codes(user_id,token_hash) VALUES($1,$2)")
        .bind(user)
        .bind(auth::hash_token(&code))
        .execute(pool)
        .await
        .unwrap();
    code
}
async fn challenge(app: &App) -> AuthChallenge {
    match auth::start_login(app, "owner".into(), PASSWORD.into(), None)
        .await
        .unwrap()
    {
        AuthenticationStep::Challenge { challenge, .. } => challenge,
        AuthenticationStep::Session { .. } => {
            panic!("Installed e-mail profile allowed password-only login")
        }
    }
}
async fn login_backup(app: &App, code: &str) -> Session {
    let challenge = challenge(app).await;
    super::super::finish(
        app,
        FinishFactor {
            challenge_id: challenge.challenge_id,
            operation_id: auth::random_token(),
            next_token: auth::random_token(),
            method: SecondFactor::RecoveryCode,
            code: code.into(),
        },
        None,
    )
    .await
    .unwrap()
}
async fn seed_totp(app: &App, user: &str, instance: &str) {
    let cipher = key(app)
        .unwrap()
        .seal(
            b"12345678901234567890",
            &factor_crypto::aad(instance, user, "totp-profile", "totp"),
        )
        .unwrap();
    sqlx::query("INSERT INTO user_factors(user_id,version,totp_cipher,last_totp_counter) VALUES($1,'totp-profile',$2,0)")
        .bind(user).bind(cipher).execute(&app.pool).await.unwrap();
    sqlx::query("UPDATE users SET factor_version=$2 WHERE id=$1")
        .bind(user)
        .bind(auth::random_token())
        .execute(&app.pool)
        .await
        .unwrap();
}
async fn remaining(pool: &PgPool, user: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM factor_backup_codes WHERE user_id=$1 AND consumed_at IS NULL",
    )
    .bind(user)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn totp_code(secret: &str) -> String {
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret.as_bytes())
        .unwrap();
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(&secret).unwrap();
    mac.update(&((Utc::now().timestamp() / 30) as u64).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 15) as usize;
    let binary = u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap()) & 0x7fff_ffff;
    format!("{:06}", binary % 1_000_000)
}

#[sqlx::test]
async fn explicit_totp_enrollment_alongside_email_issues_one_replacement_common_bag(pool: PgPool) {
    let (app, old, _) = fixture(&pool).await;
    let first = backup(&pool, &old.user.id).await;
    let original_unused = backup(&pool, &old.user.id).await;
    let session = login_backup(&app, &first).await;
    let account = fresh_account(&app, &session).await;
    let setup = super::super::begin(
        &app,
        &account,
        BeginFactorSetup {
            operation_id: auth::random_token(),
        },
    )
    .await
    .unwrap();
    let issued = super::super::enable(
        &app,
        &account,
        EnableFactor {
            setup_id: setup.setup_id,
            operation_id: auth::random_token(),
            code: totp_code(&setup.secret),
        },
    )
    .await
    .unwrap();
    assert_eq!(issued.codes.len(), 10);
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM factor_backup_codes WHERE user_id=$1")
            .bind(&old.user.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(total, 10);
    let old_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM factor_backup_codes WHERE token_hash=$1)")
            .bind(auth::hash_token(&original_unused))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !old_exists,
        "Explicit enrollment returns its replacement codes, without accumulating old bags"
    );
    let account = fresh_account(&app, &session).await;
    let status = super::super::status(&app, &account).await.unwrap();
    assert!(status.totp && status.email);
    assert!(
        !reauthentication::status(&app, &account)
            .await
            .unwrap()
            .recent,
        "Previous e-mail login does not prove the newly preferred TOTP profile"
    );
}

#[sqlx::test]
async fn last_email_profile_removal_erases_consumed_and_unused_codes(pool: PgPool) {
    let (app, old, _) = fixture(&pool).await;
    let consumed = backup(&pool, &old.user.id).await;
    backup(&pool, &old.user.id).await;
    let _ = login_backup(&app, &consumed).await;
    assert_eq!(remaining(&pool, &old.user.id).await, 1);
    sqlx::query("DELETE FROM user_email_factors WHERE user_id=$1")
        .bind(&old.user.id)
        .execute(&pool)
        .await
        .unwrap();
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM factor_backup_codes WHERE user_id=$1")
            .bind(&old.user.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(total, 0);
}

#[sqlx::test]
async fn email_alone_protects_login_and_requires_full_proof_without_smtp(pool: PgPool) {
    let (app, old, _) = fixture(&pool).await;
    let code = backup(&pool, &old.user.id).await;
    let second = backup(&pool, &old.user.id).await;
    assert!(
        auth::login(&app, "owner".into(), PASSWORD.into())
            .await
            .is_err_and(|e| e.code == "factor_required")
    );
    let account = fresh_account(&app, &old).await;
    let status = super::super::status(&app, &account).await.unwrap();
    assert!(!status.totp && status.email);
    assert_eq!(status.backup_codes_remaining, 2);
    let proof = reauthentication::status(&app, &account).await.unwrap();
    assert!(
        !proof.recent,
        "A recent password login predates this installed profile"
    );
    let challenge_id = auth::random_token();
    let operation_id = auth::random_token();
    let step = reauthentication::begin(
        &app,
        &account,
        BeginReauthentication {
            password: PASSWORD.into(),
            challenge_id: challenge_id.clone(),
            operation_id: operation_id.clone(),
            proof_version: proof.proof_version,
            context: None,
        },
        None,
    )
    .await
    .unwrap();
    let ReauthenticationStep::Challenge { challenge } = step else {
        panic!("Password-only identity grant");
    };
    assert!(matches!(
        challenge.methods.as_slice(),
        [SecondFactor::RecoveryCode]
    ));
    let grant = reauthentication::finish(
        &app,
        &account,
        FinishReauthentication {
            challenge_id,
            operation_id,
            method: SecondFactor::RecoveryCode,
            code,
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(grant.user_id, old.user.id);
    let proof = reauthentication::status(&app, &account).await.unwrap();
    assert!(proof.recent);
    let factor: String =
        sqlx::query_scalar("SELECT factor_id FROM reauthentication_grants WHERE user_id=$1")
            .bind(&old.user.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(factor, EMAIL_PROFILE);
    let session = login_backup(&app, &second).await;
    let account = fresh_account(&app, &session).await;
    assert!(
        reauthentication::status(&app, &account)
            .await
            .unwrap()
            .recent
    );
    assert_eq!(remaining(&pool, &old.user.id).await, 0);
    // Exhausted backups and unavailable delivery never downgrade the account.
    assert!(
        auth::start_login(&app, "owner".into(), PASSWORD.into(), None)
            .await
            .is_err_and(|e| e.code == "factor_unavailable")
    );
}

#[sqlx::test]
async fn email_key_missing_wrong_corrupt_or_rebound_never_consumes_backups(pool: PgPool) {
    let (app, old, instance) = fixture(&pool).await;
    let code = backup(&pool, &old.user.id).await;
    let challenge = challenge(&app).await;
    let candidate = auth::random_token();
    let input = FinishFactor {
        challenge_id: challenge.challenge_id,
        operation_id: auth::random_token(),
        next_token: candidate.clone(),
        method: SecondFactor::RecoveryCode,
        code,
    };
    for runtime in [
        App::from_pool(pool.clone()).await.unwrap(),
        App::from_pool_with_auth_key(
            pool.clone(),
            Some(AuthKey::from_hex(&"29".repeat(32)).unwrap()),
        )
        .await
        .unwrap(),
    ] {
        sqlx::query("DELETE FROM login_windows")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            super::super::finish(&runtime, input.clone(), None)
                .await
                .is_err_and(|e| e.code == "factor_unavailable")
        );
        assert!(
            auth::start_login(&runtime, "owner".into(), PASSWORD.into(), None)
                .await
                .is_err_and(|e| e.code == "factor_unavailable")
        );
    }
    let contact: String = sqlx::query_scalar("SELECT email_version FROM users WHERE id=$1")
        .bind(&old.user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    for aad in [
        email_aad("other-instance", &old.user.id, EMAIL_PROFILE, &contact),
        email_aad(&instance, "other-user", EMAIL_PROFILE, &contact),
        email_aad(&instance, &old.user.id, "other-profile", &contact),
        email_aad(&instance, &old.user.id, EMAIL_PROFILE, "other-contact"),
    ] {
        sqlx::query("DELETE FROM login_windows")
            .execute(&pool)
            .await
            .unwrap();
        let cipher = key(&app).unwrap().seal(EMAIL_KEY_CHECK, &aad).unwrap();
        sqlx::query("UPDATE user_email_factors SET key_check_cipher=$2 WHERE user_id=$1")
            .bind(&old.user.id)
            .bind(cipher)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            super::super::finish(&app, input.clone(), None)
                .await
                .is_err_and(|e| e.code == "factor_unavailable")
        );
    }
    for plain in [b"invalid-key-check".as_slice(), b"".as_slice()] {
        sqlx::query("DELETE FROM login_windows")
            .execute(&pool)
            .await
            .unwrap();
        let cipher = key(&app)
            .unwrap()
            .seal(
                plain,
                &email_aad(&instance, &old.user.id, EMAIL_PROFILE, &contact),
            )
            .unwrap();
        sqlx::query("UPDATE user_email_factors SET key_check_cipher=$2 WHERE user_id=$1")
            .bind(&old.user.id)
            .bind(cipher)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            super::super::finish(&app, input.clone(), None)
                .await
                .is_err_and(|e| e.code == "factor_unavailable")
        );
    }
    assert_eq!(remaining(&pool, &old.user.id).await, 1);
    assert!(
        auth::authenticate(&app, &auth::hash_token(&candidate))
            .await
            .is_err()
    );
    let attempts: i32 =
        sqlx::query_scalar("SELECT attempts FROM auth_challenges WHERE token_hash=$1")
            .bind(auth::hash_token(&input.challenge_id))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        attempts, 0,
        "Unavailable configuration does not consume an OTP attempt"
    );
}

#[sqlx::test]
async fn removing_totp_preserves_email_and_common_backups_with_fresh_factor_provenance(
    pool: PgPool,
) {
    let (app, old, instance) = fixture(&pool).await;
    seed_totp(&app, &old.user.id, &instance).await;
    let first = backup(&pool, &old.user.id).await;
    let second = backup(&pool, &old.user.id).await;
    let session = login_backup(&app, &first).await;
    let account = fresh_account(&app, &session).await;
    let factor = super::super::status(&app, &account).await.unwrap();
    assert!(factor.totp && factor.email);
    super::super::disable(
        &app,
        &account,
        DisableFactor {
            factor_version: factor.factor_version.unwrap(),
        },
    )
    .await
    .unwrap();
    let account = fresh_account(&app, &session).await;
    let factor = super::super::status(&app, &account).await.unwrap();
    assert!(!factor.totp && factor.email);
    assert_eq!(factor.backup_codes_remaining, 1);
    assert!(
        !reauthentication::status(&app, &account)
            .await
            .unwrap()
            .recent,
        "The removed TOTP identity does not become a full e-mail proof"
    );
    let session = login_backup(&app, &second).await;
    let account = fresh_account(&app, &session).await;
    assert!(
        reauthentication::status(&app, &account)
            .await
            .unwrap()
            .recent
    );
    let original = RegenerateFactorBackups {
        factor_version: super::super::status(&app, &account)
            .await
            .unwrap()
            .factor_version
            .unwrap(),
        operation_id: auth::random_token(),
    };
    let issued = super::super::regenerate_backups(&app, &account, original.clone())
        .await
        .unwrap();
    assert_eq!(issued.codes.len(), 10);
    let account = fresh_account(&app, &session).await;
    let replay = super::super::regenerate_backups(&app, &account, original)
        .await
        .unwrap();
    assert_eq!(issued.codes, replay.codes);
    assert_eq!(remaining(&pool, &old.user.id).await, 10);
}

#[sqlx::test]
async fn removing_email_preserves_totp_and_last_factor_removal_erases_common_bag(pool: PgPool) {
    let (app, old, instance) = fixture(&pool).await;
    seed_totp(&app, &old.user.id, &instance).await;
    backup(&pool, &old.user.id).await;
    sqlx::query("DELETE FROM user_email_factors WHERE user_id=$1")
        .bind(&old.user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(remaining(&pool, &old.user.id).await, 1);
    let primary: String =
        sqlx::query_scalar("SELECT version FROM account_factor_profiles WHERE user_id=$1")
            .bind(&old.user.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(primary, "totp-profile");
    sqlx::query("DELETE FROM user_factors WHERE user_id=$1")
        .bind(&old.user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(remaining(&pool, &old.user.id).await, 0);
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM factor_backup_codes WHERE user_id=$1")
            .bind(&old.user.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(total, 0);
}

#[sqlx::test]
async fn installed_email_factor_blocks_contact_mutation_but_not_account_deletion(pool: PgPool) {
    let (app, old, _) = fixture(&pool).await;
    let code = backup(&pool, &old.user.id).await;
    let session = login_backup(&app, &code).await;
    let account = fresh_account(&app, &session).await;
    let status = email::status(&app, &account).await.unwrap();
    let error = email::removal::begin(
        &app,
        &account,
        RemoveVerifiedEmail {
            operation_id: auth::random_token(),
            expected_version: status.version,
            verification_version: status.verification_version,
            context: status.context,
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code, "email_factor_active");
    assert!(
        sqlx::query("DELETE FROM account_emails WHERE user_id=$1")
            .bind(&old.user.id)
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE users SET email_version=$2 WHERE id=$1")
            .bind(&old.user.id)
            .bind(auth::random_token())
            .execute(&pool)
            .await
            .is_err()
    );
    // Existing sessions deliberately restrict deletion of a live account.
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(&old.user.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM session_devices WHERE user_id=$1")
        .bind(&old.user.id)
        .execute(&pool)
        .await
        .unwrap();
    // Once those existing references are retired, users cascade both the
    // contact and independent profile in one command.
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(&old.user.id)
        .execute(&pool)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_email_factors")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
