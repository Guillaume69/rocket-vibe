//! A small namespace-aware XML tree for XMPP over WebSocket (RFC 7395), where
//! every frame is one whole element: parsed from a frame, built and written
//! back as one.

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Element(Element),
    Text(String),
}

/// An element: its local name, its resolved namespace, its attributes other
/// than namespace declarations, and its children.
#[derive(Debug, Clone, PartialEq)]
pub struct Element {
    pub name: String,
    pub ns: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

impl Element {
    pub fn new(name: &str, ns: &str) -> Self {
        Element { name: name.to_owned(), ns: ns.to_owned(), attrs: Vec::new(), children: Vec::new() }
    }

    pub fn attr(mut self, name: &str, value: impl Into<String>) -> Self {
        self.set_attr(name, value);
        self
    }

    pub fn set_attr(&mut self, name: &str, value: impl Into<String>) {
        let value = value.into();
        match self.attrs.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = value,
            None => self.attrs.push((name.to_owned(), value)),
        }
    }

    pub fn child(mut self, child: Element) -> Self {
        self.children.push(Node::Element(child));
        self
    }

    pub fn push(&mut self, child: Element) {
        self.children.push(Node::Element(child));
    }

    pub fn text(mut self, text: impl Into<String>) -> Self {
        self.children.push(Node::Text(text.into()));
        self
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    pub fn is(&self, name: &str, ns: &str) -> bool {
        self.name == name && self.ns == ns
    }

    pub fn elements(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(|n| match n {
            Node::Element(e) => Some(e),
            Node::Text(_) => None,
        })
    }

    pub fn find(&self, name: &str, ns: &str) -> Option<&Element> {
        self.elements().find(|e| e.is(name, ns))
    }

    pub fn find_all<'a>(&'a self, name: &'a str, ns: &'a str) -> impl Iterator<Item = &'a Element> {
        self.elements().filter(move |e| e.is(name, ns))
    }

    /// The text directly inside, children's excluded.
    pub fn content(&self) -> String {
        self.children
            .iter()
            .filter_map(|n| match n {
                Node::Text(t) => Some(t.as_str()),
                Node::Element(_) => None,
            })
            .collect()
    }

    /// One frame's bytes; `xmlns` is written wherever the namespace changes.
    pub fn write(&self) -> String {
        let mut out = String::new();
        self.write_into(&mut out, "");
        out
    }

    fn write_into(&self, out: &mut String, parent_ns: &str) {
        out.push('<');
        out.push_str(&self.name);
        if self.ns != parent_ns {
            out.push_str(" xmlns=\"");
            escape(out, &self.ns);
            out.push('"');
        }
        for (name, value) in &self.attrs {
            out.push(' ');
            out.push_str(name);
            out.push_str("=\"");
            escape(out, value);
            out.push('"');
        }
        if self.children.is_empty() {
            out.push_str("/>");
            return;
        }
        out.push('>');
        for child in &self.children {
            match child {
                Node::Element(e) => e.write_into(out, &self.ns),
                Node::Text(t) => escape(out, t),
            }
        }
        out.push_str("</");
        out.push_str(&self.name);
        out.push('>');
    }

    /// Parses one frame. A frame holding several top-level elements gives the first.
    pub fn parse(frame: &str) -> Option<Element> {
        let mut reader = Reader::from_str(frame);
        // Each open element and the namespace prefixes it declared.
        let mut stack: Vec<(Element, Vec<(String, String)>)> = Vec::new();
        let mut scopes: Vec<Vec<(String, String)>> = Vec::new();
        loop {
            match reader.read_event().ok()? {
                Event::Start(start) => {
                    let (element, declared) = open(&start, &scopes)?;
                    scopes.push(declared.clone());
                    stack.push((element, declared));
                }
                Event::Empty(start) => {
                    let (element, _) = open(&start, &scopes)?;
                    match stack.last_mut() {
                        Some((parent, _)) => parent.children.push(Node::Element(element)),
                        None => return Some(element),
                    }
                }
                Event::End(_) => {
                    let (element, _) = stack.pop()?;
                    scopes.pop();
                    match stack.last_mut() {
                        Some((parent, _)) => parent.children.push(Node::Element(element)),
                        None => return Some(element),
                    }
                }
                Event::Text(text) => {
                    if let Some((parent, _)) = stack.last_mut() {
                        let text = text.decode().ok()?;
                        let text = quick_xml::escape::unescape(&text).ok()?.into_owned();
                        push_text(parent, text);
                    }
                }
                Event::GeneralRef(reference) => {
                    if let Some((parent, _)) = stack.last_mut() {
                        let name = reference.decode().ok()?;
                        let text = quick_xml::escape::unescape(&format!("&{name};")).ok()?.into_owned();
                        push_text(parent, text);
                    }
                }
                Event::CData(data) => {
                    if let Some((parent, _)) = stack.last_mut() {
                        push_text(parent, String::from_utf8_lossy(&data).into_owned());
                    }
                }
                Event::Eof => return None,
                _ => {}
            }
        }
    }
}

