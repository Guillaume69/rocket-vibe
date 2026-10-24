fn main() {
    // A function ITEM is zero-sized. Retain a real pointer so the linker keeps
    // the send/edit future's poll/drop graph, without contacting WhatsApp.
    let keep: for<'a> fn(
        &'a whatsapp_rust::Client,
        &'a whatsapp_rust::Jid,
    ) -> api_consumer::requests::BoxedSend<'a> = api_consumer::requests::boxed;
    std::hint::black_box(keep);
}
