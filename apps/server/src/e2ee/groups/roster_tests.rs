use super::*;

fn grants(roster: &wire::GroupRoster) -> Vec<Member> {
    roster
        .members
        .iter()
        .map(|m| Member {
            user: m.user_id.clone(),
            access_version: m.access_version.clone(),
            activation_version: m.activation_version.clone(),
        })
        .collect()
}
async fn observe(app: &App, actor: &Account, room: &str) -> wire::GroupRoster {
    body(delivery::observe_roster(app, actor, room).await.unwrap()).await
}
pub(super) async fn wait_for_lock(pool: &PgPool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let blocked:bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')").fetch_one(pool).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
}

#[sqlx::test]
async fn current_grants_are_private_sorted_and_available_before_crypto_enrollment(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "roster-owner").await;
    let guest = ready(&app, "roster-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (unenrolled, _) = login(&app, "roster-owner").await;
    let first = observe(&app, &unenrolled, &room.id).await;
    assert!(first.group.is_none());
    assert_eq!(first.room_id, room.id);
    assert_eq!(
        first.scope.data_epoch,
        owner.client.registration.scope.data_epoch
    );
    assert_eq!(first.members.len(), 2);
    assert!(
        first
            .members
            .windows(2)
            .all(|w| w[0].user_id < w[1].user_id)
    );
    let own = first
        .members
        .iter()
        .find(|m| m.user_id == owner.actor.id)
        .unwrap();
    assert_eq!(own.activation_version, owner.actor.activation_version);
    assert!(!own.access_version.is_empty());
    let outsider = ready(&app, "roster-outsider").await;
    sqlx::query("UPDATE users SET admin=true WHERE id=$1")
        .bind(&outsider.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let (administrator, _) = login(&app, "roster-outsider").await;
    rejected(
        delivery::observe_roster(&app, &administrator, &room.id).await,
        "not_found",
    );
    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
        .bind(&guest.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let active = observe(&app, &unenrolled, &room.id).await;
    assert_eq!(active.members.len(), 1);
    assert_eq!(active.members[0].user_id, owner.actor.id);
    let scope = owner.scope(&room);
    let group = owner.group(&scope);
    let (_, input) = signed(&app, &owner, Prepared::from_group(&group, &owner, scope)).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    let public = observe(&app, &unenrolled, &room.id).await;
    assert_eq!(public.group.unwrap().fingerprint, receipt.fingerprint);
    rejected(
        delivery::state(&app, &unenrolled, &room.id).await,
        "permission_denied",
    );
}

#[sqlx::test]
async fn leave_return_and_account_reactivation_invalidate_an_observed_plan(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "roster-aba-owner").await;
    let guest = ready(&app, "roster-aba-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let before = observe(&app, &owner.actor, &room.id).await;
    let (_, mut transition, mut input) = add(&app, &owner, &guest, &room).await;
    store::membership(&app, &owner.actor, &room.id, &guest.actor.id, true)
        .await
        .unwrap();
    store::membership(&app, &owner.actor, &room.id, &guest.actor.id, false)
        .await
        .unwrap();
    let returned = observe(&app, &owner.actor, &room.id).await;
    let member = |r: &wire::GroupRoster| {
        r.members
            .iter()
            .find(|m| m.user_id == guest.actor.id)
            .unwrap()
            .clone()
    };
    assert_ne!(
        member(&before).access_version,
        member(&returned).access_version
    );
    assert_eq!(
        member(&before).activation_version,
        member(&returned).activation_version
    );
    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
        .bind(&guest.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET disabled=false WHERE id=$1")
        .bind(&guest.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let current = observe(&app, &owner.actor, &room.id).await;
    assert_ne!(
        member(&current).activation_version,
        member(&returned).activation_version
    );
    rejected(
        delivery::submit(&app, &owner.actor, &room.id, input.clone()).await,
        "crypto_rekey_required",
    );
    let spent: bool = sqlx::query_scalar("SELECT spent FROM e2ee_key_packages WHERE reference=$1")
        .bind(&input.welcomes[0].key_package_ref)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert!(!spent);
    transition.plan.members = grants(&current);
    transition.plan.authority_version = current.authority_version;
    transition.signature = owner
        .client
        .leaf
        .sign(&transition.plan.signing_bytes().unwrap())
        .unwrap();
    input.transition = B64.encode(&transition.to_bytes().unwrap());
    delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
}

#[sqlx::test]
async fn an_unconsumed_roster_holds_room_access_until_the_body_is_submitted(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "roster-lease-owner").await;
    let guest = ready(&app, "roster-lease-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let response = delivery::observe_roster(&app, &guest.actor, &room.id)
        .await
        .unwrap();
    let task = tokio::spawn({
        let app = app.clone();
        let actor = owner.actor.clone();
        let room = room.id.clone();
        let user = guest.actor.id.clone();
        async move { store::membership(&app, &actor, &room, &user, true).await }
    });
    wait_for_lock(&app.pool).await;
    assert!(!task.is_finished());
    let observed: wire::GroupRoster = body(response).await;
    assert_eq!(observed.members.len(), 2);
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    rejected(
        delivery::observe_roster(&app, &guest.actor, &room.id).await,
        "not_found",
    );
}

#[sqlx::test]
async fn the_roster_body_expires_at_the_real_session_deadline(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "roster-expiry-owner").await;
    let room = room(&app, &owner, None).await;
    sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE token_hash=$1").bind(&owner.actor.session_hash).execute(&app.pool).await.unwrap();
    let response = delivery::observe_roster(&app, &owner.actor, &room.id)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(750)).await;
    assert!(to_bytes(response.into_body(), 128 * 1024).await.is_err());
    rejected(
        delivery::observe_roster(&app, &owner.actor, &room.id).await,
        "session_rejected",
    );
}

#[sqlx::test]
async fn overflowing_membership_is_refused_instead_of_publishing_a_partial_plan(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "roster-limit-owner").await;
    let room = room(&app, &owner, None).await;
    sqlx::query("INSERT INTO users(id,username,display_name,password_hash) SELECT 'roster-limit-'||i,'roster-limit-'||i,'Fixture','unused-fixture-hash' FROM generate_series(1,128) AS i").execute(&app.pool).await.unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) SELECT $1,id,'member' FROM users WHERE id LIKE 'roster-limit-%' AND id<>'roster-limit-128'").bind(&room.id).execute(&app.pool).await.unwrap();
    assert_eq!(
        observe(&app, &owner.actor, &room.id).await.members.len(),
        128
    );
    sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,'roster-limit-128','member')")
        .bind(&room.id)
        .execute(&app.pool)
        .await
        .unwrap();
    rejected(
        delivery::observe_roster(&app, &owner.actor, &room.id).await,
        "crypto_group_limit",
    );
}

#[sqlx::test]
async fn restoration_waits_for_the_observation_then_an_old_group_head_is_rejected(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "roster-restore-owner").await;
    let room = room(&app, &owner, None).await;
    let scope = owner.scope(&room);
    let group = owner.group(&scope);
    let (_, input) = signed(&app, &owner, Prepared::from_group(&group, &owner, scope)).await;
    delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    let response = delivery::observe_roster(&app, &owner.actor, &room.id)
        .await
        .unwrap();
    let restore = tokio::spawn({
        let pool = app.pool.clone();
        async move {
            sqlx::query("UPDATE instance SET data_epoch=$1 WHERE singleton")
                .bind(auth::random_token())
                .execute(&pool)
                .await
        }
    });
    wait_for_lock(&app.pool).await;
    assert!(!restore.is_finished());
    let _: wire::GroupRoster = body(response).await;
    tokio::time::timeout(Duration::from_secs(3), restore)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    rejected(
        delivery::observe_roster(&app, &owner.actor, &room.id).await,
        "crypto_group_changed",
    );
}
