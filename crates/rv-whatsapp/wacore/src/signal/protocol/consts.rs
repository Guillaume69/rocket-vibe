/// How far a message may run ahead of its chain, as `rv-signal` accepts it.
pub const MAX_FORWARD_JUMPS: usize = 2000;
/// How far a recovery may move a sending chain to honour its lease: no
/// further than a receiver will follow.
pub const MAX_RESERVATION_FAST_FORWARD: u32 = MAX_FORWARD_JUMPS as u32;
/// Counters reserved at a time.
pub const SENDER_CHAIN_RESERVATION_BATCH: u32 = 64;
