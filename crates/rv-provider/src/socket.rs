//! What every provider's live connection shares: its states and events, the
//! websocket halves, and JSON text frames in and out.

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Closed,
    Connecting,
    Connected,
    Authenticated,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LiveEvent {
    State(State),
    Authenticated,
    /// The connection dropped without `close()` being asked.
    Lost,
    Event {
        name: String,
        data: Value,
        broadcast: Value,
    },
}

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub type Sink = SplitSink<Socket, WsMessage>;
pub type Stream = SplitStream<Socket>;

pub async fn send(sink: &mut Sink, message: &Value) -> bool {
    sink.send(WsMessage::text(message.to_string())).await.is_ok()
}

/// The next text frame as JSON, or None when the socket ends.
pub async fn next_json(stream: &mut Stream) -> Option<Value> {
    while let Some(frame) = stream.next().await {
        match frame.ok()? {
            WsMessage::Text(text) => match serde_json::from_str(text.as_str()) {
                Ok(v) => return Some(v),
                Err(_) => continue,
            },
            WsMessage::Close(_) => return None,
            _ => continue,
        }
    }
    None
}
