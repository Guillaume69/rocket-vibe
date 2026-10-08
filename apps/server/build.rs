use std::{env, fs, path::Path};
fn collect(path: &Path, root: &Path, entries: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(path).expect("read web assets") {
        let path = entry.expect("web asset").path();
        if path.is_dir() {
            collect(&path, root, entries);
        } else {
            let name = path
                .strip_prefix(root)
                .expect("relative web path")
                .to_string_lossy()
                .replace('\\', "/");
            entries.push((
                format!("/{name}"),
                path.canonicalize()
                    .expect("web asset path")
                    .to_string_lossy()
                    .into_owned(),
            ));
        }
    }
}
fn main() {
    let root = Path::new("../../apps/web/dist");
    println!("cargo:rerun-if-changed=../../apps/web/dist");
    assert!(
        root.join("index.html").is_file(),
        "Build the web client first: cd apps/web && npm ci && npm run build"
    );
    let mut entries = Vec::new();
    collect(root, root, &mut entries);
    entries.sort();
    let mut output = String::from("const ASSETS: &[(&str, &[u8])] = &[\n");
    for (name, path) in entries {
        output.push_str(&format!("({name:?}, include_bytes!({path:?})),\n"));
    }
    output.push_str("];\n");
    fs::write(
        Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("web-assets.rs"),
        output,
    )
    .expect("write web asset table");
}
