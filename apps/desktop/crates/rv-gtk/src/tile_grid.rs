//! The voice page's people: tiles that share all the room the grid has, as
//! large as they can be at 16:9, the last row centred. Never scrolls; a tile
//! never gets less than its content's minimum (the grid then clips).

use gtk::glib;
use gtk::prelude::*;
use gtk::subclass::prelude::*;

const GAP: i32 = 12;

/// Columns, then a tile's width and height, for `count` tiles in `width` by
/// `height`: the column count whose 16:9 tiles come out largest.
pub fn arrange(count: usize, width: i32, height: i32) -> (usize, i32, i32) {
    let mut best = (1, 0, 0);
    for columns in 1..=count.max(1) {
        let rows = count.max(1).div_ceil(columns) as i32;
        let cell_w = (width - GAP * (columns as i32 - 1)) / columns as i32;
        let cell_h = (height - GAP * (rows - 1)) / rows;
        let w = cell_w.min(cell_h * 16 / 9).max(0);
        if w > best.1 {
            best = (columns, w, w * 9 / 16);
        }
    }
    best
}

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct TileGrid;

    #[glib::object_subclass]
    impl ObjectSubclass for TileGrid {
        const NAME: &'static str = "RvTileGrid";
        type Type = super::TileGrid;
        type ParentType = gtk::Widget;
    }

    impl ObjectImpl for TileGrid {
        fn dispose(&self) {
            while let Some(child) = self.obj().first_child() {
                child.unparent();
            }
        }
    }

    impl WidgetImpl for TileGrid {
        /// One tile's minimum: the grid shrinks down to a single tile.
        fn measure(&self, orientation: gtk::Orientation, _for_size: i32) -> (i32, i32, i32, i32) {
            let minimum = self.obj().tiles().iter().map(|c| c.measure(orientation, -1).0).max().unwrap_or(0);
            (minimum, minimum, -1, -1)
        }

        fn size_allocate(&self, width: i32, height: i32, _baseline: i32) {
            let tiles = self.obj().tiles();
            let count = tiles.len();
            if count == 0 {
                return;
            }
            let (columns, w, h) = arrange(count, width, height);
            let rows = count.div_ceil(columns);
            let top = (height - (rows as i32 * (h + GAP) - GAP)) / 2;
            for (index, tile) in tiles.iter().enumerate() {
                let (row, column) = (index / columns, index % columns);
                let in_row = if row == rows - 1 { count - row * columns } else { columns } as i32;
                let left = (width - (in_row * (w + GAP) - GAP)) / 2;
                let min_w = tile.measure(gtk::Orientation::Horizontal, -1).0;
                let min_h = tile.measure(gtk::Orientation::Vertical, w.max(min_w)).0;
                let at = gtk::Allocation::new(
                    left + column as i32 * (w + GAP),
                    top.max(0) + row as i32 * (h + GAP),
                    w.max(min_w),
                    h.max(min_h),
                );
                tile.size_allocate(&at, -1);
            }
        }
    }
}

glib::wrapper! {
    pub struct TileGrid(ObjectSubclass<imp::TileGrid>) @extends gtk::Widget,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget;
}

impl Default for TileGrid {
    fn default() -> Self {
        Self::new()
    }
}

impl TileGrid {
    pub fn new() -> Self {
        let this: Self = glib::Object::new();
        this.set_overflow(gtk::Overflow::Hidden);
        this.set_hexpand(true);
        this.set_vexpand(true);
        this
    }

    pub fn append(&self, tile: &impl IsA<gtk::Widget>) {
        tile.set_parent(self);
    }

    pub fn remove_all(&self) {
        while let Some(child) = self.first_child() {
            child.unparent();
        }
    }

    fn tiles(&self) -> Vec<gtk::Widget> {
        std::iter::successors(self.first_child(), |c| c.next_sibling()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::arrange;

    #[test]
    fn tiles_take_the_largest_arrangement() {
        // One person: the whole width at 16:9.
        assert_eq!(arrange(1, 1600, 900), (1, 1600, 900));
        // Two in a wide room: side by side.
        assert_eq!(arrange(2, 1600, 900).0, 2);
        // Two in a tall room: stacked.
        assert_eq!(arrange(2, 600, 1000).0, 1);
        // Four in a 16:9 room: two by two.
        assert_eq!(arrange(4, 1600, 900).0, 2);
        // Five: three, then two centred.
        assert_eq!(arrange(5, 1600, 900).0, 3);
        assert_eq!(arrange(0, 100, 100).0, 1);
    }
}
