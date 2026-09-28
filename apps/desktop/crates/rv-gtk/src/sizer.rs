//! An empty widget `width` × `height` when there is room, narrower in a narrow
//! window with its height following. List rows get their minimum height, so
//! the height it asks for at a given width is a minimum, not only a natural size.

use std::cell::Cell;

use gtk::glib;
use gtk::subclass::prelude::*;

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct Sizer {
        pub width: Cell<i32>,
        pub height: Cell<i32>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Sizer {
        const NAME: &'static str = "RvSizer";
        type Type = super::Sizer;
        type ParentType = gtk::Widget;
    }

    impl ObjectImpl for Sizer {}

    impl WidgetImpl for Sizer {
        fn request_mode(&self) -> gtk::SizeRequestMode {
            gtk::SizeRequestMode::HeightForWidth
        }

        fn measure(&self, orientation: gtk::Orientation, for_size: i32) -> (i32, i32, i32, i32) {
            let (w, h) = (self.width.get().max(1), self.height.get());
            match orientation {
                gtk::Orientation::Horizontal => (0, w, -1, -1),
                _ if for_size < 0 => (0, h, -1, -1),
                _ => {
                    let fitted = (h as i64 * for_size.min(w) as i64 / w as i64) as i32;
                    (fitted, fitted, -1, -1)
                }
            }
        }
    }
}

glib::wrapper! {
    pub struct Sizer(ObjectSubclass<imp::Sizer>) @extends gtk::Widget,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Sizer {
    pub fn new(width: i32, height: i32) -> Self {
        let this: Self = glib::Object::new();
        this.imp().width.set(width);
        this.imp().height.set(height);
        this
    }
}
