// Run the standalone host's coverage assertion through the root test harness too.
include!("api-consumer/src/event_kinds/probe.rs");

#[test]
fn event_kind_host_dispositions_cover_all_kinds() {
    main();
}
