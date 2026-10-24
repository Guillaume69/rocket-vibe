//! The engine's Signal layer, on `rv-signal`: the addresses and stores its
//! sessions and sender keys are kept under, the records as it stores them
//! (WhatsApp's protobuf structures, a session's counter lease, a sender
//! key's wire gate), sessions checked out of the write-back cache, and the
//! encrypt and decrypt functions that run `rv-signal` over them.

pub mod protocol;
pub mod store;
