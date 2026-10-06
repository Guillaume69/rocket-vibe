use rv_protocol::link_previews::*;
fn preview() -> LinkPreview {
    LinkPreview {
        url: "https://example.com/page".into(),
        kind: PreviewKind::Page,
        title: Some("Title".into()),
        description: None,
        site: None,
        image: Some(PreviewImage {
            file_id: "1".repeat(64),
            sha256: "2".repeat(64),
            bytes: "1024".into(),
            width: 1200,
            height: 600,
            media_type: "image/png".into(),
        }),
    }
}
#[test]
fn validates_bounds_and_immutable_image_contract() {
    assert!(validate(&[preview()]));
    assert!(!validate(&[preview(), preview()]));
    for mutate in [
        |p: &mut LinkPreview| p.url = "https://user:secret@example.com/".into(),
        |p: &mut LinkPreview| p.url = "https:///".into(),
        |p: &mut LinkPreview| p.title = Some("x".repeat(513)),
        |p: &mut LinkPreview| p.image.as_mut().unwrap().bytes = "01024".into(),
        |p: &mut LinkPreview| p.image.as_mut().unwrap().width = 1201,
        |p: &mut LinkPreview| p.image.as_mut().unwrap().media_type = "image/svg+xml".into(),
        |p: &mut LinkPreview| p.image.as_mut().unwrap().file_id = "../other".into(),
    ] {
        let mut p = preview();
        mutate(&mut p);
        assert!(!validate(&[p]));
    }
}
