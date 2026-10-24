use whatsapp_rust::voip::CallEvent;

pub fn legacy(event: &CallEvent) {
    if let CallEvent::VideoStateChanged { .. } = event {}
}
