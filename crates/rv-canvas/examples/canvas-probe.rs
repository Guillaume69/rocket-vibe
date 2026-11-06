//! Offline half of a live check: `read <load.b64>` prints the canvas's markdown,
//! `plan <load.b64> <edited.md> <session> <suffix>` prints the `data_binary` a save sends.
use base64::Engine;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let b64 = base64::engine::general_purpose::STANDARD;
    let load = b64.decode(std::fs::read_to_string(&args[2]).unwrap().trim()).unwrap();
    let canvas = rv_canvas::Canvas::from_load_data(&load).unwrap();
    match args[1].as_str() {
        "read" => {
            eprintln!(
                "thread {} document {} version {} sections {}",
                canvas.thread,
                canvas.document,
                canvas.version,
                canvas.sections.len()
            );
            print!("{}", rv_canvas::to_markdown(&canvas));
        }
        "plan" => {
            let md = std::fs::read_to_string(&args[3]).unwrap();
            let session = rv_canvas::Session { id: args[4].clone(), suffix: args[5].clone(), now_secs: chrono_now() };
            let edit = rv_canvas::plan(&canvas, &md, &session);
            eprintln!("changed {}", edit.changed);
            println!("{}", b64.encode(edit.data));
        }
        "blocks" => {
            for s in &canvas.sections {
                eprintln!(
                    "{} pos={:?} kind={} style={} parent={:?} deleted={} text={:?}",
                    &s.id[s.id.len() - 8..],
                    s.position,
                    s.kind,
                    s.style,
                    s.parent.as_deref().map(|p| &p[p.len() - 8..]),
                    s.deleted,
                    s.text
                );
            }
        }
        _ => panic!("read, blocks or plan"),
    }
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}
