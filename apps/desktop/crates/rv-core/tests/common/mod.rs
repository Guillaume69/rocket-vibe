#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub target: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Request {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Response {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
    /// Close the connection without answering: a network failure for the client.
    pub drop: bool,
}

pub fn respond(status: u16, body: &str) -> Response {
    Response { status, body: body.to_owned(), ..Default::default() }
}

pub fn dropped() -> Response {
    Response { drop: true, ..Default::default() }
}

type Handler = Box<dyn Fn(&Request) -> Response + Send + Sync>;

/// Raw HTTP/1.1 server: one canned response per request, from `handler`.
pub struct FakeHttp {
    pub url: url::Url,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl FakeHttp {
    pub async fn start(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> FakeHttp {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap()).parse().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(Box::new(handler));
        let log = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let handler = handler.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    loop {
                        let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                            let mut chunk = [0u8; 4096];
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                            }
                            continue;
                        };
                        let head = String::from_utf8_lossy(&buffer[..end]).to_string();
                        let mut lines = head.split("\r\n");
                        let mut first = lines.next().unwrap_or_default().split(' ');
                        let (method, target) = (first.next().unwrap_or_default(), first.next().unwrap_or_default());
                        let headers: HashMap<String, String> = lines
                            .filter_map(|l| l.split_once(':'))
                            .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
                            .collect();
                        let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                        while buffer.len() < end + 4 + length {
                            let mut chunk = [0u8; 4096];
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                            }
                        }
                        let body = String::from_utf8_lossy(&buffer[end + 4..end + 4 + length]).to_string();
                        buffer.drain(..end + 4 + length);
                        let request = Request { method: method.to_owned(), target: target.to_owned(), headers, body };
                        log.lock().unwrap().push(request.clone());
                        let response = handler(&request);
                        if response.drop {
                            return;
                        }
                        let mut out = format!(
                            "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
                            response.status,
                            response.body.len()
                        );
                        for (k, v) in &response.headers {
                            out.push_str(&format!("{k}: {v}\r\n"));
                        }
                        out.push_str("\r\n");
                        out.push_str(&response.body);
                        if socket.write_all(out.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        FakeHttp { url, requests }
    }

    /// Answers the queued responses in order, then 200 `{}`.
    pub async fn queue(responses: Vec<Response>) -> FakeHttp {
        let queue = Mutex::new(std::collections::VecDeque::from(responses));
        FakeHttp::start(move |_| queue.lock().unwrap().pop_front().unwrap_or_else(|| respond(200, "{}"))).await
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}