/// Text joins the text right before it: entity references arrive apart.
fn push_text(parent: &mut Element, text: String) {
    if let Some(Node::Text(last)) = parent.children.last_mut() {
        last.push_str(&text);
    } else {
        parent.children.push(Node::Text(text));
    }
}

/// The element a start tag opens, and the prefixes (`""` the default) it declares.
fn open(start: &BytesStart, scopes: &[Vec<(String, String)>]) -> Option<(Element, Vec<(String, String)>)> {
    let qname = String::from_utf8(start.name().as_ref().to_vec()).ok()?;
    let mut declared = Vec::new();
    let mut attrs = Vec::new();
    for attr in start.attributes() {
        let attr = attr.ok()?;
        let key = String::from_utf8(attr.key.as_ref().to_vec()).ok()?;
        let value = attr.unescape_value().ok()?.into_owned();
        if key == "xmlns" {
            declared.push((String::new(), value));
        } else if let Some(prefix) = key.strip_prefix("xmlns:") {
            declared.push((prefix.to_owned(), value));
        } else {
            attrs.push((key, value));
        }
    }
    let (prefix, name) = match qname.split_once(':') {
        Some((p, n)) => (p.to_owned(), n.to_owned()),
        None => (String::new(), qname),
    };
    let ns = declared
        .iter()
        .chain(scopes.iter().rev().flatten())
        .find(|(p, _)| *p == prefix)
        .map(|(_, ns)| ns.clone())
        .unwrap_or_default();
    Some((Element { name, ns, attrs, children: Vec::new() }, declared))
}

fn escape(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_and_defaults_resolve_to_namespaces() {
        let frame = "<stream:features xmlns:stream='http://etherx.jabber.org/streams' xmlns='jabber:client'>\
            <mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>ANONYMOUS</mechanism></mechanisms>\
            <bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>";
        let e = Element::parse(frame).unwrap();
        assert!(e.is("features", "http://etherx.jabber.org/streams"));
        let mechanisms = e.find("mechanisms", "urn:ietf:params:xml:ns:xmpp-sasl").unwrap();
        assert_eq!(mechanisms.find("mechanism", "urn:ietf:params:xml:ns:xmpp-sasl").unwrap().content(), "ANONYMOUS");
        assert!(e.find("bind", "urn:ietf:params:xml:ns:xmpp-bind").is_some());
    }

    #[test]
    fn written_frames_parse_back_with_escaping() {
        let iq = Element::new("iq", "jabber:client")
            .attr("type", "set")
            .attr("id", "a&b")
            .child(Element::new("nick", "http://jabber.org/protocol/nick").text("Ana <Ü>"));
        let back = Element::parse(&iq.write()).unwrap();
        assert_eq!(back, iq);
        assert!(iq.write().starts_with("<iq xmlns=\"jabber:client\" type=\"set\" id=\"a&amp;b\">"));
    }
}
