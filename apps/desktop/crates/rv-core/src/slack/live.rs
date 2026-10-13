//! The live feed of a Slack account, in the events of `mattermost::socket`.
//! There is no RTM socket yet: opening only asks for a catch-up, the way a
//! reconnection does.

use tokio::sync::mpsc;

use crate::ddp::State;
use crate::mattermost::socket::LiveEvent;

enum Command {
    Open,
    Close,
}

#[derive(Clone)]
pub struct LiveHandle {
    commands: mpsc::UnboundedSender<Command>,
}

impl LiveHandle {
    pub fn open(&self) {
        let _ = self.commands.send(Command::Open);
    }

    pub fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }
}

pub fn spawn() -> (LiveHandle, mpsc::UnboundedReceiver<LiveEvent>) {
    let (commands, mut rx) = mpsc::unbounded_channel();
    let (events, events_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(command) = rx.recv().await {
            let sent = match command {
                Command::Open => events
                    .send(LiveEvent::State(State::Authenticated))
                    .and_then(|()| events.send(LiveEvent::Authenticated)),
                Command::Close => events.send(LiveEvent::State(State::Closed)),
            };
            if sent.is_err() {
                return;
            }
        }
    });
    (LiveHandle { commands }, events_rx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opening_asks_for_a_catch_up_and_closing_goes_offline() {
        let (live, mut events) = spawn();
        live.open();
        assert_eq!(events.recv().await, Some(LiveEvent::State(State::Authenticated)));
        assert_eq!(events.recv().await, Some(LiveEvent::Authenticated));
        live.close();
        assert_eq!(events.recv().await, Some(LiveEvent::State(State::Closed)));
    }
}
